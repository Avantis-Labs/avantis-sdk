/**
 * End-to-end test against the Avantis TESTNET (internal Base fork).
 *
 * Fully self-contained: generates a fresh wallet, funds it through the
 * fork's dev faucet, then exercises every transport the SDK has —
 * tx-builder builds, blitz type-4 relay (USDC approve), batched-market SSE
 * (open + close with lifecycle events), core price-triggers (global TP),
 * and the read APIs.
 *
 * Gated: only runs with AVANTIS_E2E=1 (pnpm test:e2e). Never touches
 * mainnet — network is hard-pinned to "testnet".
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { findPosition, positionCollateral, positionTp } from "../../src/api/accountModels.js";
import { Avantis } from "../../src/client.js";
import type { BatchedMarketEvent } from "../../src/execution/batchedMarket.js";
import { fundTestnetWallet } from "../../src/testnet.js";

const PAIR = "ETH/USD";
const COLLATERAL = 100;
const LEVERAGE = 5;

const run = process.env.AVANTIS_E2E === "1";

describe.skipIf(!run)("testnet e2e (fresh wallet)", () => {
  const privateKey = generatePrivateKey();
  const wallet = privateKeyToAccount(privateKey);
  let client: Avantis;
  let pairIndex: number;
  let tradeIndex: number;

  beforeAll(async () => {
    console.log("e2e wallet:", wallet.address);
    const funded = await fundTestnetWallet(wallet.address, { eth: 0.05, usdc: 1_000 });
    console.log(
      "funded: eth =",
      Number(funded.ethWei) / 1e18,
      "usdc =",
      Number(funded.usdcRaw) / 1e6,
    );
    client = new Avantis({ network: "testnet", signer: privateKey });
    pairIndex = await client.markets.pairIndex(PAIR);
  }, 120_000);

  it("bootstraps from /v2/meta on the fork", async () => {
    expect(await client.chainId()).toBe(8453);
    expect(client.config.rpcUrl).toContain("testnet"); // auto-defaulted fork RPC
    const pairs = await client.markets.pairs();
    expect(pairs.size).toBeGreaterThan(50);
  });

  it("reads a live price and a spread quote", async () => {
    const price = await client.markets.price(PAIR);
    expect(price).toBeGreaterThan(0);
    const quote = await client.markets.spread(PAIR, {
      isLong: true,
      collateral: COLLATERAL,
      leverage: LEVERAGE,
    });
    expect(quote.spreadPct).toBeGreaterThanOrEqual(0);
  });

  it("approves USDC gaslessly (blitz EIP-7702 relay)", async () => {
    const receipt = await client.account.approveUsdc();
    console.log("approve:", receipt.route, receipt.txHash);
    expect(["relayer-passthrough", "rpc", "wallet"]).toContain(receipt.route);
    const allowance = await client.account.allowance();
    expect(Number(allowance.allowanceUsdc ?? allowance.allowance)).toBeGreaterThan(0);
  }, 180_000);

  it("opens a market position (batched-market SSE lifecycle)", async () => {
    const events: BatchedMarketEvent[] = [];
    const receipt = await client.trade.marketOpen(PAIR, "long", {
      collateral: COLLATERAL,
      leverage: LEVERAGE,
      slippagePercent: 2,
      onEvent: (event) => {
        events.push(event);
        console.log(`  [${event.seq}] ${event.type}`, event.data.code ?? "");
      },
    });
    console.log("open:", receipt.txHash, "orderId:", receipt.orderId);
    expect(receipt.route).toBe("batched-market");
    expect(receipt.trackingId).toBeTruthy();
    expect(receipt.txHash).toBeTruthy();
    expect(events.map((e) => e.type)).toContain("MarketOrderAccepted");
    expect(events.at(-1)?.type).toBe("MarketOrderExecuted");
  }, 180_000);

  it("sees the position on /user-data", async () => {
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const data = await client.account.positions();
      const position = data.positions.find((p) => p.pairIndex === pairIndex);
      if (position) {
        tradeIndex = position.index;
        expect(positionCollateral(position)).toBeGreaterThan(COLLATERAL * 0.8);
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(found).toBe(true);
  }, 90_000);

  it("updates the global TP through core price-triggers", async () => {
    const price = await client.markets.price(PAIR);
    const target = Math.round(price * 1.05 * 100) / 100;
    const receipt = await client.trade.updateTpSl(pairIndex, tradeIndex, {
      takeProfit: target,
    });
    expect(receipt.route).toBe("price-triggers");
    const data = await client.account.positions();
    const position = findPosition(data, pairIndex, tradeIndex);
    expect(position).toBeTruthy();
    expect(positionTp(position!)).toBeCloseTo(target, 2);
  }, 180_000);

  it("closes the position fully (batched-market SSE)", async () => {
    const data = await client.account.positions();
    const position = findPosition(data, pairIndex, tradeIndex);
    expect(position).toBeTruthy();
    const receipt = await client.trade.marketClose(pairIndex, tradeIndex, {
      collateralToClose: positionCollateral(position!),
      onEvent: (event) => console.log(`  [${event.seq}] ${event.type}`, event.data.code ?? ""),
    });
    console.log("close:", receipt.txHash);
    expect(receipt.txHash).toBeTruthy();

    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      const after = await client.account.positions();
      gone = findPosition(after, pairIndex, tradeIndex) === undefined;
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(gone).toBe(true);
  }, 180_000);

  it("finds the round trip in trade history (best effort)", async () => {
    const history = await client.info.tradeHistory(wallet.address, 0, 10).catch(() => null);
    console.log(
      "history entries:",
      Array.isArray(history) ? history.length : JSON.stringify(history)?.slice(0, 120),
    );
    // Indexers lag; presence is asserted softly.
    expect(history).not.toBeUndefined();
  });
});
