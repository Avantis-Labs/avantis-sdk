/**
 * Testnet (internal Base fork devnet) helpers.
 *
 * The Veranta testnet is a fork of Base mainnet: same chainId (8453) and
 * contract addresses, its own RPC/explorer. Its rpc-proxy exposes a
 * dev-only faucet method (`dev_impersonateTransaction`) that executes
 * unsigned transactions as devnet whale wallets — so anyone can fund a
 * fresh wallet and start trading in seconds:
 *
 *     import { Veranta, fundTestnetWallet } from "veranta-sdk";
 *     import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
 *
 *     const key = generatePrivateKey();
 *     const wallet = privateKeyToAccount(key);
 *     await fundTestnetWallet(wallet.address);          // 0.05 ETH + 1,000 USDC
 *
 *     const client = new Veranta({ network: "testnet", signer: key });
 *     await client.account.approveUsdc();
 *     await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 5 });
 *
 * MAINNET IS NEVER TOUCHED: the faucet method only exists on the fork's
 * rpc-proxy, and this module refuses non-testnet RPC URLs.
 */

import type { Address, Hex } from "viem";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  parseUnits,
  stringToBytes,
} from "viem";
import { TESTNET_RPC_URL } from "./config.js";
import { ConfigError } from "./errors.js";
import { JsonRpcClient } from "./execution/rpc.js";
import type { Num } from "./types.js";

/** Block explorer for the fork. */
export const TESTNET_EXPLORER_URL = "https://base-testnet-ovh.avantisfi.com";

/** USDC on Base (identical address on the fork). */
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Devnet whale wallets the faucet impersonates. */
const ETH_WHALE: Address = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";
const USDC_WHALE: Address = "0x6c561B446416E1A00E8E93E221854d6eA4171372";

const TRANSFER_SELECTOR = keccak256(stringToBytes("transfer(address,uint256)")).slice(0, 10) as Hex;

async function impersonate(
  rpc: JsonRpcClient,
  args: { from: Address; to: Address; data?: Hex; value?: bigint },
): Promise<string> {
  const txHash: string = await rpc.call("dev_impersonateTransaction", [
    {
      from: args.from,
      to: args.to,
      data: args.data ?? "0x",
      value: numberToHex(args.value ?? 0n),
    },
  ]);
  await rpc.waitForReceipt(txHash, 60_000);
  return txHash;
}

export interface FundTestnetWalletResult {
  address: Address;
  ethWei: bigint;
  usdcRaw: bigint;
  txHashes: string[];
}

/**
 * Fund a wallet on the Veranta testnet fork with gas ETH and test USDC
 * (defaults: 0.05 ETH, 1,000 USDC). Idempotent-ish: skips a leg when the
 * wallet already holds at least the requested amount.
 *
 * Testnet-only: throws unless the RPC URL contains "testnet".
 */
export async function fundTestnetWallet(
  address: Address,
  options: { eth?: Num; usdc?: Num; rpcUrl?: string } = {},
): Promise<FundTestnetWalletResult> {
  const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
  if (!/testnet/i.test(rpcUrl)) {
    throw new ConfigError(
      `fundTestnetWallet only works against the Veranta testnet fork (got ${rpcUrl})`,
    );
  }
  const rpc = new JsonRpcClient(rpcUrl);
  const wantEthWei = parseUnits(String(options.eth ?? 0.05), 18);
  const wantUsdcRaw = parseUnits(String(options.usdc ?? 1_000), 6);
  const txHashes: string[] = [];

  const ethBalance = await rpc.getBalance(address);
  if (ethBalance < wantEthWei) {
    txHashes.push(await impersonate(rpc, { from: ETH_WHALE, to: address, value: wantEthWei }));
  }

  const balanceOfData = concatHex([
    keccak256(stringToBytes("balanceOf(address)")).slice(0, 10) as Hex,
    encodeAbiParameters([{ type: "address" }], [address]),
  ]);
  const usdcBalance = BigInt(
    (await rpc.call("eth_call", [{ to: USDC, data: balanceOfData }, "latest"])) ?? "0x0",
  );
  if (usdcBalance < wantUsdcRaw) {
    const transferData = concatHex([
      TRANSFER_SELECTOR,
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, wantUsdcRaw]),
    ]);
    txHashes.push(await impersonate(rpc, { from: USDC_WHALE, to: USDC, data: transferData }));
  }

  return {
    address,
    ethWei: await rpc.getBalance(address),
    usdcRaw: BigInt(
      (await rpc.call("eth_call", [{ to: USDC, data: balanceOfData }, "latest"])) ?? "0x0",
    ),
    txHashes,
  };
}
