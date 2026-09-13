/**
 * Fee math: skew-adjusted open fee and maker/taker classification.
 *
 * Mirrors avantis-ui-v2 hooks/trade/useOpeningFee.ts and useMakerTakerFee.ts.
 */

/**
 * [feeP, fee USDC] for opening, adjusted for post-trade OI skew.
 *
 * After the hypothetical OI shift, `oiPct = floor(100 * oppositeOI /
 * (newSameSideOI + oppositeOI))`; the pair's skewEqParams line for that
 * decile gives `feeP = (a * oiPct + b) / 10000`.
 */
export function skewAdjustedOpenFee(args: {
  positionSize: number;
  isLong: boolean;
  oiLong: number;
  oiShort: number;
  skewEqParams: number[][];
  feeDiscountP?: number;
}): [number, number] {
  const { positionSize, isLong, oiLong, oiShort, skewEqParams, feeDiscountP = 0 } = args;
  let oiPct: number;
  if (isLong) {
    const newSame = oiLong + positionSize;
    oiPct = Math.floor((100 * oiShort) / (newSame + oiShort || 1));
  } else {
    const newSame = oiShort + positionSize;
    oiPct = Math.floor((100 * oiLong) / (newSame + oiLong || 1));
  }

  const pctIndex = Math.min(Math.floor(oiPct / 10), skewEqParams.length - 1);
  const [a = 0, b = 0] = skewEqParams[pctIndex] ?? [];
  const skewFeeP = (a * oiPct + b) / 10000;
  const feeP = skewFeeP * (1 - feeDiscountP / 100);
  return [feeP, (positionSize * feeP) / 100];
}

export interface MakerTakerFee {
  feeP: number;
  kind: "maker" | "taker" | "mixed";
}

/** Classify a trade as maker/taker/mixed based on coin-OI skew before/after. */
export function makerOrTakerFeeP(
  coinOiLong: number,
  coinOiShort: number,
  initialCoinOiLong: number,
  initialCoinOiShort: number,
  positionSizeCoinOi: number,
  makerFeeP: number,
  takerFeeP: number,
): MakerTakerFee {
  if (initialCoinOiLong + initialCoinOiShort === 0 || coinOiLong + coinOiShort === 0) {
    return { feeP: takerFeeP, kind: "taker" };
  }

  const pctBefore = initialCoinOiLong / (initialCoinOiLong + initialCoinOiShort);
  const pctAfter = coinOiLong / (coinOiLong + coinOiShort);

  if (pctBefore > 0.5) {
    if (pctAfter > pctBefore) return { feeP: takerFeeP, kind: "taker" };
    if (pctAfter >= 0.5) return { feeP: makerFeeP, kind: "maker" };
    const mixed =
      (makerFeeP * (initialCoinOiLong - initialCoinOiShort) +
        takerFeeP * (positionSizeCoinOi - initialCoinOiLong + initialCoinOiShort)) /
      positionSizeCoinOi;
    return { feeP: mixed, kind: "mixed" };
  }

  if (pctBefore < 0.5) {
    if (pctAfter < pctBefore) return { feeP: takerFeeP, kind: "taker" };
    if (pctAfter <= 0.5) return { feeP: makerFeeP, kind: "maker" };
    const mixed =
      (makerFeeP * (initialCoinOiShort - initialCoinOiLong) +
        takerFeeP * (positionSizeCoinOi - initialCoinOiShort + initialCoinOiLong)) /
      positionSizeCoinOi;
    return { feeP: mixed, kind: "mixed" };
  }

  return { feeP: takerFeeP, kind: "taker" };
}

export function pairOpenMakerTakerFeeP(args: {
  initialCoinOiLong: number;
  initialCoinOiShort: number;
  positionSizeCoinOi: number;
  isLong: boolean;
  openMakerFeeP: number;
  openTakerFeeP: number;
}): MakerTakerFee {
  return makerOrTakerFeeP(
    args.isLong ? args.initialCoinOiLong + args.positionSizeCoinOi : args.initialCoinOiLong,
    args.isLong ? args.initialCoinOiShort : args.initialCoinOiShort + args.positionSizeCoinOi,
    args.initialCoinOiLong,
    args.initialCoinOiShort,
    args.positionSizeCoinOi,
    args.openMakerFeeP,
    args.openTakerFeeP,
  );
}

export function pairCloseMakerTakerFeeP(args: {
  initialCoinOiLong: number;
  initialCoinOiShort: number;
  positionSizeCoinOi: number;
  isLong: boolean;
  closeMakerFeeP: number;
  closeTakerFeeP: number;
}): MakerTakerFee {
  return makerOrTakerFeeP(
    args.isLong
      ? Math.max(args.initialCoinOiLong - args.positionSizeCoinOi, 0)
      : args.initialCoinOiLong,
    args.isLong
      ? args.initialCoinOiShort
      : Math.max(args.initialCoinOiShort - args.positionSizeCoinOi, 0),
    args.initialCoinOiLong,
    args.initialCoinOiShort,
    args.positionSizeCoinOi,
    args.closeMakerFeeP,
    args.closeTakerFeeP,
  );
}
