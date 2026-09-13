/**
 * Models for the data API /v2/trading snapshot (human units).
 *
 * Interfaces describe the raw API JSON; helper functions derive the values
 * the Python SDK exposed as properties. Unknown fields are preserved (the
 * snapshot is rich; only load-bearing fields are typed).
 */

import { ApiError } from "../errors.js";

/**
 * Upside pairs (formerly "ZFP"/zero-fee) are listed as separate markets
 * whose base or quote symbol carries this suffix (BTC_UPSIDE/USD,
 * USD/JPY_UPSIDE).
 */
export const UPSIDE_SUFFIX = "_UPSIDE";

/** "BTC_UPSIDE" -> "BTC"; non-upside symbols pass through unchanged. */
export function stripUpsideSuffix(symbol: string): string {
  return symbol.toUpperCase().endsWith(UPSIDE_SUFFIX)
    ? symbol.slice(0, -UPSIDE_SUFFIX.length)
    : symbol;
}

export interface Leverages {
  minLeverage?: number;
  maxLeverage?: number;
  pnlMinLeverage?: number;
  pnlMaxLeverage?: number;
  [key: string]: unknown;
}

export interface OpenInterest {
  long?: number;
  short?: number;
  [key: string]: unknown;
}

export interface FundingRate {
  long?: number;
  short?: number;
  [key: string]: unknown;
}

export interface FeedAttributes {
  symbol?: string;
  assetType?: string;
  isOpen?: boolean;
  nextOpen?: number;
  nextClose?: number;
  schedule?: string;
  [key: string]: unknown;
}

export interface Feed {
  feedId?: string;
  attributes?: FeedAttributes;
  [key: string]: unknown;
}

export interface LazerFeed {
  feedId?: number;
  exponent?: number;
  state?: string;
  [key: string]: unknown;
}

export interface PairValues {
  maxGainP?: number;
  maxSlP?: number;
  maxLongOiP?: number;
  maxShortOiP?: number;
  maxWalletOI?: number;
  groupOpenInterestPercentageP?: number;
  [key: string]: unknown;
}

export interface PnlFees {
  numTiers?: number;
  tierP?: number[];
  feesP?: number[];
  [key: string]: unknown;
}

export interface TwapParams {
  minRunTime?: number;
  maxRunTime?: number;
  frequency?: number;
  twapFee?: number;
  [key: string]: unknown;
}

export interface AdditionalPairParams2 {
  openMakerFeeP?: number;
  closeMakerFeeP?: number;
  openTakerFeeP?: number;
  closeTakerFeeP?: number;
  closeOnlyMode?: boolean;
  [key: string]: unknown;
}

/**
 * On-chain pair params (TradingStorage). `isPnlTypeAllowed` gates the Upside
 * (PnL) order type: the contract reverts `PnlOrderNotAllowed` unless it
 * matches the order's `_type`, so it must be 1 on upside pairs and the order
 * type plain market everywhere else.
 */
export interface StoragePairParams {
  isPnlTypeAllowed?: number;
  posSpreadCap?: number;
  negSpreadCap?: number;
  pnlPosSpreadCap?: number;
  pnlNegSpreadCap?: number;
  [key: string]: unknown;
}

export interface PairInfo {
  index: number;
  from: string;
  to: string;
  groupIndex?: number;
  isPairListed?: boolean;
  leverages?: Leverages;
  spreadP?: number;
  pnlSpreadP?: number;
  openFeeP?: number;
  closeFeeP?: number;
  minLevPosUSDC?: number;
  openInterest?: OpenInterest;
  coinOI?: OpenInterest;
  pairOI?: number;
  pairMaxOI?: number;
  maxWalletOI?: number;
  marginFee?: FundingRate;
  fundingRate?: FundingRate;
  fundingFeePerHourP?: number;
  feed?: Feed;
  lazerFeed?: LazerFeed | null;
  values?: PairValues;
  pnlFees?: PnlFees;
  lossProtectionMultiplier?: Record<string, number>;
  longSkewConfig?: Record<string, number>;
  shortSkewConfig?: Record<string, number>;
  skewEqParams?: number[][];
  pairTwapParams?: TwapParams;
  additionalPairParams2?: AdditionalPairParams2;
  storagePairParams?: StoragePairParams;
  liquidity?: Record<string, number>;
  [key: string]: unknown;
}

export interface GroupInfo {
  name?: string;
  groupMaxOI?: number;
  groupOI?: number;
  [key: string]: unknown;
}

export interface TradingSnapshot {
  dataVersion?: number;
  pairCount?: number;
  maxTradesPerPair?: number;
  totalOi?: number;
  maxOpenInterest?: number;
  pairInfos: Record<string, PairInfo>;
  groupInfo?: Record<string, GroupInfo>;
  [key: string]: unknown;
}

/** "ETH/USD" for a pair. */
export function pairSymbol(info: PairInfo): string {
  return `${info.from}/${info.to}`;
}

/**
 * True for Upside markets (BTC_UPSIDE/USD, USD/JPY_UPSIDE, ...).
 *
 * Same convention as the Avantis UI: the `_UPSIDE` suffix on either symbol.
 * Upside pairs take ONLY the PnL order type (market_pnl) and are
 * market-only: no limit/stop opens, no TWAP.
 */
export function isUpside(info: PairInfo): boolean {
  return (
    info.from.toUpperCase().endsWith(UPSIDE_SUFFIX) || info.to.toUpperCase().endsWith(UPSIDE_SUFFIX)
  );
}

/** The pair symbol with any `_UPSIDE` suffix stripped ("BTC_UPSIDE/USD" -> "BTC/USD"). */
export function baseSymbol(info: PairInfo): string {
  return `${stripUpsideSuffix(info.from)}/${stripUpsideSuffix(info.to)}`;
}

/** Market-hours check (forex/commodity groups use the feed schedule). */
export function isMarketOpen(info: PairInfo, nowSeconds = Date.now() / 1000): boolean {
  const group = info.groupIndex ?? 0;
  if (group !== 2 && group !== 3 && group !== 6) return true;
  const attrs = info.feed?.attributes ?? {};
  const isOpen =
    (attrs.isOpen ?? true) || ((attrs.nextOpen ?? 0) > 0 && nowSeconds > (attrs.nextOpen ?? 0));
  const beforeClose = (attrs.nextClose ?? 0) === 0 || nowSeconds < (attrs.nextClose ?? 0);
  return isOpen && beforeClose;
}

/** Pairs keyed by index. */
export function snapshotPairs(snapshot: TradingSnapshot): Map<number, PairInfo> {
  const map = new Map<number, PairInfo>();
  for (const info of Object.values(snapshot.pairInfos)) map.set(info.index, info);
  return map;
}

function normalizeSymbol(ref: string): [string, string] {
  const cleaned = ref.toUpperCase().replace(/-/g, "/").replace(/_/g, "/");
  if (!cleaned.includes("/")) return [cleaned, "USD"];
  const [base, ...rest] = cleaned.split("/");
  return [base!, rest.join("/")];
}

/**
 * Resolve "ETH/USD", "eth-usd", "ETH", "BTC_UPSIDE", "USD/JPY_UPSIDE".
 *
 * Exact from/to matching runs first with underscores preserved (upside
 * symbols contain them), then a bare-base match (quote defaults to USD),
 * and finally the legacy `-`/`_` -> `/` rewrite.
 */
export function pairBySymbol(snapshot: TradingSnapshot, ref: string): PairInfo {
  const cleaned = ref.trim().toUpperCase();
  const pairs = Object.values(snapshot.pairInfos);
  for (const info of pairs) {
    if (pairSymbol(info).toUpperCase() === cleaned) return info;
  }
  const baseMatches = pairs.filter((p) => p.from.toUpperCase() === cleaned);
  for (const info of baseMatches) {
    if (info.to.toUpperCase() === "USD") return info;
  }
  if (baseMatches.length === 1) return baseMatches[0]!;
  const [base, quote] = normalizeSymbol(ref);
  for (const info of pairs) {
    if (info.from.toUpperCase() === base && info.to.toUpperCase() === quote) return info;
  }
  throw new ApiError(`unknown pair ${JSON.stringify(ref)}`);
}
