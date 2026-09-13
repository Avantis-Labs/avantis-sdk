/**
 * Models for the core API `/user-data` payloads: interfaces describe the raw
 * on-chain-scale JSON; helper functions convert to human units (mirroring
 * the Python models' properties, including the exact floor-division math).
 */

import { from1e10, fromUsdc } from "../types.js";

/** OffchainOrderDto.orderType values (backend LimitOrder enum). */
const TRIGGER_KINDS: Record<number, string> = {
  0: "tp",
  1: "sl",
  2: "liq",
  3: "open",
  4: "partial_tp",
  5: "partial_sl",
};

/**
 * One entry of a position's `priceTriggers`.
 *
 * Two flavors share the shape (backend OffchainOrderDto):
 *
 * - `isGlobal` true: the position's global on-chain TP/SL. Synthetic
 *   deterministic `entityId` (`global-tp-{trader}-{pairIndex}-{index}` /
 *   `global-sl-...`); change or remove via `trade.updateTpSl()`.
 *   `coinSize` is the full position size.
 * - `isGlobal` false: an off-chain partial TP/SL signed intent; its
 *   `entityId` works with `trade.updatePartialTpSl()` /
 *   `cancelPartialTpSl()`. NOTE: a DB-backed entityId changes on every
 *   update (the response's `newEntityId` replaces it); global ids are
 *   stable.
 */
export interface PriceTrigger {
  entityId: string;
  trader?: string;
  pairIndex?: number;
  index?: number;
  isGlobal?: boolean;
  orderType?: number;
  triggerType?: number;
  buy?: boolean;
  /** 1e10 coin units (decimal string). */
  coinSize?: string;
  /** 1e10 price (decimal string). */
  price?: string;
  percentage?: string;
  finalTriggerPrice?: string;
  timestamp?: number;
  signTimestamp?: number;
  [key: string]: unknown;
}

/** "tp" / "sl" / "partial_tp" / "partial_sl" (from the orderType enum). */
export function triggerKind(trigger: PriceTrigger): string {
  const orderType = trigger.orderType ?? 0;
  return TRIGGER_KINDS[orderType] ?? String(orderType);
}

export function triggerCoinSize(trigger: PriceTrigger): number {
  return from1e10(trigger.coinSize ?? "0");
}

export function triggerPrice(trigger: PriceTrigger): number {
  return from1e10(trigger.price ?? "0");
}

export interface Position {
  trader: string;
  pairIndex: number;
  index: number;
  buy: boolean;
  /**
   * True when the position lives on an Upside pair (wire field `isPnl`): it
   * was opened with the PnL order type and pays a profit share instead of
   * fixed fees.
   */
  isPnl?: boolean;
  /** 1e6 USDC (decimal string). */
  collateral: string;
  /** 1e10 (decimal string). */
  leverage: string;
  /** 1e10 (decimal string). */
  openPrice: string;
  tp?: string;
  sl?: string;
  liquidationPrice?: string;
  rolloverFee?: string;
  unrealisedFundingFee?: string;
  lossProtection?: string;
  openedAt?: number;
  /**
   * All TP/SL triggers: global on-chain ones (`isGlobal` true) plus
   * off-chain partial orders.
   */
  priceTriggers?: PriceTrigger[];
  /**
   * Base ("from") asset of the pair with any `_UPSIDE` suffix stripped,
   * e.g. "BTC" for BTC_UPSIDE/USD or "USD" for USD/JPY. Not part of the
   * core API payload; populated by `account.positions()` from the markets
   * pair catalog.
   */
  baseSymbol?: string;
  [key: string]: unknown;
}

export interface LimitOrder {
  trader: string;
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral?: string;
  positionSize?: string;
  price?: string;
  leverage?: string;
  tp?: string;
  sl?: string;
  slippageP?: string;
  block?: number;
  [key: string]: unknown;
}

export interface UserData {
  positions: Position[];
  limitOrders: LimitOrder[];
  [key: string]: unknown;
}

// -- helpers (human units) ---------------------------------------------------

export function positionSide(position: Position): "long" | "short" {
  return position.buy ? "long" : "short";
}

export function positionCollateral(position: Position): number {
  return fromUsdc(position.collateral);
}

export function positionLeverage(position: Position): number {
  return from1e10(position.leverage);
}

export function positionOpenPrice(position: Position): number {
  return from1e10(position.openPrice);
}

export function positionTp(position: Position): number {
  return from1e10(position.tp ?? "0");
}

export function positionSl(position: Position): number {
  return from1e10(position.sl ?? "0");
}

export function positionLiquidationPrice(position: Position): number {
  return from1e10(position.liquidationPrice ?? "0");
}

export function positionRolloverFee(position: Position): number {
  return fromUsdc(position.rolloverFee ?? "0");
}

export function positionUnrealisedFundingFee(position: Position): number {
  return fromUsdc(position.unrealisedFundingFee ?? "0");
}

/**
 * Notional in USDC (collateral * leverage), floored to 1e6 units as on-chain
 * (`PositionMath.scaleByLeverage`).
 */
export function positionNotional(position: Position): number {
  const raw = (BigInt(position.collateral) * BigInt(position.leverage)) / 10n ** 10n;
  return fromUsdc(raw);
}

/**
 * Position size in the base asset (collateral * leverage / open price).
 *
 * Mirrors the contracts' integer math (PositionMath.sol) so the value
 * matches on-chain coin exposure exactly: the leveraged position is floored
 * to 1e6 USDC units (`scaleByLeverage`), then converted with two sequential
 * floor divisions to 1e10 coin units (`usdcToCoinAtPrice`). Plain float
 * division can disagree in the last digits because the chain rounds down at
 * each step.
 *
 * For USD-base pairs (USD/JPY, USD/CHF, ...) the USDC notional already IS
 * the base-asset size, so no division by the open price. This relies on
 * `baseSymbol` (set by `account.positions()`); when it is missing the usual
 * quote-USD convention is assumed.
 */
export function positionSizeInAsset(position: Position): number {
  // scaleByLeverage: collateral (1e6) * leverage (1e10) / 1e10 -> 1e6
  const levPosRaw = (BigInt(position.collateral) * BigInt(position.leverage)) / 10n ** 10n;
  if (position.baseSymbol !== undefined && position.baseSymbol.toUpperCase() === "USD") {
    return fromUsdc(levPosRaw);
  }
  const priceRaw = BigInt(position.openPrice);
  if (priceRaw === 0n) return 0;
  // usdcToCoinAtPrice: a * PRICE_PRECISION * COIN_OI_PRECISION / price
  // / USDC_PRECISION, floor at each division -> 1e10 coin units
  const coinRaw = (levPosRaw * 10n ** 10n * 10n ** 10n) / priceRaw / 10n ** 6n;
  return from1e10(coinRaw);
}

/** The on-chain TP/SL (read-only entries; change via trade.updateTpSl). */
export function globalTriggers(position: Position): PriceTrigger[] {
  return (position.priceTriggers ?? []).filter((t) => t.isGlobal);
}

/** Off-chain partial TP/SL orders (entityId works with the CRUD). */
export function partialTriggers(position: Position): PriceTrigger[] {
  return (position.priceTriggers ?? []).filter((t) => !t.isGlobal);
}

export function findPosition(
  userData: UserData,
  pairIndex: number,
  index: number,
): Position | undefined {
  return userData.positions.find((p) => p.pairIndex === pairIndex && p.index === index);
}

// -- limit orders -------------------------------------------------------------

export function limitOrderSide(order: LimitOrder): "long" | "short" {
  return order.buy ? "long" : "short";
}

export function limitOrderPrice(order: LimitOrder): number {
  return from1e10(order.price ?? "0");
}

export function limitOrderLeverage(order: LimitOrder): number {
  return from1e10(order.leverage ?? "0");
}

export function limitOrderCollateral(order: LimitOrder): number {
  const raw =
    order.collateral && order.collateral !== "0" ? order.collateral : (order.positionSize ?? "0");
  return fromUsdc(raw);
}

/** Normalize a /user-data payload (fills missing arrays). */
export function toUserData(data: any): UserData {
  return {
    ...(data ?? {}),
    positions: data?.positions ?? [],
    limitOrders: data?.limitOrders ?? [],
  };
}
