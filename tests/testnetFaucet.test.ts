import { numberToHex, parseUnits } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestnetFaucetError } from "../src/errors.js";
import { fundTestnetWallet } from "../src/testnet.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const ETH_WHALE = "0x3304e22ddaa22bcdc5fca2269b418046ae7b566a";
const USDC_WHALE = "0x6c561b446416e1a00e8e93e221854d6ea4171372";

/**
 * Minimal JSON-RPC stub: balances per address, every impersonated transfer
 * is recorded and "mined" with status 1.
 */
function stubRpc(balances: { eth: Record<string, bigint>; usdc: Record<string, bigint> }) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    let result: unknown;
    if (method === "eth_getBalance") {
      result = numberToHex(balances.eth[String(params[0]).toLowerCase()] ?? 0n);
    } else if (method === "eth_call") {
      const holder = `0x${String(params[0].data).slice(-40)}`;
      result = numberToHex(balances.usdc[holder] ?? 0n, { size: 32 });
    } else if (method === "dev_impersonateTransaction") {
      sent.push(params[0]);
      result = `0x${String(sent.length).padStart(64, "0")}`;
    } else if (method === "eth_getTransactionReceipt") {
      result = { status: "0x1" };
    } else {
      throw new Error(`unexpected RPC method ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

describe("fundTestnetWallet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws TestnetFaucetError before sending when the USDC whale is short", async () => {
    const sent = stubRpc({
      eth: { [ETH_WHALE]: parseUnits("1000", 18) },
      usdc: { [USDC_WHALE]: parseUnits("660.75", 6) },
    });
    await expect(fundTestnetWallet(WALLET, { usdc: 1_000 })).rejects.toThrow(TestnetFaucetError);
    await expect(fundTestnetWallet(WALLET, { usdc: 1_000 })).rejects.toThrow(
      /USDC whale .* holds 660.75 USDC, requested 1000/,
    );
    // Only the ETH leg was sent; the USDC transfer never went out.
    expect(sent.every((tx: any) => tx.from.toLowerCase() === ETH_WHALE)).toBe(true);
  });

  it("throws TestnetFaucetError when the ETH whale is short", async () => {
    const sent = stubRpc({
      eth: { [ETH_WHALE]: parseUnits("0.01", 18) },
      usdc: { [USDC_WHALE]: parseUnits("1000000", 6) },
    });
    await expect(fundTestnetWallet(WALLET)).rejects.toThrow(/ETH whale .* holds 0.01 ETH/);
    expect(sent).toHaveLength(0);
  });

  it("sends both legs when the whales can cover the request", async () => {
    const sent = stubRpc({
      eth: { [ETH_WHALE]: parseUnits("1000", 18) },
      usdc: { [USDC_WHALE]: parseUnits("1000000", 6) },
    });
    const result = await fundTestnetWallet(WALLET, { eth: 0.05, usdc: 300 });
    expect(result.txHashes).toHaveLength(2);
    expect(sent.map((tx: any) => tx.from.toLowerCase())).toEqual([ETH_WHALE, USDC_WHALE]);
  });
});
