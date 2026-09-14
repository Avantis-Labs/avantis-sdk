/** Account state: positions, orders, balances, allowance, delegation, onboarding. */

import type { Address, Hex } from "viem";
import { concatHex, encodeAbiParameters, keccak256, stringToBytes } from "viem";
import type { VerantaConfig } from "../config.js";
import { ConfigError, DelegationError } from "../errors.js";
import type { ExecutionEngine } from "../execution/engine.js";
import { signIntent } from "../signing/intents.js";
import type { VerantaSigner } from "../signing/signer.js";
import type { HttpTransport } from "../transport.js";
import type { TxBuilderClient, TxBuilderMeta } from "../txbuilder.js";
import type { CallData, ExecutionReceipt, Num } from "../types.js";
import { type UserData, toUserData } from "./accountModels.js";
import { ExecutingApi } from "./base.js";
import { type PairInfo, stripUpsideSuffix } from "./marketModels.js";

const SET_DELEGATE_WITH_SIG_SELECTOR = keccak256(
  stringToBytes("setDelegateWithSig(bytes,bytes)"),
).slice(0, 10) as Hex;

export class AccountApi extends ExecutingApi {
  constructor(
    cfg: VerantaConfig,
    engine: ExecutionEngine,
    txb: TxBuilderClient,
    transport: HttpTransport,
    private readonly getMeta: () => Promise<TxBuilderMeta>,
    private readonly getPairs: () => Promise<Map<number, PairInfo>>,
  ) {
    super(cfg, engine, txb, transport);
  }

  // ------------------------------------------------------------------ reads

  /**
   * Open positions + standing limit orders (core API, enriched with
   * liquidation price, rollover, and unrealized funding).
   *
   * Each position also gets `baseSymbol` from the markets pair catalog
   * (with any `_UPSIDE` suffix stripped; BTC_UPSIDE/USD tags as "BTC") so
   * `positionSizeInAsset` handles USD-base pairs (USD/JPY, ...) correctly.
   */
  async positions(trader?: Address): Promise<UserData> {
    const addr = trader ?? this.trader;
    const data = await this.transport.json("GET", `${this.cfg.coreApiUrl}/user-data`, {
      params: { trader: addr },
    });
    const userData = toUserData(data);
    if (userData.positions.length > 0) {
      const pairs = await this.getPairs();
      for (const position of userData.positions) {
        const info = pairs.get(position.pairIndex);
        if (info) position.baseSymbol = stripUpsideSuffix(info.from);
      }
    }
    return userData;
  }

  /** Positions via the tx-builder RPC read (raw bigint strings). */
  async positionsOnchain(trader?: Address): Promise<any> {
    return await this.txb.positions(trader ?? this.trader);
  }

  /**
   * TWAP orders with their per-slice trades (twap-app API; `page` is
   * 0-based).
   */
  async twaps(
    trader?: Address,
    options: { includeCanceled?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<any> {
    return await this.transport.json("GET", `${this.cfg.twapApiUrl}/twaps`, {
      params: {
        trader: trader ?? this.trader,
        includeCanceled: String(options.includeCanceled ?? false),
        pageNum: options.page ?? 0,
        pageSize: options.pageSize ?? 20,
      },
    });
  }

  /**
   * One TWAP by its on-chain `twapId` (twap-app API), or null when the id
   * is unknown (the API answers 404).
   */
  async twap(twapId: number | bigint): Promise<any | null> {
    return await this.transport.json("GET", `${this.cfg.twapApiUrl}/twaps/${twapId}`, {
      allow404: true,
    });
  }

  /** USDC allowance + balance (spender defaults to TradingStorage). */
  async allowance(spender?: Address): Promise<any> {
    return await this.txb.allowance(this.trader, spender);
  }

  /**
   * USDC wallet balance in human units.
   *
   * tx-builder /v2/allowance returns both raw strings (`balance`,
   * `allowance`) and human floats (`balanceUsdc`, `allowanceUsdc`); prefer
   * the exact raw value.
   */
  async usdcBalance(): Promise<number> {
    const data = await this.allowance();
    return Number(data?.balance ?? "0") / 1e6;
  }

  /** {isEnabled, expiry, canDelegatedAction, canSignIntents}. */
  async delegationStatus(delegate?: Address): Promise<any> {
    const d = delegate ?? this.engine.signer?.address;
    if (!d) throw new ConfigError("No delegate address to check.");
    return await this.txb.delegation(this.trader, d);
  }

  /** Fail fast if the configured delegate cannot act for the trader. */
  async verifyDelegation(): Promise<void> {
    const signer = this.engine.signer;
    if (!signer || !this.cfg.trader) return;
    if (signer.address.toLowerCase() === this.cfg.trader.toLowerCase()) return;
    const status = await this.delegationStatus(signer.address);
    const ok = this.engine.isRelayerMode ? status?.canSignIntents : status?.canDelegatedAction;
    if (!ok) {
      throw new DelegationError(
        `Delegate ${signer.address} is not authorized for trader ${this.cfg.trader} ` +
          `(status: ${JSON.stringify(status)}). Register the delegate on the Veranta ` +
          "UI or via registerDelegate().",
      );
    }
  }

  // ------------------------------------------------------------------ onboarding

  /**
   * Approve USDC for trading (TradingStorage) or LP (pass the tranche).
   *
   * The approval must come from the TRADER's own address; it cannot be
   * routed through a delegate key.
   */
  async approveUsdc(
    amount?: Num,
    options: { spender?: Address; wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    this.requireCallerIsSigner("USDC approve");
    const calldata = await this.txb.calldata("/v2/token/approve", {
      trader: this.trader,
      spender: options.spender,
      amountUsdc: amount,
    });
    return await this.route(calldata, options.wait ?? true);
  }

  /**
   * Approve USDC to the BuilderCode registry (the builder-fee allowance).
   *
   * Builder-fee onboarding needs TWO approvals, both to audited protocol
   * contracts: TradingStorage for collateral (approveUsdc) and the
   * BuilderCode registry for fees (this call). Never approve the builder's
   * 1CT/delegate wallet itself. Fees can only be pulled by the registry,
   * per order, within the code's public on-chain caps. Unlimited when
   * `amount` is omitted; trader key only.
   */
  async approveBuilderFees(
    amount?: Num,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const registry = (await this.engine.addresses()).builderCode;
    if (!registry) throw new ConfigError("tx-builder /v2/meta carries no builderCode address");
    return await this.approveUsdc(amount, {
      spender: registry as Address,
      wait: options.wait ?? true,
    });
  }

  /**
   * USDC allowance + balance with the BuilderCode registry as spender.
   *
   * Note: USDC allowances decrement as fees are charged (even "unlimited"
   * ones), so long-lived integrations should monitor and re-approve.
   */
  async builderFeeAllowance(): Promise<any> {
    const registry = (await this.engine.addresses()).builderCode;
    if (!registry) throw new ConfigError("tx-builder /v2/meta carries no builderCode address");
    return await this.allowance(registry as Address);
  }

  /**
   * Register a delegate gaslessly (trader signs a DelegateReq intent).
   *
   * `expirySeconds` is an ABSOLUTE unix timestamp in seconds (e.g.
   * `Math.floor(Date.now() / 1000) + 3600` for one hour), not a duration.
   *
   * The trader key/wallet is used transiently for one signature and not
   * stored. Submission of setDelegateWithSig is permissionless, so the
   * SDK's own signer relays it (TX_RELAY passthrough in relayer mode).
   */
  async registerDelegate(
    delegate: Address,
    expirySeconds: number,
    traderSigner: VerantaSigner,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const intent = await this.txb.intent("/v2/intents/delegate-set", {
      trader: this.trader,
      delegate,
      expirySeconds,
    });
    const signed = await signIntent(intent, traderSigner); // trader-only signer rule
    const meta = await this.getMeta();
    const router = meta.addresses.tradingRouter as Address;
    const data = concatHex([
      SET_DELEGATE_WITH_SIG_SELECTOR,
      encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }],
        [signed.signature, intent.encodedIntent],
      ),
    ]);
    const calldata: CallData = {
      to: router,
      from: this.engine.signer?.address ?? this.trader,
      data,
      value: "0x0",
      chainId: await this.engine.chainId(),
      description: `setDelegateWithSig(${delegate})`,
    };
    return await this.route(calldata, options.wait ?? true);
  }

  /** Remove a delegate (trader-signed; kills in-flight intents). */
  async revokeDelegate(
    delegate: Address,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    this.requireCallerIsSigner("removeDelegate");
    const calldata = await this.txb.calldata("/v2/delegate/remove", {
      trader: this.trader,
      delegate,
    });
    return await this.route(calldata, options.wait ?? true);
  }

  // ------------------------------------------------------------------ claims / misc

  /** Claim accumulated referral rebates (caller must be the referrer). */
  async claimRebate(options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/claim-rebate",
      { caller: this.trader },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async claimKeeperRewards(options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/misc/claim-keeper-rewards",
      { caller: this.trader },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  /**
   * PROTOCOL-INTERNAL: USDC injection into the protocol buffer
   * (VaultManager). Not part of the public trading surface; regular users
   * should never need this. Needs a prior USDC approval to the
   * VaultManager address.
   */
  async addToBuffer(amount: Num, options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/misc/add-to-buffer",
      { caller: this.trader, amountUsdc: amount },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  // ------------------------------------------------------------------ builder codes

  /**
   * Look up a builder code in the BuilderCode registry (tx-builder read).
   *
   * `code` is a plain string of 1-31 characters or a 32-byte 0x-hex value.
   * Returns `{code, registered, owner, feeCollector, maxOpenFeeRate/
   * -Percent, maxCloseFeeRate/-Percent, maxPnlCloseFeeRate/-Percent,
   * globalCapRate/-Percent}`. `registered: false` means the code is free
   * to claim via registerBuilderCode.
   */
  async builderCode(code: string): Promise<any> {
    return await this.txb.builderCode(code);
  }

  /**
   * Register a builder code with its three per-order fee-rate caps.
   *
   * Caps are percent of the order's NOTIONAL (collateral x leverage):
   * `0.1` = 0.1% per order; `0` disables fees for that side. Each cap is
   * bounded by the governance ceiling (`globalCapPercent`). The caller
   * becomes the code owner (msg.sender-scoped; blocked in delegate mode).
   * Fees are pulled from the trader's USDC allowance to the BuilderCode
   * registry (see approveBuilderFees) and sent to `feeCollector`.
   */
  async registerBuilderCode(
    code: string,
    args: {
      feeCollector: Address;
      maxOpenFeePercent: Num;
      maxCloseFeePercent: Num;
      maxPnlCloseFeePercent: Num;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/misc/builder-code/register",
      {
        caller: this.trader,
        code,
        feeCollector: args.feeCollector,
        maxOpenFeePercent: args.maxOpenFeePercent,
        maxCloseFeePercent: args.maxCloseFeePercent,
        maxPnlCloseFeePercent: args.maxPnlCloseFeePercent,
      },
      args.wait ?? true,
      { delegatable: false },
    );
  }

  /** Update a code's caps / collector (owner only; applies immediately). */
  async modifyBuilderCode(
    code: string,
    args: {
      feeCollector: Address;
      maxOpenFeePercent: Num;
      maxCloseFeePercent: Num;
      maxPnlCloseFeePercent: Num;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/misc/builder-code/modify",
      {
        caller: this.trader,
        code,
        feeCollector: args.feeCollector,
        maxOpenFeePercent: args.maxOpenFeePercent,
        maxCloseFeePercent: args.maxCloseFeePercent,
        maxPnlCloseFeePercent: args.maxPnlCloseFeePercent,
      },
      args.wait ?? true,
      { delegatable: false },
    );
  }
}
