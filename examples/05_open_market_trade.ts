/**
 * Open a market position: the default gasless relayer route.
 *
 * The SDK fetches the intent from the tx-builder API, signs it locally
 * (with a digest correctness check), and executes it through the
 * batched-market API. No RPC, no ETH needed.
 *
 * `onEvent` (optional) observes the order journey live while the SDK still
 * settles the outcome: the accepted event, retryable AttemptFailed
 * diagnostics (good debug logs, e.g. NO_PRICE or a contract error name),
 * and the terminal event, which is delivered even when the call throws.
 */

import { Avantis, type BatchedMarketEvent } from "avantis-sdk";

const client = new Avantis();

function journey(event: BatchedMarketEvent): void {
  const code = event.data.code;
  console.log(`  [${event.seq}] ${event.type}${code ? ` code=${code}` : ""}`);
}

const receipt = await client.trade.marketOpen("ETH/USD", "long", {
  collateral: 100, // 100 USDC
  leverage: 10, // 10x
  takeProfit: 4000, // optional; omit for none
  stopLoss: 2800, // optional
  slippagePercent: 1,
  onEvent: journey, // optional: live lifecycle log
});
console.log("route:", receipt.route);
console.log("tx:", receipt.txHash);

// A confirmed tx != a filled trade: market orders are fulfilled by the
// operator. Poll positions to see the fill:
await new Promise((resolve) => setTimeout(resolve, 3_000));
const data = await client.account.positions();
console.log("open positions:", data.positions.length);
