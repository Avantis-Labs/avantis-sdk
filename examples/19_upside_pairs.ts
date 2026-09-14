/**
 * Upside markets (formerly ZFP/zero-fee): separate pairs suffixed _UPSIDE.
 *
 * No flag to pass — trade "BTC_UPSIDE" and the SDK sends the PnL order
 * type automatically. Upside pairs are market-only (no limits, no TWAP)
 * and pay a tiered profit share instead of fixed fees.
 */

import { Veranta, compute, pairSymbol } from "veranta-sdk";

const client = new Veranta();

const upside = await client.markets.upsidePairs();
console.log("upside pairs:", [...upside.values()].map(pairSymbol).join(", "));

// The Upside twin of a fixed-fee market:
const twin = await client.markets.upsidePairFor("BTC/USD");
console.log("BTC/USD upside twin:", pairSymbol(twin), "index:", twin.index);

// Profit-share tiers + fee-adjusted max TP:
const tiers = twin.pnlFees ?? {};
console.log("tiers:", tiers.tierP, "fees:", tiers.feesP);
console.log(
  "max TP % net of profit share:",
  compute.adjustedMaxGainP(twin.values?.maxGainP ?? 2500, tiers.tierP ?? [], tiers.feesP ?? []),
);

// Open one (routes as PnL automatically; SL floor applies):
const receipt = await client.trade.marketOpen(twin.index, "long", {
  collateral: 100,
  leverage: 50,
  stopLoss: 0, // set a real SL in production; see compute.pnlOrderMinSl
});
console.log("tx:", receipt.txHash);
