/**
 * USDC approvals from the browser.
 *
 * Strategies (mirrors the Avantis delegate UI):
 * - "permit": gasless — the trader wallet signs an EIP-2612 Permit, a
 *   throwaway EIP-7702 account relays `USDC.permit(...)` through blitz.
 *   Works for EOAs (no ETH needed).
 * - "wallet": a normal `USDC.approve` transaction sent by the wallet
 *   (needs ETH for gas).
 * - "auto" (default): permit first, wallet fallback.
 */

import { useMutation } from "@tanstack/react-query";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { encodeFunctionData, hexToSignature, maxUint256, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { Avantis } from "../client.js";
import { GelatoDelegationEncoder } from "../eip7702/account.js";
import { ConfigError } from "../errors.js";
import { RelayerClient } from "../execution/relayer.js";
import { toSigner } from "../signing/signer.js";
import type { ExecutionReceipt, Num } from "../types.js";
import { useInvalidatePositions } from "./mutations.js";
import { useAvantisContext } from "./provider.js";

const PERMIT_GAS = 300_000;

const USDC_PERMIT_ABI = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export interface ApproveUsdcVars {
  /** Human USDC; omit for unlimited. */
  amount?: Num;
  /** Defaults to TradingStorage (collateral). */
  spender?: Address;
  strategy?: "auto" | "permit" | "wallet";
}

export function useApproveUsdc(options: { onSuccess?: (receipt: ExecutionReceipt) => void } = {}) {
  const { config } = useAvantisContext();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const invalidate = useInvalidatePositions();

  return useMutation({
    mutationFn: async (vars: ApproveUsdcVars = {}): Promise<ExecutionReceipt> => {
      if (!address || !walletClient) {
        throw new ConfigError("Connect a wallet before approving USDC");
      }
      const strategy = vars.strategy ?? "auto";
      // Approvals are msg.sender-scoped: always the TRADER wallet, never a
      // session key, so build a wallet-signer client here.
      const walletAvantis = new Avantis({ ...config, signer: walletClient });

      if (strategy !== "wallet") {
        try {
          return await permitGasless(walletAvantis, {
            owner: address,
            walletClient: walletClient as unknown as WalletClient,
            publicClient: publicClient as unknown as PublicClient | undefined,
            amount: vars.amount,
            spender: vars.spender,
          });
        } catch (error) {
          if (strategy === "permit") throw error;
          // auto: fall through to the wallet transaction
        }
      }
      return await walletAvantis.account.approveUsdc(vars.amount, { spender: vars.spender });
    },
    onSuccess: (receipt) => {
      invalidate();
      options.onSuccess?.(receipt);
    },
  });
}

async function permitGasless(
  client: Avantis,
  args: {
    owner: Address;
    walletClient: WalletClient;
    publicClient: PublicClient | undefined;
    amount?: Num;
    spender?: Address;
  },
): Promise<ExecutionReceipt> {
  const meta = await client.meta();
  const chainId = Number(meta.chainId);
  const usdc = (meta.addresses.usdc ?? meta.addresses.USDC) as Address | undefined;
  const spender = (args.spender ?? meta.addresses.tradingStorage) as Address | undefined;
  if (!usdc || !spender) {
    throw new ConfigError("tx-builder /v2/meta carries no usdc/tradingStorage address");
  }
  if (!args.publicClient) {
    throw new ConfigError("wagmi public client unavailable (needed to read the permit nonce)");
  }

  const [nonce, tokenName] = await Promise.all([
    args.publicClient.readContract({
      address: usdc,
      abi: USDC_PERMIT_ABI,
      functionName: "nonces",
      args: [args.owner],
    }),
    args.publicClient.readContract({
      address: usdc,
      abi: USDC_PERMIT_ABI,
      functionName: "name",
    }),
  ]);

  const value = args.amount === undefined ? maxUint256 : parseUnits(String(args.amount), 6);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600); // EIP-2612: SECONDS

  const signature = await args.walletClient.signTypedData({
    account: args.walletClient.account ?? args.owner,
    domain: {
      name: tokenName,
      version: "2", // FiatTokenV2_2 on Base
      chainId,
      verifyingContract: usdc,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: args.owner, spender, value, nonce, deadline },
  });
  const { v, r, s } = hexToSignature(signature as Hex);

  const permitData = encodeFunctionData({
    abi: USDC_PERMIT_ABI,
    functionName: "permit",
    args: [args.owner, spender, value, deadline, Number(v ?? 27n), r, s],
  });

  // Throwaway relay-only EIP-7702 account (mirrors the delegate UI).
  const relayKey = generatePrivateKey();
  const relaySigner = toSigner(privateKeyToAccount(relayKey));
  const encoder = new GelatoDelegationEncoder(
    relaySigner,
    chainId,
    client.config.delegationAddress,
  );
  const txParams = await encoder.buildType4([{ to: usdc, data: permitData }], {
    gas: PERMIT_GAS,
    accountNonce: 0,
  });
  const relayer = new RelayerClient(client.transport, client.config.relayerUrl, {
    pollIntervalMs: client.config.relayPollIntervalMs,
    pollTimeoutMs: client.config.relayPollTimeoutMs,
  });
  const requestId = await relayer.create(
    txParams as unknown as Record<string, unknown>,
    args.owner,
  );
  const status = await relayer.wait(requestId);
  return {
    route: "relayer-passthrough",
    requestId,
    txHash: status.txHash,
    description: "USDC permit (gasless approve)",
    raw: status.receipt,
  };
}
