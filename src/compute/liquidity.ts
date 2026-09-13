/**
 * Open-interest headroom / max position size.
 *
 * Mirrors avantis-ui-v2 lib/trade.ts `availableLiquidity`.
 */

import type { PairInfo, TradingSnapshot } from "../api/marketModels.js";

export interface Liquidity {
  long: number;
  short: number;
}

/** Max additional notional (USDC) per side given all OI constraints. */
export function availableLiquidity(args: {
  maxOpenInterest: number;
  totalOi: number;
  maxGroupOi: number;
  groupOi: number;
  maxWalletOi: number;
  walletOi: number;
  groupOpenInterestPercentageP: number;
  maxLongOiP: number;
  maxShortOiP: number;
  pairMaxOi: number;
  longOi: number;
  shortOi: number;
  liquidityBuy: number;
  liquiditySell: number;
}): Liquidity {
  const maxOpenLeft = Math.max(args.maxOpenInterest - args.totalOi, 0);
  const groupLeft = Math.max(args.maxGroupOi - args.groupOi, 0);
  const walletLeft = Math.max(args.maxWalletOi - args.walletOi, 0);

  const validLong =
    ((args.maxGroupOi * args.groupOpenInterestPercentageP) / 100) * (args.maxLongOiP / 100);
  const pairLongLeft = Math.min(
    Math.max(args.pairMaxOi - args.longOi - args.shortOi, 0),
    Math.max(validLong - args.longOi, 0),
  );
  const validShort =
    ((args.maxGroupOi * args.groupOpenInterestPercentageP) / 100) * (args.maxShortOiP / 100);
  const pairShortLeft = Math.min(
    Math.max(args.pairMaxOi - args.longOi - args.shortOi, 0),
    Math.max(validShort - args.shortOi, 0),
  );

  return {
    long: Math.max(
      Math.min(maxOpenLeft, groupLeft, walletLeft, pairLongLeft, args.liquidityBuy),
      0,
    ),
    short: Math.max(
      Math.min(maxOpenLeft, groupLeft, walletLeft, pairShortLeft, args.liquiditySell),
      0,
    ),
  };
}

/**
 * Max notional for a new position from live snapshot models; `walletOi` is
 * the trader's current total notional (sum of collateral * leverage).
 */
export function maxPositionSize(
  pairInfo: PairInfo,
  snapshot: TradingSnapshot,
  args: { isLong: boolean; walletOi?: number },
): number {
  const group = snapshot.groupInfo?.[String(pairInfo.groupIndex ?? 0)];
  const liq = availableLiquidity({
    maxOpenInterest: snapshot.maxOpenInterest ?? 0,
    totalOi: snapshot.totalOi ?? 0,
    maxGroupOi: group?.groupMaxOI ?? 0,
    groupOi: group?.groupOI ?? 0,
    maxWalletOi: pairInfo.maxWalletOI ?? 0,
    walletOi: args.walletOi ?? 0,
    groupOpenInterestPercentageP: pairInfo.values?.groupOpenInterestPercentageP ?? 100,
    maxLongOiP: pairInfo.values?.maxLongOiP ?? 100,
    maxShortOiP: pairInfo.values?.maxShortOiP ?? 100,
    pairMaxOi: pairInfo.pairMaxOI ?? 0,
    longOi: pairInfo.openInterest?.long ?? 0,
    shortOi: pairInfo.openInterest?.short ?? 0,
    liquidityBuy: pairInfo.liquidity?.buy ?? Number.POSITIVE_INFINITY,
    liquiditySell: pairInfo.liquidity?.sell ?? Number.POSITIVE_INFINITY,
  });
  return args.isLong ? liq.long : liq.short;
}
