/**
 * Builder codes: attribute order flow and charge per-order fees.
 *
 * One-time setup (code owner): register the code with fee caps.
 * Per-app config: builderCode + builderFeePercent on the client; every
 * market open/close/increase then carries the fee suffix (relayed via
 * blitz so the fee-charging EIP-7702 template executes).
 *
 * Trader-side onboarding: approve USDC to the BuilderCode registry
 * (approveBuilderFees) in addition to the normal TradingStorage approval.
 */

import { Avantis } from "avantis-sdk";

// --- owner: register the code (once) --------------------------------------
const owner = new Avantis();
const info = await owner.account.builderCode("MYAPP");
if (!info.registered) {
  await owner.account.registerBuilderCode("MYAPP", {
    feeCollector: owner.signer!.address,
    maxOpenFeePercent: 0.1, // caps, % of notional
    maxCloseFeePercent: 0.1,
    maxPnlCloseFeePercent: 0.5,
  });
  console.log("registered MYAPP");
} else {
  console.log("MYAPP owned by:", info.owner);
}

// --- trader: one-time fee allowance ----------------------------------------
const trader = new Avantis(); // trader key
await trader.account.approveBuilderFees(); // unlimited; pass an amount to cap
console.log("fee allowance:", await trader.account.builderFeeAllowance());

// --- app: attach the code to order flow ------------------------------------
const app = new Avantis({
  builderCode: "MYAPP",
  builderFeePercent: 0.05, // 0.05% of notional per order; 0 = attribution only
});
const receipt = await app.trade.marketOpen("ETH/USD", "long", {
  collateral: 100,
  leverage: 10,
  // builderFeePercent: 0.02,  // per-order override
});
console.log("route:", receipt.route, "tx:", receipt.txHash); // relayer-passthrough (blitz)
