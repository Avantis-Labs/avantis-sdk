/** PnL math: mirrors avantis-ui-v2 lib/utils.ts and positions.helper.ts. */

import {
  type Position,
  positionCollateral,
  positionLeverage,
  positionOpenPrice,
  positionRolloverFee,
  positionUnrealisedFundingFee,
} from "../api/accountModels.js";
import type { PairInfo } from "../api/marketModels.js";

/** (current - open) * dir / open * leverage * collateral. */
export function grossPnl(
  currentPrice: number,
  openPrice: number,
  collateral: number,
  leverage: number,
  isLong: boolean,
): number {
  const direction = isLong ? 1 : -1;
  return (((currentPrice - openPrice) * direction) / openPrice) * leverage * collateral;
}

/** Tiered Upside profit-sharing fee %: highest tier whose threshold is met. */
export function pnlFeeByGrossProfitP(
  tierP: number[],
  desiredGrossProfitP: number,
  feesP: number[],
): number {
  for (let i = tierP.length - 1; i >= 0; i--) {
    if (desiredGrossProfitP >= tierP[i]!) {
      return i < feesP.length ? feesP[i]! : 0;
    }
  }
  return feesP[0] ?? 0;
}

/** [feeP, fee USDC] for a realized Upside profit; 0 when pnl <= 0. */
export function pnlTypeFee(
  tierP: number[],
  feesP: number[],
  profitP: number,
  pnl: number,
): [number, number] {
  if (pnl <= 0) return [0, 0];
  let i = 0;
  while (i < tierP.length && profitP >= tierP[i]!) i++;
  if (i === tierP.length) i = tierP.length - 1;
  const feeP = feesP[i] ?? 0;
  return [feeP, (pnl * feeP) / 100];
}

/** Max TP % for Upside positions, net of the profit-sharing fee at that level. */
export function adjustedMaxGainP(maxGainP: number, tierP: number[], feesP: number[]): number {
  return (maxGainP * (100 - pnlFeeByGrossProfitP(tierP, maxGainP, feesP))) / 100;
}

export interface NetPnlBreakdown {
  gross: number;
  closingFee: number;
  rolloverFee: number;
  fundingFee: number;
  lossProtection: number;
  profitShareFee: number;
  net: number;
}

/** What the close fee is charged on: the leveraged position (the contract) or the web app's estimate that adds the gross PnL. */
export type CloseFeeBase = "notional" | "notional_plus_pnl";

/**
 * Unrealized net PnL breakdown for an open position.
 *
 * - Fixed-fee (isUpside=false): net = gross - closingFee - rollover -
 *   funding + lossProtection (loss protection only offsets negative gross,
 *   capped). The closing fee is charged on the leveraged position, as the
 *   contract does (`closeFeeBase: "notional"`, the default); pass
 *   `"notional_plus_pnl"` to reproduce the web app's estimate, which adds the
 *   gross PnL to the base.
 * - Upside (isUpside=true): net = gross * (1 - tieredFeeP/100) - rollover -
 *   funding.
 */
export function netPnl(args: {
  closeFeeBase?: CloseFeeBase;
  currentPrice: number;
  openPrice: number;
  collateral: number;
  leverage: number;
  isLong: boolean;
  isUpside?: boolean;
  closeFeeP?: number;
  feeDiscountP?: number;
  rolloverFee?: number;
  fundingFee?: number;
  lossProtectionP?: number;
  pnlTierP?: number[];
  pnlFeesP?: number[];
}): NetPnlBreakdown {
  const {
    currentPrice,
    openPrice,
    collateral,
    leverage,
    isLong,
    isUpside = false,
    closeFeeP = 0,
    feeDiscountP = 0,
    rolloverFee = 0,
    fundingFee = 0,
    lossProtectionP = 0,
    pnlTierP = [],
    pnlFeesP = [],
    closeFeeBase = "notional",
  } = args;
  const gross = grossPnl(currentPrice, openPrice, collateral, leverage, isLong);

  if (isUpside) {
    const grossP = collateral ? (gross / collateral) * 100 : 0;
    const feeP = grossP > 0 ? pnlFeeByGrossProfitP(pnlTierP, grossP, pnlFeesP) : 0;
    const share = (gross * feeP) / 100;
    return {
      gross,
      closingFee: 0,
      rolloverFee,
      fundingFee,
      lossProtection: 0,
      profitShareFee: share,
      net: gross - share - rolloverFee - fundingFee,
    };
  }

  const feeBase =
    closeFeeBase === "notional_plus_pnl" ? collateral * leverage + gross : collateral * leverage;
  const closingFee = (feeBase * closeFeeP * (1 - feeDiscountP / 100)) / 100;
  let protection = 0;
  if (gross < 0 && lossProtectionP > 0) {
    protection = Math.min((-gross * lossProtectionP) / 100, (collateral * lossProtectionP) / 100);
  }
  return {
    gross,
    closingFee,
    rolloverFee,
    fundingFee,
    lossProtection: protection,
    profitShareFee: 0,
    net: gross - closingFee - rolloverFee - fundingFee + protection,
  };
}

/** Net PnL for a `Position` using its pair snapshot info. */
export function positionNetPnl(
  position: Position,
  pairInfo: PairInfo,
  currentPrice: number,
  options: { closeFeeBase?: CloseFeeBase } = {},
): NetPnlBreakdown {
  const lossProtectionTier = String(Number(position.lossProtection ?? "0"));
  return netPnl({
    closeFeeBase: options.closeFeeBase,
    currentPrice,
    openPrice: positionOpenPrice(position),
    collateral: positionCollateral(position),
    leverage: positionLeverage(position),
    isLong: position.buy,
    isUpside: position.isPnl ?? false,
    closeFeeP: pairInfo.closeFeeP ?? 0,
    rolloverFee: positionRolloverFee(position),
    fundingFee: positionUnrealisedFundingFee(position),
    lossProtectionP: pairInfo.lossProtectionMultiplier?.[lossProtectionTier] ?? 0,
    pnlTierP: pairInfo.pnlFees?.tierP ?? [],
    pnlFeesP: pairInfo.pnlFees?.feesP ?? [],
  });
}
