/**
 * TP/SL management.
 *
 * - GLOBAL (on-chain) TP/SL: trade.updateTpSl — undefined keeps a leg,
 *   0 clears it (tp=0 resets to the pair's max-gain cap).
 * - PARTIAL (off-chain) triggers: trade.partialTpSl CRUD — stored with the
 *   operator, executed when the trigger price hits. Keep the entityId.
 */

import { Avantis, partialTriggers, positionSizeInAsset } from "avantis-sdk";

const client = new Avantis();

const data = await client.account.positions();
const position = data.positions[0];
if (!position) throw new Error("open a position first (examples/05)");

// Global TP at +something, leave SL untouched:
const price = await client.markets.price(position.pairIndex);
await client.trade.updateTpSl(position.pairIndex, position.index, {
  takeProfit: position.buy ? price * 1.05 : price * 0.95,
});
console.log("global TP updated");

// Partial TP: close 25% of the coin exposure at +2%:
const stored = await client.trade.partialTpSl(position.pairIndex, position.index, {
  side: position.buy ? "long" : "short",
  kind: "tp",
  coinExposure: positionSizeInAsset(position) * 0.25,
  price: position.buy ? price * 1.02 : price * 0.98,
});
console.log("partial trigger stored:", stored.entityId);

// List a position's triggers (global + partial):
const refreshed = await client.account.positions();
const pos = refreshed.positions.find(
  (p) => p.pairIndex === position.pairIndex && p.index === position.index,
);
console.log("partial triggers:", partialTriggers(pos!).map((t) => t.entityId));

// Cancel the partial trigger:
await client.trade.cancelPartialTpSl(stored.entityId as string);
console.log("partial trigger canceled");
