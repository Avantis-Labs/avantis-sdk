/**
 * Execution engine: routes signed actions to the chain.
 *
 * Routes:
 * - `batched-market`       market opens/closes/increases: signed EIP-712
 *                          intent + optionally a pre-signed EIP-7702 type-4
 *                          tx (server-side strategy switch when both are
 *                          sent; intent-only is the MM fast path) -> POST
 *                          {batched-market}/market/execute-batched,
 *                          lifecycle streamed back as SSE
 * - `relayer-passthrough`  calldata wrapped in a type-4 smart-account tx
 *                          -> blitz POST /relays (type 4)
 * - `rpc`                  normal signed transaction via the user's RPC
 * - `wallet`               transaction sent through the user's WalletClient
 *                          (browser wallets that cannot sign EIP-7702
 *                          authorizations fall back here)
 * - `txbuilder-relay`      pre-signed raw tx via POST {tx-builder}/v2/relay
 *
 * Global TP/SL updates (UpdateTpSlReq) do not pass through here: they are
 * signed intents submitted to the core API price-triggers endpoint (see
 * `TradeApi.updateTpSl`), which executes the operator entry point itself.
 */

import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import { DEFAULT_DELEGATION_ADDRESS, type VerantaConfig } from "../config.js";
import { type Call, GelatoDelegationEncoder, freshNonce } from "../eip7702/account.js";
import { ConfigError, RelayError } from "../errors.js";
import { signIntent } from "../signing/intents.js";
import type { VerantaSigner } from "../signing/signer.js";
import type { HttpTransport } from "../transport.js";
import type { TxBuilderClient } from "../txbuilder.js";
import {
  type AggregatorOrderType,
  BATCHED_MARKET_INTENT_KINDS,
  BATCHED_MARKET_ORDER_TYPES,
  type CallData,
  type ExecutionReceipt,
  type IntentPayload,
  callDataValueWei,
} from "../types.js";
import { BatchedMarketClient, type BatchedMarketEventHook } from "./batchedMarket.js";
import { RelayerClient } from "./relayer.js";
import { JsonRpcClient } from "./rpc.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExecutionEngine {
  readonly relayer: RelayerClient;
  readonly batchedMarket: BatchedMarketClient;
  readonly rpc: JsonRpcClient | null;

  private chainIdCache: number | null = null;
  private tradingRouterCache: Address | null = null;
  private addressesCache: Record<string, string> | null = null;
  private encoderCache: GelatoDelegationEncoder | null = null;

  constructor(
    readonly config: VerantaConfig,
    readonly signer: VerantaSigner | undefined,
    transport: HttpTransport,
    readonly txb: TxBuilderClient,
  ) {
    this.relayer = new RelayerClient(transport, config.relayerUrl, {
      pollIntervalMs: config.relayPollIntervalMs,
      pollTimeoutMs: config.relayPollTimeoutMs,
    });
    this.batchedMarket = new BatchedMarketClient(transport, config.batchedMarketUrl, {
      pollIntervalMs: config.relayPollIntervalMs,
      timeoutMs: config.relayPollTimeoutMs,
    });
    this.rpc = config.rpcUrl ? new JsonRpcClient(config.rpcUrl, config.timeoutMs) : null;
  }

  // ------------------------------------------------------------------ utils

  requireSigner(): VerantaSigner {
    if (!this.signer) {
      throw new ConfigError(
        "This operation requires a signer (pass `signer` or set VERANTA_PRIVATE_KEY).",
      );
    }
    return this.signer;
  }

  /** Chain id from /v2/meta (cached; never hard-coded). */
  async chainId(): Promise<number> {
    if (this.chainIdCache === null) {
      const meta = await this.txb.meta();
      this.chainIdCache = Number(meta.chainId);
      this.addressesCache = { ...meta.addresses } as Record<string, string>;
      this.tradingRouterCache = meta.addresses.tradingRouter as Address;
    }
    return this.chainIdCache;
  }

  async tradingRouter(): Promise<Address> {
    if (this.tradingRouterCache === null) await this.chainId();
    return this.tradingRouterCache!;
  }

  /** Contract addresses from /v2/meta (cached). */
  async addresses(): Promise<Record<string, string>> {
    if (this.addressesCache === null) await this.chainId();
    return this.addressesCache!;
  }

  /**
   * The EIP-7702 template the authorization targets.
   *
   * Builder-fee charging only works when the account code points at the
   * canonical fee-charging template (BuilderCode's `approvedTemplates`), so
   * when a builder code is configured and `delegationAddress` was left at
   * its default, resolve the canonical template from /v2/meta. An explicit
   * override always wins.
   */
  private async delegationAddress(): Promise<Address> {
    const configured = this.config.delegationAddress;
    if (this.config.builderCode && configured === DEFAULT_DELEGATION_ADDRESS) {
      const template = (await this.addresses()).delegationTemplate;
      if (template) return template as Address;
    }
    return configured;
  }

  async encoder(): Promise<GelatoDelegationEncoder> {
    if (this.encoderCache === null) {
      this.encoderCache = new GelatoDelegationEncoder(
        this.requireSigner(),
        await this.chainId(),
        await this.delegationAddress(),
      );
    }
    return this.encoderCache;
  }

  /**
   * EOA protocol nonce the EIP-7702 authorization is signed over.
   *
   * A wrong nonce makes the authorization invalid, so the protocol skips it
   * silently: fine once the Gelato delegation code is already set (the
   * authorization is redundant), but the first application (or replacing a
   * foreign delegation, e.g. a MetaMask-upgraded EOA) never happens and
   * every smart-account call reverts.
   *
   * Delegate/API keys (the normal setup: register the delegate in the UI or
   * with `useSessionKey`, export its key) are fresh EOAs, so nonce 0 is
   * correct and no RPC is needed. Signing with the trader EOA directly is
   * the power path: its nonce is almost never 0, so an RPC (any Base
   * endpoint) is required to read it.
   */
  private async authorizationNonce(signerAddress: Address): Promise<number> {
    if (this.rpc !== null) {
      return await this.rpc.getTransactionCount(signerAddress);
    }
    const trader = this.config.trader;
    if (trader && trader.toLowerCase() !== signerAddress.toLowerCase()) {
      return 0; // delegate/API key: fresh EOA, nothing to read
    }
    throw new ConfigError(
      "Relayer mode with the trader EOA needs an RPC to read the EIP-7702 " +
        "authorization nonce (a stale nonce is skipped on-chain and the " +
        "transaction reverts). Set rpcUrl / VERANTA_RPC_URL to any Base RPC " +
        "(e.g. https://mainnet.base.org), or sign with a delegate/API key.",
    );
  }

  private async estimateGasOrDefault(to: string, data: string, value = 0n): Promise<number> {
    if (this.rpc !== null) {
      try {
        const estimated = await this.rpc.estimateGas({
          to,
          data,
          value: `0x${value.toString(16)}`,
        });
        return Math.max(this.config.defaultGasLimit, estimated);
      } catch {
        // fall through to default
      }
    }
    return this.config.defaultGasLimit;
  }

  private async buildType4(calls: Call[]): Promise<Record<string, any>> {
    const signer = this.requireSigner();
    const encoder = await this.encoder();
    const accountNonce = await this.authorizationNonce(signer.address);
    // Encode once with a pinned exec nonce, estimate gas on those exact
    // bytes, and reuse the same nonce in the final payload.
    const execNonce = freshNonce();
    const data = await encoder.encodeCallData(calls, execNonce);
    const gas = await this.estimateGasOrDefault(signer.address, data);
    // The UI attaches the authorization on every tx (idempotent once the
    // delegation code is set); mirror that for maximum compatibility.
    return await encoder.buildType4(calls, { gas, accountNonce, execNonce });
  }

  // -------------------------------------------------------------- relayer

  /**
   * Sign a market intent and execute it through the batched-market API.
   *
   * Market opens/closes/increases (the batched-market allow-list) go to
   * `POST {batched-market}/market/execute-batched`, which injects a fresh
   * price/spread per attempt server-side and streams the lifecycle back.
   * The EIP-7702 leg is optional: pass the direct-route `calldata` to also
   * send a pre-signed EIP-7702 transaction (the server then picks the
   * execution mechanism); omit it to execute the signed intent directly
   * (the market-maker fast path, with no tx-builder round-trip). When the
   * signer cannot produce EIP-7702 authorizations (browser wallets), the
   * intent-only path is used automatically.
   */
  async submitIntentBatch(
    payload: IntentPayload,
    orderType: AggregatorOrderType,
    options: {
      calldata?: CallData;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    } = {},
  ): Promise<ExecutionReceipt> {
    const signer = this.requireSigner();
    if (
      !BATCHED_MARKET_INTENT_KINDS.has(payload.primaryType) ||
      !BATCHED_MARKET_ORDER_TYPES.has(orderType)
    ) {
      throw new ConfigError(
        `${payload.primaryType} (order type ${orderType}) is not a batched-market ` +
          "intent. TWAP goes through trade.twap* (twap-app intents); TP/SL through " +
          "trade.updateTpSl / trade.partialTpSl (core-API price-triggers).",
      );
    }
    const signed = await signIntent(payload, signer);

    let eip7702: Record<string, unknown> | undefined;
    if (options.calldata && signer.canSignAuthorization) {
      const calls: Call[] = [
        {
          to: options.calldata.to,
          data: options.calldata.data,
          value: callDataValueWei(options.calldata),
        },
      ];
      const txParams = await this.buildType4(calls);
      eip7702 = relayRequestParams(txParams);
    }
    const outcome = await this.batchedMarket.execute(
      orderType,
      { userIntent: payload.encodedIntent, userSignature: signed.signature },
      eip7702,
      { wait: options.wait ?? true, onEvent: options.onEvent },
    );
    return {
      route: "batched-market",
      trackingId: outcome.trackingId || undefined,
      txHash: outcome.txHash,
      orderId: outcome.orderId,
      description: payload.intent,
      raw: outcome.terminal?.data,
    };
  }

  /**
   * Relay arbitrary calldata gaslessly via a type-4 smart-account tx.
   *
   * When the signer cannot sign EIP-7702 authorizations (browser wallets),
   * falls back to sending the calldata as a normal transaction through the
   * wallet (route `wallet`) — same on-chain effect, gas paid by the user.
   */
  async submitPassthrough(
    calldata: CallData,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const signer = this.requireSigner();
    if (!signer.canSignAuthorization) {
      if (signer.canSendTransaction) return await this.submitWallet(calldata, options);
      throw new ConfigError(
        "This operation needs an EIP-7702-capable signer (local/session key) or a " +
          "WalletClient that can send transactions.",
      );
    }
    const calls: Call[] = [
      { to: calldata.to, data: calldata.data, value: callDataValueWei(calldata) },
    ];
    const txParams = await this.buildType4(calls);
    const wallet = this.config.trader ?? signer.address;
    const requestId = await this.relayer.create(txParams, wallet);
    const receipt: ExecutionReceipt = {
      route: "relayer-passthrough",
      requestId,
      description: calldata.description,
    };
    if (options.wait ?? true) {
      const status = await this.relayer.wait(requestId);
      receipt.txHash = status.txHash;
      receipt.raw = status.receipt;
    }
    return receipt;
  }

  // -------------------------------------------------------------- direct

  /**
   * Send the calldata as a normal transaction.
   *
   * Local accounts sign an EIP-1559 tx and broadcast via the configured RPC.
   * WalletClient signers send through the wallet (it handles nonce/gas).
   */
  async submitDirect(
    calldata: CallData,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const signer = this.requireSigner();

    if (this.rpc !== null && !signer.canSendTransaction) {
      const nonce = await this.rpc.getTransactionCount(signer.address);
      const value = callDataValueWei(calldata);
      const gas = await this.estimateGasOrDefault(calldata.to, calldata.data, value);
      const [maxFeePerGas, maxPriorityFeePerGas] = await this.rpc.gasFees();
      const raw = await signer.signTransaction({
        type: "eip1559",
        chainId: await this.chainId(),
        to: calldata.to,
        data: calldata.data,
        value,
        nonce,
        gas: BigInt(gas),
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const txHash = keccak256(raw as Hex);
      await this.rpc.sendRawTransaction(raw);
      const receipt: ExecutionReceipt = {
        route: "rpc",
        txHash,
        description: calldata.description,
      };
      if (options.wait ?? true) {
        receipt.raw = await this.rpc.waitForReceipt(txHash);
      }
      return receipt;
    }

    if (signer.canSendTransaction) return await this.submitWallet(calldata, options);

    // No RPC: sign with static params and use the tx-builder raw relay.
    // Nonce must come from somewhere; the tx-builder relay simulates from
    // the recovered signer, so a wrong nonce fails fast with a clear error.
    throw new ConfigError(
      "Direct execution needs VERANTA_RPC_URL for nonce/gas discovery. " +
        "Alternatively use execution: 'relayer' (gasless, no RPC required).",
    );
  }

  /** Send the calldata through the user's wallet (browser path). */
  async submitWallet(
    calldata: CallData,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const signer = this.requireSigner();
    const txHash = await signer.sendTransaction({
      to: calldata.to,
      data: calldata.data,
      value: callDataValueWei(calldata),
    });
    const receipt: ExecutionReceipt = {
      route: "wallet",
      txHash,
      description: calldata.description,
    };
    if ((options.wait ?? true) && this.rpc !== null) {
      receipt.raw = await this.rpc.waitForReceipt(txHash);
    }
    return receipt;
  }

  /** Broadcast a pre-signed raw tx through POST {tx-builder}/v2/relay. */
  async submitViaTxBuilderRelay(
    rawTransaction: string,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const data = await this.txb.relayRaw(rawTransaction);
    const txHash: string | undefined = data?.hash;
    const receipt: ExecutionReceipt = { route: "txbuilder-relay", txHash, raw: data };
    if ((options.wait ?? true) && txHash) {
      for (let i = 0; i < 120; i++) {
        const status = await this.txb.relayStatus(txHash);
        if (status?.status === "confirmed") {
          receipt.raw = status;
          return receipt;
        }
        if (status?.status === "reverted") {
          throw new RelayError(`transaction ${txHash} reverted`, { requestId: txHash });
        }
        await sleep(1_000);
      }
    }
    return receipt;
  }

  // -------------------------------------------------------------- routing

  get isRelayerMode(): boolean {
    return this.config.execution === "relayer";
  }
}

/**
 * Blitz `txParams` -> batched-market `RelayRequestParamsDto`.
 *
 * The DTO wants chainId/gas/nonce as strings, `gas` instead of `gasLimit`,
 * and has no `value`/`transactionType` fields (type-4 is implied;
 * smart-account relays carry no ETH).
 */
export function relayRequestParams(txParams: Record<string, any>): Record<string, unknown> {
  return {
    chainId: String(txParams.chainId),
    to: txParams.to,
    data: txParams.data,
    gas: String(txParams.gasLimit),
    authorizationList: (txParams.authorizationList ?? []).map((auth: Record<string, any>) => ({
      address: auth.address,
      chainId: String(auth.chainId),
      nonce: String(auth.nonce),
      r: auth.r,
      s: auth.s,
      yParity: auth.yParity,
      v: String(auth.v),
    })),
  };
}
