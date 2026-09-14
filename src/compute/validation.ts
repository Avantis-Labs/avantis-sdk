/**
 * Pre-trade validation: same rules the Veranta UI enforces.
 *
 * Note the tx-builder API also validates server-side (min position,
 * leverage envelope, headroom, market hours) and returns human-readable
 * 400s; this local validator is for building UIs/bots that want checks
 * before any network call.
 */

import {
  type PairInfo,
  type TradingSnapshot,
  isMarketOpen,
  isUpside as pairIsUpside,
  pairSymbol,
} from "../api/marketModels.js";
import { maxPositionSize } from "./liquidity.js";
import { adjustedMaxGainP } from "./pnl.js";
import { pnlOrderMinSl } from "./tpsl.js";

export const MIN_UPSIDE_SL_P = 5;
/** Added to the dynamic spread before scaling by leverage. */
export const SL_BUFFER_SPREAD_P = 0.01;
export const SPREAD_ERROR_THRESHOLD_P = 0.5;
export const SPREAD_LOSS_THRESHOLD_P = 25.1;

export interface OrderValidation {
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * Validate a prospective open order against pair config and live OI.
 *
 * `isUpside` selects the Upside (PnL) rule set: leverage envelope, TP cap
 * net of profit share, SL floor. Leave it undefined to derive from the pair
 * itself, matching the SDK's automatic order-type routing.
 */
export function validateOrder(
  pairInfo: PairInfo,
  snapshot: TradingSnapshot,
  args: {
    collateral: number;
    leverage: number;
    isLong: boolean;
    isUpside?: boolean;
    limitPrice?: number;
    marketPrice?: number;
    takeProfitPercent?: number;
    stopLossPercent?: number;
    dynamicSpreadP?: number;
    walletOi?: number;
    openTradesOnPair?: number;
  },
): OrderValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isUpside = args.isUpside ?? pairIsUpside(pairInfo);
  const positionSize = args.collateral * args.leverage;
  const symbol = pairSymbol(pairInfo);

  // pair state
  if (!(pairInfo.isPairListed ?? true)) errors.push(`${symbol} is delisted`);
  if (pairInfo.additionalPairParams2?.closeOnlyMode) errors.push(`${symbol} is in close-only mode`);
  if (!isMarketOpen(pairInfo)) errors.push(`${symbol} market is closed`);

  // leverage envelope
  const lev = pairInfo.leverages ?? {};
  const minLev = isUpside ? (lev.pnlMinLeverage ?? 0) : (lev.minLeverage ?? 1);
  const maxLev = isUpside ? (lev.pnlMaxLeverage ?? 0) : (lev.maxLeverage ?? 1);
  if (args.leverage < minLev || args.leverage > maxLev) {
    errors.push(`leverage ${args.leverage}x outside [${minLev}, ${maxLev}]`);
  }

  // size limits
  const minPos = pairInfo.minLevPosUSDC ?? 0;
  if (positionSize < minPos) {
    errors.push(`position ${positionSize.toFixed(2)} USDC below minimum ${minPos}`);
  }
  const maxPos = maxPositionSize(pairInfo, snapshot, {
    isLong: args.isLong,
    walletOi: args.walletOi ?? 0,
  });
  if (positionSize > maxPos) {
    errors.push(
      `position ${positionSize.toFixed(2)} USDC exceeds available headroom ${maxPos.toFixed(2)}`,
    );
  }

  // trades per pair
  const maxTrades = snapshot.maxTradesPerPair ?? 0;
  if (maxTrades && (args.openTradesOnPair ?? 0) >= maxTrades) {
    errors.push(`max ${maxTrades} trades per pair reached`);
  }

  // limit price direction
  if (args.limitPrice !== undefined && args.marketPrice !== undefined) {
    if (args.isLong && args.limitPrice >= args.marketPrice) {
      errors.push("limit price must be below market for longs");
    }
    if (!args.isLong && args.limitPrice <= args.marketPrice) {
      errors.push("limit price must be above market for shorts");
    }
  }

  // TP bounds
  if (args.takeProfitPercent !== undefined) {
    let maxTp = pairInfo.values?.maxGainP ?? 2500;
    const tierP = pairInfo.pnlFees?.tierP ?? [];
    if (isUpside && tierP.length > 0) {
      maxTp = adjustedMaxGainP(maxTp, tierP, pairInfo.pnlFees?.feesP ?? []);
    }
    if (args.takeProfitPercent > maxTp) {
      errors.push(`take profit ${args.takeProfitPercent}% above max ${maxTp.toFixed(0)}%`);
    }
  }

  // SL bounds
  if (args.stopLossPercent !== undefined) {
    const maxSlP = pairInfo.values?.maxSlP ?? 80;
    if (args.stopLossPercent > maxSlP) {
      errors.push(`stop loss ${args.stopLossPercent}% above max ${maxSlP}%`);
    }
    // UI rule: slPLimit = (priceImpactBenefit + SL_BUFFER_SPREAD) * leverage,
    // spread and buffer both in plain percent units; Upside floors at
    // max(slPLimit, MIN_UPSIDE_SL_P) and the pnlOrderMinSL curve.
    const slLimit =
      args.dynamicSpreadP !== undefined
        ? (args.dynamicSpreadP + SL_BUFFER_SPREAD_P) * args.leverage
        : 0;
    if (isUpside) {
      const minSl = Math.max(slLimit, MIN_UPSIDE_SL_P, pnlOrderMinSl(args.leverage));
      if (args.stopLossPercent < minSl) {
        errors.push(`Upside stop loss must be >= ${minSl.toFixed(2)}%`);
      }
    } else if (args.dynamicSpreadP !== undefined && args.stopLossPercent < slLimit) {
      errors.push(`stop loss can't be less than ${slLimit.toFixed(2)}% to guarantee execution`);
    }
  }

  // spread sanity
  if (args.dynamicSpreadP !== undefined) {
    if (args.dynamicSpreadP / 2 > SPREAD_ERROR_THRESHOLD_P) {
      errors.push(`spread too high (${args.dynamicSpreadP.toFixed(3)}%)`);
    } else if (args.dynamicSpreadP * args.leverage >= SPREAD_LOSS_THRESHOLD_P) {
      errors.push(
        `spread x leverage = ${(args.dynamicSpreadP * args.leverage).toFixed(1)}% >= ` +
          `${SPREAD_LOSS_THRESHOLD_P}%`,
      );
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}
