/** Market data: pair catalog snapshot (data API) and prices (feed-v3). */

import type { VerantaConfig } from "../config.js";
import { ApiError, ConfigError } from "../errors.js";
import type { HttpTransport } from "../transport.js";
import { type Num, toApiNum } from "../types.js";
import {
  type PairInfo,
  type TradingSnapshot,
  baseSymbol,
  isUpside,
  pairBySymbol,
  pairSymbol,
  snapshotPairs,
} from "./marketModels.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * risk-engine v2 spread OrderType enum (proto/risk-engine.proto). Note this
 * is NOT the trade OrderType enum: stop-limit maps onto LIMIT here (the UI
 * sends 1 for both limit flavors).
 */
export const SPREAD_ORDER_TYPES: Record<string, number> = {
  market: 0,
  limit: 1,
  stop_limit: 1,
  tp: 2,
  sl: 3,
  liquidation: 4,
};

/** Human number -> 1e10 integer string via exact decimal arithmetic. */
function toRaw10(value: Num): string {
  const text = toApiNum(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) throw new ApiError(`not a number: ${text}`);
  const [, sign, intPart, fracPart = "", expPart] = match;
  const digits = `${intPart}${fracPart}`;
  const exponent = (expPart ? Number.parseInt(expPart, 10) : 0) - fracPart.length + 10;
  const raw =
    exponent >= 0
      ? BigInt(digits) * 10n ** BigInt(exponent)
      : BigInt(digits) / 10n ** BigInt(-exponent);
  return `${sign === "-" ? "-" : ""}${raw}`;
}

function fromRaw10(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1e10 : null;
}

export interface SpreadQuote {
  /** The quoted spread percent: with-flow when available, else without-flow. */
  spreadPct: number;
  spreadPctWithoutFlow: number | null;
  estimatedSpreadPctWithFlow: number | null;
  spreadMechanism?: string;
  byPass?: boolean;
  flowParams?: Record<string, unknown>;
  [key: string]: unknown;
}

export class MarketsApi {
  /** Snapshot cache TTL in ms. */
  snapshotTtlMs = 5_000;

  private snapshotCache: TradingSnapshot | null = null;
  private snapshotAt = 0;

  constructor(
    private readonly cfg: VerantaConfig,
    private readonly transport: HttpTransport,
  ) {}

  // ------------------------------------------------------------------ snapshot

  /** Full /v2/trading snapshot (cached for snapshotTtlMs). */
  async snapshot(options: { force?: boolean } = {}): Promise<TradingSnapshot> {
    const now = Date.now();
    if (
      options.force ||
      this.snapshotCache === null ||
      now - this.snapshotAt > this.snapshotTtlMs
    ) {
      const data = await this.transport.json("GET", `${this.cfg.dataApiUrl}/v2/trading`);
      const payload = data && typeof data === "object" && "data" in data ? data.data : data;
      this.snapshotCache = { pairInfos: {}, ...payload } as TradingSnapshot;
      this.snapshotAt = now;
    }
    return this.snapshotCache;
  }

  /** Pairs keyed by index. */
  async pairs(): Promise<Map<number, PairInfo>> {
    return snapshotPairs(await this.snapshot());
  }

  /** Resolve a pair by symbol ("ETH/USD", "eth", "BTC_UPSIDE") or index. */
  async pair(ref: string | number): Promise<PairInfo> {
    const snapshot = await this.snapshot();
    if (typeof ref === "number") {
      const info = snapshotPairs(snapshot).get(ref);
      if (!info) throw new ApiError(`unknown pair index ${ref}`);
      return info;
    }
    return pairBySymbol(snapshot, ref);
  }

  async pairIndex(symbol: string): Promise<number> {
    return (await this.pair(symbol)).index;
  }

  /**
   * Upside markets only (separate pairs carrying the `_UPSIDE` suffix,
   * e.g. BTC_UPSIDE/USD). These take the PnL order type automatically.
   */
  async upsidePairs(): Promise<Map<number, PairInfo>> {
    const pairs = await this.pairs();
    return new Map([...pairs].filter(([, p]) => isUpside(p)));
  }

  /**
   * The Upside twin of a fixed-fee market ("BTC/USD" -> BTC_UPSIDE/USD).
   *
   * Matched like the Veranta UI: same symbols after stripping the `_UPSIDE`
   * suffix (plus the shared price feed as a sanity check). Passing an
   * upside pair returns it unchanged. Throws when the market has no upside
   * listing.
   */
  async upsidePairFor(base: string | number): Promise<PairInfo> {
    const info = await this.pair(base);
    if (isUpside(info)) return info;
    for (const candidate of (await this.pairs()).values()) {
      if (!isUpside(candidate)) continue;
      if (baseSymbol(candidate).toUpperCase() !== pairSymbol(info).toUpperCase()) continue;
      const sameFeed =
        !info.feed?.feedId || !candidate.feed?.feedId || candidate.feed.feedId === info.feed.feedId;
      if (sameFeed) return candidate;
    }
    throw new ApiError(`pair ${pairSymbol(info)} has no Upside market`);
  }

  // ------------------------------------------------------------------ prices

  /**
   * Latest executable spot for a pair (Lazer/pro, else Hermes/core).
   *
   * Reads feed-v3 `/v2/pairs/{index}/price-update-data`, the same signed
   * update the keeper posts on-chain. Do NOT use
   * `GET /v1/price-feeds/last-price` as a trade reference: that endpoint
   * returns a stale candle, so signing it as `wantedPrice` trips on-chain
   * `HighSlippage`.
   */
  async price(pair: string | number): Promise<number> {
    const data = await this.priceUpdateData(pair);
    const payload = data && typeof data === "object" && "data" in data ? (data as any).data : data;
    for (const legName of ["pro", "core"] as const) {
      const leg = payload?.[legName];
      if (!leg || typeof leg !== "object") continue;
      const px = leg.price;
      if (px === null || px === undefined || px === "" || px === 0 || px === "0") continue;
      return Number(px);
    }
    const info = await this.pair(pair);
    throw new ApiError(`no live price for pair ${pairSymbol(info)}`);
  }

  /** Pyth price update bytes (core + pro) for on-chain calls. */
  async priceUpdateData(pair: string | number): Promise<any> {
    const info = await this.pair(pair);
    return await this.transport.json(
      "GET",
      `${this.cfg.feedUrl}/v2/pairs/${info.index}/price-update-data`,
    );
  }

  /**
   * Quoted spread from the risk-engine v2 spread API (`POST /spread`).
   *
   * The engine is sized by COIN exposure: pass `coinSize` (base-asset
   * units) directly, or `collateral` + `leverage` and it is derived as
   * `collateral * leverage / price` (`wantedPrice` if given, else the live
   * feed price), the same conversion the UI applies.
   *
   * `orderType` is the risk-engine enum (`market`/`limit`/`tp`/`sl`/
   * `liquidation`; `limit` also covers stop-limit) or its int value.
   *
   * Error semantics (surfaced as ApiError): 400 = malformed request, 403 =
   * spread blocked (roll window / closed market / wallet), 404 = mechanism
   * matched but no spread computable; treat as "do not execute", never as
   * zero spread.
   */
  async spread(
    pair: string | number,
    args: {
      isLong: boolean;
      coinSize?: Num;
      collateral?: Num;
      leverage?: Num;
      isOpen?: boolean;
      orderType?: number | string;
      wantedPrice?: Num;
      trader?: string;
    },
  ): Promise<SpreadQuote> {
    const info = await this.pair(pair);

    let coinSize = args.coinSize;
    if (coinSize === undefined) {
      if (args.collateral === undefined || args.leverage === undefined) {
        throw new ApiError("spread() needs coinSize or collateral+leverage");
      }
      const refPrice =
        args.wantedPrice !== undefined ? Number(args.wantedPrice) : await this.price(info.index);
      if (!(refPrice > 0)) throw new ApiError(`no reference price for pair ${pairSymbol(info)}`);
      coinSize = (Number(args.collateral) * Number(args.leverage)) / refPrice;
    }

    const orderType = args.orderType ?? "market";
    let orderTypeInt: number;
    if (typeof orderType === "string") {
      const mapped = SPREAD_ORDER_TYPES[orderType.toLowerCase()];
      if (mapped === undefined) {
        throw new ApiError(
          `unknown spread orderType ${JSON.stringify(orderType)}; use one of ` +
            Object.keys(SPREAD_ORDER_TYPES).sort().join(", "),
        );
      }
      orderTypeInt = mapped;
    } else {
      orderTypeInt = orderType;
    }

    const body: Record<string, unknown> = {
      pairIndex: info.index,
      // trader is required (checksummed); the zero address matches the
      // UI's anonymous-quote fallback.
      trader: args.trader ?? ZERO_ADDRESS,
      coinSize10: toRaw10(coinSize),
      isLong: args.isLong,
      isOpen: args.isOpen ?? true,
      orderType: orderTypeInt,
    };
    if (args.wantedPrice !== undefined) body.wantedPrice10 = toRaw10(args.wantedPrice);

    const data = await this.transport.json("POST", `${this.cfg.riskV2ApiUrl}/spread`, {
      json: body,
    });

    const out: SpreadQuote = {
      ...data,
      spreadPct: 0,
      spreadPctWithoutFlow: null,
      estimatedSpreadPctWithFlow: null,
    };
    const withoutFlow = fromRaw10(data?.spreadPctWithoutFlow10);
    const withFlow = fromRaw10(data?.estimatedSpreadPctWithFlow10);
    out.spreadPctWithoutFlow = withoutFlow;
    out.estimatedSpreadPctWithFlow = withFlow;
    const quoted = withFlow ?? withoutFlow;
    out.spreadPct = quoted ?? 0;
    return out;
  }

  /**
   * Live per-pair long/short OI incl. pending amounts and the market-maker
   * breakdown (core `GET /v2/open-interests`).
   */
  async openInterests(): Promise<any> {
    return await this.transport.json("GET", `${this.cfg.coreApiUrl}/v2/open-interests`);
  }

  /**
   * Cumulative bid/ask coin liquidity per pair and orderbook source
   * (risk-engine v2 `GET /orderbook/snapshots`); `ageMs` flags staleness.
   */
  async orderbookSnapshots(): Promise<any> {
    return await this.transport.json("GET", `${this.cfg.riskV2ApiUrl}/orderbook/snapshots`);
  }

  /**
   * LEGACY risk-engine dynamic spread (`GET /v2/dynamic-spread`).
   *
   * Testnet-only since the 2026-08-12 mainnet cutover; production quotes
   * come from {@link spread}. `isUpside` quotes the Upside (PnL) spread
   * curve (wire param `isPnl`).
   */
  async dynamicSpread(
    pair: string | number,
    args: {
      collateral: number;
      leverage: number;
      isLong: boolean;
      isUpside?: boolean;
      trader?: string;
    },
  ): Promise<any> {
    if (!this.cfg.riskApiUrl) {
      throw new ConfigError(
        "The legacy risk engine is not deployed on this network (decommissioned " +
          "on mainnet at the v2 cutover); use markets.spread(), or set " +
          "VERANTA_RISK_API_URL to override.",
      );
    }
    const info = await this.pair(pair);
    const precision = 18;
    const params: Record<string, unknown> = {
      collateralUsdc: args.collateral,
      isLong: String(args.isLong),
      leverage: args.leverage,
      isPnl: String(args.isUpside ?? false),
      precision,
    };
    if (args.trader) params.trader = args.trader;
    const data = await this.transport.json(
      "GET",
      `${this.cfg.riskApiUrl}/v2/dynamic-spread/${info.index}`,
      { params },
    );
    const scale = 10 ** precision;
    const descale = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed / scale : value;
    };
    const out = { ...data };
    if ("dynamicSpreadPct" in out) out.dynamicSpreadPct = descale(out.dynamicSpreadPct);
    out.metadata = Object.fromEntries(
      Object.entries(out.metadata ?? {}).map(([k, v]) => [k, descale(v)]),
    );
    return out;
  }

  /** OHLCV candles via the feed-v3 TradingView shim. */
  async candles(symbol: string, resolution: string, start: number, end: number): Promise<any> {
    return await this.transport.json("GET", `${this.cfg.feedUrl}/v1/shims/tradingview/history`, {
      params: { symbol, resolution, from: start, to: end },
    });
  }
}
