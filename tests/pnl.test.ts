import { describe, expect, it } from "vitest";
import { netPnl } from "../src/compute/pnl.js";

const args = {
  currentPrice: 3300,
  openPrice: 3000,
  collateral: 100,
  leverage: 10,
  isLong: true,
  closeFeeP: 0.045,
  rolloverFee: 1.5,
  fundingFee: 0.5,
};

describe("netPnl close fee base", () => {
  it("charges the close fee on the leveraged position by default, like the contract", () => {
    const out = netPnl(args);
    expect(out.gross).toBeCloseTo(100);
    expect(out.closingFee).toBeCloseTo(0.45); // 1000 x 0.045%
    expect(out.net).toBeCloseTo(100 - 0.45 - 1.5 - 0.5);
  });

  it("reproduces the web app's estimate on request", () => {
    const out = netPnl({ ...args, closeFeeBase: "notional_plus_pnl" });
    expect(out.closingFee).toBeCloseTo(0.495); // (1000 + 100) x 0.045%
  });
});
