/**
 * Pure UI-parity math (no I/O): PnL, liquidation, fees, liquidity, TP/SL
 * conversions, pre-trade validation.
 */

export {
  makerOrTakerFeeP,
  type MakerTakerFee,
  pairCloseMakerTakerFeeP,
  pairOpenMakerTakerFeeP,
  skewAdjustedOpenFee,
} from "./fees.js";
export { estimateLiquidationPrice, LIQ_THRESHOLD_P } from "./liquidation.js";
export { availableLiquidity, type Liquidity, maxPositionSize } from "./liquidity.js";
export {
  adjustedMaxGainP,
  grossPnl,
  netPnl,
  type NetPnlBreakdown,
  pnlFeeByGrossProfitP,
  pnlTypeFee,
  positionNetPnl,
} from "./pnl.js";
export {
  pnlOrderMinSl,
  slPercentToPrice,
  slPriceToPercent,
  tpPercentToPrice,
  tpPriceToPercent,
} from "./tpsl.js";
export {
  MIN_UPSIDE_SL_P,
  type OrderValidation,
  SL_BUFFER_SPREAD_P,
  SPREAD_ERROR_THRESHOLD_P,
  SPREAD_LOSS_THRESHOLD_P,
  validateOrder,
} from "./validation.js";
