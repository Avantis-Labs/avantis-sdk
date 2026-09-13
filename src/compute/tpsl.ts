/**
 * TP/SL price <-> percent conversions and bounds.
 *
 * Mirrors avantis-ui-v2 components/trade/tradeInput/tpsl/TPSL.tsx and
 * packages/shared/src/utils.ts (pnlOrderMinSL).
 *
 * Percentages are "percent of collateral" (100 = +100% profit at TP).
 */

/**
 * `isUpside` applies the Upside profit-share adjustment so the NET profit
 * hits the target percent.
 */
export function tpPercentToPrice(
  basePrice: number,
  takeProfitPercent: number,
  leverage: number,
  isLong: boolean,
  options: { isUpside?: boolean; pnlFeeP?: number } = {},
): number {
  const { isUpside = false, pnlFeeP = 0 } = options;
  let add = (basePrice * (takeProfitPercent / 100)) / leverage;
  if (isUpside && pnlFeeP < 100) {
    add = (add / (100 - pnlFeeP)) * 100; // fee-adjusted so NET profit hits the target
  }
  return isLong ? basePrice + add : basePrice - add;
}

export function tpPriceToPercent(
  basePrice: number,
  tpPrice: number,
  leverage: number,
  isLong: boolean,
  options: { isUpside?: boolean; pnlFeeP?: number } = {},
): number {
  const { isUpside = false, pnlFeeP = 0 } = options;
  const direction = isLong ? 1 : -1;
  let profitP = (((tpPrice - basePrice) * direction) / basePrice) * 100 * leverage;
  if (isUpside) profitP = (profitP * (100 - pnlFeeP)) / 100;
  return profitP;
}

export function slPercentToPrice(
  basePrice: number,
  stopLossPercent: number,
  leverage: number,
  isLong: boolean,
): number {
  const diff = (basePrice * (stopLossPercent / 100)) / leverage;
  return isLong ? basePrice - diff : basePrice + diff;
}

export function slPriceToPercent(
  basePrice: number,
  slPrice: number,
  leverage: number,
  isLong: boolean,
): number {
  const direction = isLong ? 1 : -1;
  return (((basePrice - slPrice) * direction) / basePrice) * 100 * leverage;
}

/** Minimum SL % for Upside (guaranteed-execution) orders, piecewise in leverage. */
export function pnlOrderMinSl(leverage: number): number {
  if (leverage <= 10) return (leverage / 10) * 1.5;
  if (leverage <= 25) return ((leverage - 10) / 15) * 2.25 + 1.5;
  if (leverage <= 50) return ((leverage - 25) / 25) * 3.75 + 3.75;
  if (leverage <= 100) return ((leverage - 50) / 50) * 3.75 + 7.5;
  if (leverage <= 250) return ((leverage - 100) / 150) * 18.75 + 11.25;
  if (leverage <= 500) return ((leverage - 250) / 250) * 15 + 30;
  if (leverage <= 1000) return ((leverage - 500) / 500) * 9 + 45;
  return 54;
}
