import { describe, expect, it } from "vitest";
import { pairCloseMakerTakerFeeP } from "../src/compute/fees.js";

describe("pairCloseMakerTakerFeeP", () => {
  it("clamps the closed coin size to the closing side's open interest like the contract", () => {
    // A stale snapshot shows 10 long coins while the position closes 15: the chain
    // clamps to 10, reduces the long side to zero and blends over 10, not 15.
    const clamped = pairCloseMakerTakerFeeP({
      initialCoinOiLong: 10,
      initialCoinOiShort: 4,
      positionSizeCoinOi: 15,
      isLong: true,
      closeMakerFeeP: 0.01,
      closeTakerFeeP: 0.05,
    });
    const exact = pairCloseMakerTakerFeeP({
      initialCoinOiLong: 10,
      initialCoinOiShort: 4,
      positionSizeCoinOi: 10,
      isLong: true,
      closeMakerFeeP: 0.01,
      closeTakerFeeP: 0.05,
    });
    expect(clamped).toEqual(exact);
    expect(clamped.kind).toBe("mixed");
    // Reducing a skew that stays on the same side is a maker close.
    const maker = pairCloseMakerTakerFeeP({
      initialCoinOiLong: 10,
      initialCoinOiShort: 4,
      positionSizeCoinOi: 2,
      isLong: true,
      closeMakerFeeP: 0.01,
      closeTakerFeeP: 0.05,
    });
    expect(maker.kind).toBe("maker");
  });
});
