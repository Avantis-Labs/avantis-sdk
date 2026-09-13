/**
 * Liquidation price estimate: mirrors avantis-ui-v2 useLiqPrice.ts and
 * PairInfos.getTradeLiquidationPricePure.
 *
 * The authoritative value for open positions comes from the core API
 * (`position.liquidationPrice`); this estimate is for pre-trade display and
 * what-if math (margin edits, increases).
 */

/** % of collateral lost at liquidation. */
export const LIQ_THRESHOLD_P = 85;

/** liqDistance = openPrice * (collateral*threshold - fees) / (collateral*leverage). */
export function estimateLiquidationPrice(args: {
  openPrice: number;
  collateral: number;
  leverage: number;
  isLong: boolean;
  rolloverFee?: number;
  fundingFee?: number;
  liqThresholdP?: number;
}): number {
  const {
    openPrice,
    collateral,
    leverage,
    isLong,
    rolloverFee = 0,
    fundingFee = 0,
    liqThresholdP = LIQ_THRESHOLD_P,
  } = args;
  const positionSize = collateral * leverage;
  if (positionSize <= 0) return 0;
  const distance =
    (openPrice * ((collateral * liqThresholdP) / 100 - rolloverFee - fundingFee)) / positionSize;
  return isLong ? openPrice - distance : openPrice + distance;
}
