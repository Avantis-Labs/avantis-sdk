/**
 * Core enums and shared models for the Veranta v2 SDK.
 *
 * Unit conventions:
 * - All SDK-facing amounts are HUMAN units: 100 = 100 USDC, 10 = 10x
 *   leverage, prices are plain decimals. The tx-builder API performs
 *   1e6/1e10 scaling.
 * - Raw on-chain values (from the core API or intent messages) are decimal
 *   strings; helpers below convert.
 */

import type { Address, Hex } from "viem";

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export const USDC_SCALE = 10n ** 6n;
/** Prices, leverage, slippage %, coin exposure. */
export const PRECISION_10 = 10n ** 10n;

/** Convert a raw 1e6 USDC value (decimal string / bigint) to human units. */
export function fromUsdc(raw: string | number | bigint): number {
  return Number(raw) / 1e6;
}

/** Convert a raw 1e10 value (price, leverage, ...) to human units. */
export function from1e10(raw: string | number | bigint): number {
  return Number(raw) / 1e10;
}

/**
 * Human-unit numeric input. Strings are preferred for exact decimals
 * (`"0.000001"`), numbers are fine for everyday values.
 */
export type Num = number | string | bigint;

/** Serialize a human-unit number for the API (string, exact decimal repr). */
export function toApiNum(value: Num): string {
  return String(value);
}

// ---------------------------------------------------------------------------
// Enums (string literal unions for ergonomic call sites)
// ---------------------------------------------------------------------------

export type ExecutionMode = "relayer" | "direct";

export type Side = "long" | "short";

export function isLong(side: Side): boolean {
  return side === "long";
}

/** Open order types (v2 enum: limit=2/MOMENTUM, stop_limit=1/REVERSAL). */
export type OrderType = "market" | "stop_limit" | "limit" | "market_pnl";

export type MarginAction = "deposit" | "withdraw";

export type TriggerType = "fixed" | "percentage";

/**
 * Order types understood by the operator relayer batch endpoints.
 * Mirrors avantis-ui-v2 lib/relayerEip712.ts.
 */
export const AggregatorOrderType = {
  MARKET_OPEN: 0,
  MARKET_CLOSE: 1,
  LIMIT_OPEN: 2,
  LIMIT_CLOSE: 3,
  UPDATE_MARGIN: 4,
  UPDATE_SL: 5,
  MARKET_OPEN_PNL: 6,
  MARKET_CLOSE_PNL: 7,
  LIMIT_CLOSE_PNL: 8,
  INCREASE_SIZE: 9,
  DECREASE_SIZE: 10,
  LIMIT_PARTIAL_CLOSE: 11,
  MARKET_OPEN_WITH_COIN_EXPOSURE: 12,
  MARKET_OPEN_PNL_WITH_COIN_EXPOSURE: 13,
  INCREASE_SIZE_WITH_COIN_EXPOSURE: 14,
  MARKET_CLOSE_WITH_COIN_EXPOSURE: 15,
  MARKET_CLOSE_PNL_WITH_COIN_EXPOSURE: 16,
} as const;

export type AggregatorOrderType = (typeof AggregatorOrderType)[keyof typeof AggregatorOrderType];

/**
 * Intent kinds the batched-market endpoint consumes. TWAP/RFQ initiation and
 * TP/SL use different transports (twap-app intents / core-API
 * price-triggers), and delegate/referral sigs are relayed as *WithSig
 * calldata.
 */
export const BATCHED_MARKET_INTENT_KINDS: ReadonlySet<string> = new Set([
  "OpenTradeReq",
  "OpenTradeCoinExposureReq",
  "CloseTradeReq",
  "CloseTradeCoinExposureReq",
  "IncreasePositionSizeReq",
  "IncreasePositionSizeWithCoinExposureReq",
]);

/**
 * The batched-market endpoint's allow-list. Membership routes an intent to
 * POST /market/execute-batched. Global TP/SL goes through the core API
 * price-triggers endpoint instead.
 */
export const BATCHED_MARKET_ORDER_TYPES: ReadonlySet<AggregatorOrderType> =
  new Set<AggregatorOrderType>([
    AggregatorOrderType.MARKET_OPEN,
    AggregatorOrderType.MARKET_OPEN_PNL,
    AggregatorOrderType.MARKET_OPEN_WITH_COIN_EXPOSURE,
    AggregatorOrderType.MARKET_OPEN_PNL_WITH_COIN_EXPOSURE,
    AggregatorOrderType.MARKET_CLOSE,
    AggregatorOrderType.MARKET_CLOSE_PNL,
    AggregatorOrderType.MARKET_CLOSE_WITH_COIN_EXPOSURE,
    AggregatorOrderType.MARKET_CLOSE_PNL_WITH_COIN_EXPOSURE,
    AggregatorOrderType.INCREASE_SIZE,
    AggregatorOrderType.INCREASE_SIZE_WITH_COIN_EXPOSURE,
  ]);

// ---------------------------------------------------------------------------
// tx-builder payload models
// ---------------------------------------------------------------------------

/** Direct-route transaction payload from the tx-builder API. */
export interface CallData {
  to: Address;
  from: Address;
  data: Hex;
  /** 0x-hex wei (usually "0x0"; oracle fees for margin updates). */
  value: string;
  chainId: number;
  description?: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export function callDataValueWei(cd: CallData): bigint {
  return cd.value ? BigInt(cd.value) : 0n;
}

export type Eip712Field = { name: string; type: string };

/** EIP-712 intent payload from the tx-builder API (relayer route). */
export interface IntentPayload {
  intent: string;
  signerRule: "trader-or-delegate" | "trader-only";
  domain: {
    name: string;
    version: string;
    chainId: number | string;
    verifyingContract: Address;
  };
  primaryType: string;
  /** Types WITHOUT EIP712Domain (viem convention); uints as decimal strings. */
  types: Record<string, Eip712Field[]>;
  message: Record<string, any>;
  digest: Hex;
  /** abi.encode of the struct, becomes `userIntent` for operator entry points. */
  encodedIntent: Hex;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Best-effort pairIndex extraction for the relayer batch payload. */
export function intentPairIndex(payload: IntentPayload): number {
  const msg = payload.message;
  for (const key of ["pairIndex", "_pairIndex"]) {
    if (key in msg) return Number(msg[key]);
  }
  const inner = msg._t ?? msg._updateInfo ?? {};
  if ("pairIndex" in inner) return Number(inner.pairIndex);
  throw new Error(`pairIndex not found in intent message for ${payload.intent}`);
}

/** An intent payload plus the local signature over its digest. */
export interface SignedIntent {
  payload: IntentPayload;
  /** 0x-hex 65-byte r||s||v. */
  signature: Hex;
  /** Address that produced the signature. */
  signer: Address;
}

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export interface RelayStatus {
  settled: boolean;
  success?: boolean;
  txHash?: string;
  errorMessage?: string;
  receipt?: Record<string, unknown>;
}

export type ExecutionRoute =
  | "batched-market"
  | "price-triggers"
  | "relayer-passthrough"
  | "twap-api"
  | "rpc"
  | "wallet"
  | "txbuilder-relay";

/** Uniform result of submitting an action through any route. */
export interface ExecutionReceipt {
  route: ExecutionRoute;
  txHash?: string;
  requestId?: string;
  /** batched-market lifecycle id (status replay). */
  trackingId?: string;
  /** On-chain order id from the initiation event. */
  orderId?: number;
  description?: string;
  raw?: Record<string, unknown>;
}
