/**
 * User-facing trading surface.
 *
 * Every method follows the same recipe:
 * 1. Resolve the pair against the markets catalog (symbol or index; the
 *    tx-builder always receives the resolved `pairIndex`).
 * 2. Build the payload via tx-builder (intent for the relayer route,
 *    calldata for the direct route / passthrough).
 * 3. Route through the ExecutionEngine.
 *
 * All amounts are human units (100 = 100 USDC, 10 = 10x). `pair` accepts
 * either a symbol ("ETH/USD", "eth-usd", "BTC_UPSIDE") or a pair index.
 *
 * Upside markets (separate pairs suffixed `_UPSIDE`, formerly branded
 * ZFP/zero-fee) route automatically: opens/closes on an upside pair take
 * the PnL order type; there is no flag to pass. The pair fully determines
 * the type (the contract reverts `PnlOrderNotAllowed` on any mismatch),
 * which also means upside pairs are market-only: no limit/stop opens and no
 * TWAP.
 */

import type { VerantaConfig } from "../config.js";
import { ApiError, ConfigError, RelayTimeoutError, ValidationError } from "../errors.js";
import type { BatchedMarketEventHook } from "../execution/batchedMarket.js";
import type { ExecutionEngine } from "../execution/engine.js";
import { LocalIntentBuilder } from "../execution/localIntents.js";
import { signIntent } from "../signing/intents.js";
import type { HttpTransport } from "../transport.js";
import type { TxBuilderClient } from "../txbuilder.js";
import {
  AggregatorOrderType,
  type ExecutionReceipt,
  type IntentPayload,
  type MarginAction,
  type Num,
  type OrderType,
  type Side,
  type TriggerType,
  from1e10,
} from "../types.js";
import { type Position, findPosition, toUserData } from "./accountModels.js";
import { ExecutingApi } from "./base.js";
import { type PairInfo, isUpside as pairIsUpside, pairSymbol } from "./marketModels.js";

export type PairRef = string | number;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TradeApi extends ExecutingApi {
  private local: LocalIntentBuilder | null = null; // lazy; for locally-built intents

  constructor(
    cfg: VerantaConfig,
    engine: ExecutionEngine,
    txb: TxBuilderClient,
    transport: HttpTransport,
    private readonly getPair: (ref: PairRef) => Promise<PairInfo>,
  ) {
    super(cfg, engine, txb, transport);
  }

  /**
   * Pair ref (symbol or index) -> PairInfo from the markets snapshot (5s
   * cache). Order-type routing derives from it (`isUpside`).
   */
  private async resolvePair(pair: PairRef): Promise<PairInfo> {
    return await this.getPair(pair);
  }

  private requireNotUpside(info: PairInfo, what: string): void {
    if (pairIsUpside(info)) {
      throw new ValidationError(
        `${what} is not available on Upside pairs (${pairSymbol(info)} is market-only: ` +
          "the contract accepts only the PnL market order type on it). Use " +
          "marketOpen/marketClose, or trade the fixed-fee pair instead.",
        { code: "UPSIDE_MARKET_ONLY" },
      );
    }
  }

  /**
   * Local builder for intents that need no chain state
   * (CancelOffchainOrder, TwapCancelReq, UpdateTpSlReq): the schema comes
   * from `signing/schema` (golden-vector proven), so building locally skips
   * a tx-builder round-trip.
   */
  private async localIntents(): Promise<LocalIntentBuilder> {
    if (this.local === null) {
      this.local = new LocalIntentBuilder(
        await this.engine.chainId(),
        await this.engine.tradingRouter(),
      );
    }
    return this.local;
  }

  /**
   * Per-order builder-fee params for the tx-builder, or `{}` when off.
   *
   * Active when `builderCode` is configured. The rate is the per-call
   * override, else `config.builderFeePercent` (percent of the order's
   * notional, 0.05 = 0.05%). Upside/PnL pairs never pay builder fees on
   * opens and increases, and the registry demands an explicit zero there,
   * so the rate is forced to 0 automatically. Closes keep the requested
   * rate (PnL closes are capped by the code's own PnL-close cap).
   */
  private builderParams(
    override: Num | undefined,
    args: { isUpside: boolean; action: "open" | "close" | "increase" },
  ): Record<string, unknown> {
    const code = this.cfg.builderCode;
    if (code === undefined) {
      if (override !== undefined) {
        throw new ConfigError(
          "builderFeePercent was passed but no builder code is configured. Set " +
            "builderCode (or VERANTA_BUILDER_CODE).",
        );
      }
      return {};
    }
    let rate = override ?? this.cfg.builderFeePercent;
    if (rate === undefined) {
      throw new ConfigError(
        "builderCode is configured without a fee rate. Set builderFeePercent " +
          "(config or per call); pass 0 to attach the code without charging.",
      );
    }
    if (args.isUpside && args.action !== "close") rate = 0;
    return { builderCode: code, builderFeeRate: rate };
  }

  /**
   * Builder-fee orders only charge when the type-4 relay runs the canonical
   * delegation template, which needs an EIP-7702 authorization signed by
   * the SDK's signer. A browser wallet (JSON-RPC account) cannot sign one:
   * `submitPassthrough` would fall back to a plain wallet transaction that
   * places the order and charges NO fee. Refuse up front instead — the
   * same reasoning as the direct-mode refusal in `submitMarket`.
   */
  private requireBuilderCapableSigner(): void {
    if (!this.engine.requireSigner().canSignAuthorization) {
      throw new ConfigError(
        "Builder fees need an EIP-7702-capable signer (private key or session key): the fee " +
          "is charged by the canonical delegation template inside a type-4 relay, and a " +
          "browser wallet cannot sign that authorization (a plain wallet transaction would " +
          "place the order without charging the fee). Trade through a session key " +
          "(useSessionKey / account.registerDelegate) or unset builderCode.",
      );
    }
  }

  /**
   * Route a market open/close/increase.
   *
   * Builder-fee orders must execute their EIP-7702 leg (the fee suffix
   * lives in the calldata; the signed intent carries no builder params), so
   * they relay straight through blitz — which also means they need a signer
   * that can sign EIP-7702 authorizations (requireBuilderCapableSigner).
   * Everything else keeps the batched-market path with its server-side
   * mechanism switch and SSE lifecycle. Direct mode sends a plain type-2 to
   * the router, which never runs the fee-charging template, so builder
   * params are refused there rather than silently charging nothing.
   */
  private async submitMarket(
    builder: Record<string, unknown>,
    calldataPath: string,
    intentPath: string,
    params: Record<string, unknown>,
    agg: AggregatorOrderType,
    options: {
      wait: boolean;
      onEvent?: BatchedMarketEventHook;
      intentExtra?: Record<string, unknown>;
    },
  ): Promise<ExecutionReceipt> {
    if (!this.engine.isRelayerMode) {
      if (Object.keys(builder).length > 0) {
        throw new ConfigError(
          "Builder fees require relayer mode: the fee is charged by the EIP-7702 " +
            "template, which a direct type-2 transaction never executes. Use " +
            "execution: 'relayer' or unset builderCode.",
        );
      }
      return await this.engine.submitDirect(await this.calldata(calldataPath, params), {
        wait: options.wait,
      });
    }
    if (Object.keys(builder).length > 0) {
      this.requireBuilderCapableSigner();
      const calldata = await this.calldata(calldataPath, params);
      return await this.engine.submitPassthrough(calldata, { wait: options.wait });
    }
    const intentParams = { ...params, ...(options.intentExtra ?? {}) };
    // The EIP-7702 leg only exists for signers that can produce
    // authorizations (local/session keys); browser wallets go intent-only,
    // so skip the calldata round-trip for them.
    const wantCalldata = this.engine.signer?.canSignAuthorization ?? false;
    if (wantCalldata) {
      const [intent, calldata] = await Promise.all([
        this.txb.intent(intentPath, intentParams),
        this.calldata(calldataPath, params),
      ]);
      return await this.engine.submitIntentBatch(intent, agg, {
        calldata,
        wait: options.wait,
        onEvent: options.onEvent,
      });
    }
    const intent = await this.txb.intent(intentPath, intentParams);
    return await this.engine.submitIntentBatch(intent, agg, {
      wait: options.wait,
      onEvent: options.onEvent,
    });
  }

  // ------------------------------------------------------------------ opens

  /**
   * Open a market position.
   *
   * Upside pairs (e.g. "BTC_UPSIDE") route automatically as PnL (Upside)
   * orders, no flag needed; fixed-fee pairs always send the plain market
   * type. `openPrice` is the reference price the fill is validated against
   * (± slippagePercent); resolved from the live feed when omitted.
   *
   * `builderFeePercent` overrides the configured builder fee rate for this
   * order (percent of notional; requires `builderCode`). Builder orders
   * relay via blitz so the fee-charging EIP-7702 leg always executes; they
   * need a private/session-key signer (browser wallets and direct mode are
   * refused) and have no SSE lifecycle, so `onEvent` never fires for them.
   *
   * `onEvent` (relayer route only) observes each batched-market event live
   * while the call still settles normally: the accepted event, retryable
   * `AttemptFailed` diagnostics, and the terminal (also when it throws).
   *
   * @example
   * ```ts
   * await client.trade.marketOpen("ETH/USD", "long", {
   *   collateral: 100, leverage: 10, takeProfit: 4200,
   * });
   * ```
   */
  async marketOpen(
    pair: PairRef,
    side: Side,
    args: {
      collateral: Num;
      leverage: Num;
      openPrice?: Num;
      takeProfit?: Num;
      stopLoss?: Num;
      slippagePercent?: Num;
      skipValidation?: boolean;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const upside = pairIsUpside(info);
    const orderType: OrderType = upside ? "market_pnl" : "market";
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: upside,
      action: "open",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      side,
      orderType,
      collateralUsdc: args.collateral,
      leverage: args.leverage,
      openPrice: args.openPrice,
      slippagePercent: args.slippagePercent ?? 1,
      takeProfit: args.takeProfit,
      stopLoss: args.stopLoss,
      skipValidation: args.skipValidation || undefined,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/trade/open",
      "/v2/intents/open",
      params,
      upside ? AggregatorOrderType.MARKET_OPEN_PNL : AggregatorOrderType.MARKET_OPEN,
      { wait: args.wait ?? true, onEvent: args.onEvent },
    );
  }

  /**
   * Open sized in coin units (fill leverage floats within [min, max]
   * bounds). `leverage` is the target/reference leverage
   * (contract-required); min/max default to the pair envelope when omitted.
   */
  async marketOpenCoin(
    pair: PairRef,
    side: Side,
    args: {
      collateral: Num;
      coinExposure: Num;
      leverage: Num;
      minLeverage?: Num;
      maxLeverage?: Num;
      openPrice?: Num;
      slippagePercent?: Num;
      takeProfit?: Num;
      stopLoss?: Num;
      skipValidation?: boolean;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const upside = pairIsUpside(info);
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: upside,
      action: "open",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      side,
      orderType: (upside ? "market_pnl" : "market") satisfies OrderType,
      collateralUsdc: args.collateral,
      coinExposure: args.coinExposure,
      leverage: args.leverage,
      minLeverage: args.minLeverage,
      maxLeverage: args.maxLeverage,
      openPrice: args.openPrice,
      slippagePercent: args.slippagePercent ?? 1,
      takeProfit: args.takeProfit,
      stopLoss: args.stopLoss,
      skipValidation: args.skipValidation || undefined,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/trade/open-coin",
      "/v2/intents/open-coin",
      params,
      upside
        ? AggregatorOrderType.MARKET_OPEN_PNL_WITH_COIN_EXPOSURE
        : AggregatorOrderType.MARKET_OPEN_WITH_COIN_EXPOSURE,
      { wait: args.wait ?? true, onEvent: args.onEvent },
    );
  }

  /**
   * Place a limit (or stop-limit) open order.
   *
   * Not available on Upside pairs (market-only; there is no PnL limit order
   * type on-chain). Note: limit opens escrow USDC on placement. On the
   * relayer route this goes through the TX_RELAY passthrough (matching the
   * Veranta UI).
   */
  async limitOpen(
    pair: PairRef,
    side: Side,
    args: {
      collateral: Num;
      leverage: Num;
      price: Num;
      stop?: boolean;
      takeProfit?: Num;
      stopLoss?: Num;
      slippagePercent?: Num;
      skipValidation?: boolean;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    this.requireNotUpside(info, "limitOpen");
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      side,
      orderType: (args.stop ? "stop_limit" : "limit") satisfies OrderType,
      collateralUsdc: args.collateral,
      leverage: args.leverage,
      openPrice: args.price,
      slippagePercent: args.slippagePercent ?? 1,
      takeProfit: args.takeProfit,
      stopLoss: args.stopLoss,
      skipValidation: args.skipValidation || undefined,
    };
    const calldata = await this.calldata("/v2/trade/open", params);
    if (this.engine.isRelayerMode) {
      return await this.engine.submitPassthrough(calldata, { wait: args.wait ?? true });
    }
    return await this.engine.submitDirect(calldata, { wait: args.wait ?? true });
  }

  // ------------------------------------------------------------------ closes

  /**
   * Close a position partially or fully (pass the full collateral for a
   * full close). Positions on Upside pairs close with the PnL close type
   * automatically.
   */
  async marketClose(
    pair: PairRef,
    tradeIndex: number,
    args: {
      collateralToClose: Num;
      expectedPrice?: Num;
      openTimestamp?: number;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: pairIsUpside(info),
      action: "close",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      collateralToCloseUsdc: args.collateralToClose,
      expectedPrice: args.expectedPrice,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/trade/close",
      "/v2/intents/close",
      params,
      pairIsUpside(info) ? AggregatorOrderType.MARKET_CLOSE_PNL : AggregatorOrderType.MARKET_CLOSE,
      {
        wait: args.wait ?? true,
        onEvent: args.onEvent,
        intentExtra: { openTimestamp: args.openTimestamp },
      },
    );
  }

  /** Close sized in coin units. Upside pairs route as PnL automatically. */
  async marketCloseCoin(
    pair: PairRef,
    tradeIndex: number,
    args: {
      coinExposure: Num;
      expectedPrice?: Num;
      openTimestamp?: number;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: pairIsUpside(info),
      action: "close",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      coinExposure: args.coinExposure,
      expectedPrice: args.expectedPrice,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/trade/close-coin",
      "/v2/intents/close-coin",
      params,
      pairIsUpside(info)
        ? AggregatorOrderType.MARKET_CLOSE_PNL_WITH_COIN_EXPOSURE
        : AggregatorOrderType.MARKET_CLOSE_WITH_COIN_EXPOSURE,
      {
        wait: args.wait ?? true,
        onEvent: args.onEvent,
        intentExtra: { openTimestamp: args.openTimestamp },
      },
    );
  }

  // ------------------------------------------------------------------ limit order mgmt

  async updateLimitOrder(
    pair: PairRef,
    orderIndex: number,
    args: {
      price: Num;
      slippagePercent?: Num;
      takeProfit?: Num;
      stopLoss?: Num;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    const params: Record<string, unknown> = {
      pairIndex: (await this.resolvePair(pair)).index,
      trader: this.trader,
      orderIndex,
      price: args.price,
      slippagePercent: args.slippagePercent ?? 1,
      takeProfit: args.takeProfit,
      stopLoss: args.stopLoss,
    };
    return await this.passthroughOrDirect("/v2/limit/update", params, args.wait ?? true);
  }

  async cancelLimitOrder(
    pair: PairRef,
    orderIndex: number,
    args: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const params: Record<string, unknown> = {
      pairIndex: (await this.resolvePair(pair)).index,
      trader: this.trader,
      orderIndex,
    };
    return await this.passthroughOrDirect("/v2/limit/cancel", params, args.wait ?? true);
  }

  // ------------------------------------------------------------------ position updates

  /**
   * Signed oracle bytes for calldata that executes against a fresh price.
   *
   * `updateMargin` calldata embeds price-update bytes that the on-chain
   * aggregator verifies, and the signature must come from the feed app of
   * THIS environment (`config.feedUrl`); e.g. the testnet fork rejects
   * mainnet-signed updates. Prefers the pro (Lazer) leg, like the UI.
   * Returns `{}` when the feed has no update; the tx-builder then sources
   * the bytes itself.
   */
  private async freshPriceUpdate(pairIndex: number): Promise<Record<string, unknown>> {
    let data: any;
    try {
      data = await this.transport.json(
        "GET",
        `${this.cfg.feedUrl}/v2/pairs/${pairIndex}/price-update-data`,
      );
    } catch (error) {
      if (error instanceof ApiError) return {};
      throw error;
    }
    if (!data || typeof data !== "object") return {};
    const leg = data.pro ?? data.core;
    if (!leg || typeof leg !== "object" || !leg.priceUpdateData) return {};
    return {
      priceUpdateData: leg.priceUpdateData,
      priceSourcing: data.pro ? 1 : 0,
    };
  }

  /**
   * Deposit or withdraw collateral on an open position.
   *
   * Executes atomically against a fresh oracle price: the SDK attaches
   * signed price-update bytes from the configured feed app.
   */
  async updateMargin(
    pair: PairRef,
    tradeIndex: number,
    action: MarginAction,
    amount: Num,
    args: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      action,
      collateralUsdc: amount,
      ...(await this.freshPriceUpdate(info.index)),
    };
    return await this.passthroughOrDirect("/v2/margin/update", params, args.wait ?? true);
  }

  /**
   * Increase a position's size (`builderFeePercent` behaves as in
   * marketOpen; increases count as opens for builder fees).
   */
  async increasePosition(
    pair: PairRef,
    tradeIndex: number,
    args: {
      collateral: Num;
      leverage: Num;
      openPrice?: Num;
      slippagePercent?: Num;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: pairIsUpside(info),
      action: "increase",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      additionalCollateralUsdc: args.collateral,
      leverage: args.leverage,
      openPrice: args.openPrice,
      slippagePercent: args.slippagePercent ?? 1,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/position/increase",
      "/v2/intents/increase",
      params,
      AggregatorOrderType.INCREASE_SIZE,
      { wait: args.wait ?? true, onEvent: args.onEvent },
    );
  }

  /**
   * Increase sized in coin units (`leverage` = reference leverage for the
   * added collateral; fill floats within [min, max]).
   */
  async increasePositionCoin(
    pair: PairRef,
    tradeIndex: number,
    args: {
      collateral: Num;
      coinExposure: Num;
      leverage: Num;
      minLeverage: Num;
      maxLeverage: Num;
      openPrice?: Num;
      slippagePercent?: Num;
      builderFeePercent?: Num;
      wait?: boolean;
      onEvent?: BatchedMarketEventHook;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    const builder = this.builderParams(args.builderFeePercent, {
      isUpside: pairIsUpside(info),
      action: "increase",
    });
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      additionalCollateralUsdc: args.collateral,
      coinExposure: args.coinExposure,
      leverage: args.leverage,
      minLeverage: args.minLeverage,
      maxLeverage: args.maxLeverage,
      openPrice: args.openPrice,
      slippagePercent: args.slippagePercent ?? 1,
      ...builder,
    };
    return await this.submitMarket(
      builder,
      "/v2/position/increase-coin",
      "/v2/intents/increase-coin",
      params,
      AggregatorOrderType.INCREASE_SIZE_WITH_COIN_EXPOSURE,
      { wait: args.wait ?? true, onEvent: args.onEvent },
    );
  }

  /**
   * The open position at (trader, pairIndex, index) from the core API, or a
   * 404-flavored ValidationError (mirrors the backend's global
   * price-trigger path, which rejects mutations on unknown positions).
   */
  private async fetchPosition(pairIndex: number, tradeIndex: number): Promise<Position> {
    const data = await this.transport.json("GET", `${this.cfg.coreApiUrl}/user-data`, {
      params: { trader: this.trader },
    });
    const position = findPosition(toUserData(data), pairIndex, tradeIndex);
    if (!position) {
      throw new ValidationError(
        `no open position for ${this.trader} at pairIndex=${pairIndex} index=${tradeIndex}`,
        { code: "NO_POSITION", status: 404 },
      );
    }
    return position;
  }

  /**
   * Update the GLOBAL (on-chain) TP/SL on an open position.
   *
   * `undefined` keeps a leg unchanged (its current value is copied from the
   * position; the signed intent always carries both legs); `0` clears a
   * leg. `stopLoss: 0` truly removes the SL. A position always has a TP
   * on-chain, so `takeProfit: 0` RESETS it to the pair's max-gain cap
   * (`maxGainP`, typically +2500%) rather than removing it.
   *
   * v2 has no public updateTpAndSl entry point; this signs an EIP-712
   * `UpdateTpSlReq` and submits it to the core API price-triggers endpoint
   * (`PUT /price-triggers/global-...`), which verifies it and executes the
   * operator entry point itself. Same path in relayer and direct mode. A
   * 2xx means ACCEPTED for execution, not mined: with `wait: true` the SDK
   * polls the position until the new levels are visible on `/user-data`.
   */
  async updateTpSl(
    pair: PairRef,
    tradeIndex: number,
    args: { takeProfit?: Num; stopLoss?: Num; wait?: boolean },
  ): Promise<ExecutionReceipt> {
    if (args.takeProfit === undefined && args.stopLoss === undefined) {
      throw new ValidationError("updateTpSl needs takeProfit and/or stopLoss", {
        code: "NOTHING_TO_UPDATE",
      });
    }
    const signer = this.engine.requireSigner();
    const info = await this.resolvePair(pair);
    const position = await this.fetchPosition(info.index, tradeIndex);

    const builder = await this.localIntents();
    const intent = builder.updateTpSl({
      trader: this.trader,
      pairIndex: info.index,
      index: tradeIndex,
      tp: args.takeProfit ?? from1e10(position.tp ?? "0"),
      sl: args.stopLoss ?? from1e10(position.sl ?? "0"),
    });
    const signed = await signIntent(intent, signer);

    // Either leg's synthetic id addresses the same position; the backend
    // routes on the id shape and validates trader/pair/index against the
    // signed intent. Use the leg being changed for readability.
    const kind = args.takeProfit !== undefined ? "tp" : "sl";
    const entityId = `global-${kind}-${position.trader}-${info.index}-${tradeIndex}`;
    const response = await this.transport.json(
      "PUT",
      `${this.cfg.coreApiUrl}/price-triggers/${entityId}`,
      { json: { userIntent: intent.encodedIntent, signedMessage: signed.signature } },
    );
    const receipt: ExecutionReceipt = {
      route: "price-triggers",
      description: intent.intent,
      raw: response && typeof response === "object" ? response : undefined,
    };
    if (args.wait ?? true) {
      await this.waitForTpSlChange(info.index, tradeIndex, {
        before: [position.tp ?? "0", position.sl ?? "0"],
        expected: [String(intent.message._newTp), String(intent.message._newSl)],
      });
    }
    return receipt;
  }

  /**
   * Poll /user-data until the position's (tp, sl) match the accepted
   * update. `takeProfit: 0` is contract-corrected to the max-gain price
   * (PairStorage.correctTp), so an exact match cannot be required for a
   * zero TP leg; any change from the pre-update snapshot settles it too.
   */
  private async waitForTpSlChange(
    pairIndex: number,
    tradeIndex: number,
    args: { before: [string, string]; expected: [string, string] },
  ): Promise<void> {
    const { before, expected } = args;
    let slOk = false;
    let now = before;
    const deadline = Date.now() + this.cfg.relayPollTimeoutMs;
    while (Date.now() < deadline) {
      const position = await this.fetchPosition(pairIndex, tradeIndex);
      now = [position.tp ?? "0", position.sl ?? "0"];
      const tpOk = now[0] === expected[0] || (expected[0] === "0" && now[0] !== before[0]);
      slOk = now[1] === expected[1];
      if (tpOk && slOk) return;
      await sleep(this.cfg.relayPollIntervalMs);
    }
    if (slOk && expected[0] === "0") {
      // zero-TP reset with no observable change: signing _newTp = 0 when
      // the TP already sits at the corrected default re-stores the same
      // value, so nothing on /user-data changes.
      return;
    }
    const px = (raw: string) => String(from1e10(raw));
    throw new RelayTimeoutError(
      "TP/SL update accepted but not visible on the position after " +
        `${Math.round(this.cfg.relayPollTimeoutMs / 1000)}s (pairIndex=${pairIndex} ` +
        `index=${tradeIndex}): signed UpdateTpSlReq with tp=${px(expected[0])} ` +
        `sl=${px(expected[1])}` +
        `${expected[0] === "0" ? " (tp=0 resets to the max-gain cap)" : ""}, ` +
        `position still shows tp=${px(now[0])} sl=${px(now[1])} ` +
        `(was tp=${px(before[0])} sl=${px(before[1])} before the update). ` +
        "The operator may still execute it; re-check account.positions().",
    );
  }

  /** Build + sign a TpSlReq and shape the core-API submission body. */
  private async partialTpSlSubmission(
    pair: PairRef,
    tradeIndex: number,
    args: {
      side: Side;
      kind: string;
      coinExposure: Num;
      trigger: TriggerType;
      price?: Num;
      percentage?: Num;
      openTimestamp?: number;
    },
  ): Promise<Record<string, any>> {
    const kindFull =
      args.kind === "tp" ? "take_profit" : args.kind === "sl" ? "stop_loss" : args.kind;
    const params: Record<string, unknown> = {
      pairIndex: (await this.resolvePair(pair)).index,
      trader: this.trader,
      tradeIndex,
      side: args.side,
      kind: kindFull,
      coinExposure: args.coinExposure,
      triggerType: args.trigger,
      price: args.price,
      percentage: args.percentage,
      openTimestamp: args.openTimestamp,
    };
    const intent = await this.txb.intent("/v2/intents/tpsl-partial", params);
    const signer = this.engine.requireSigner();
    const signed = await signIntent(intent, signer);
    const msg = intent.message;
    const submission: Record<string, any> = {
      trader: msg.trader,
      pairIndex: Number(msg.pairIndex),
      index: Number(msg.index),
      triggerType: Number(msg.triggerType),
      coinSize: String(msg.coinSize),
      buy: Boolean(msg.buy),
      price: String(msg.price),
      percentage: String(msg.percentage),
      timestamp: Number(msg.timestamp),
      signTimestamp: Number(msg.signTimestamp),
      orderType: Number(msg.orderType),
      signedMessage: signed.signature,
    };
    if ("nonce" in msg) submission.nonce = String(msg.nonce);
    return submission;
  }

  /**
   * Create a partial TP/SL trigger order.
   *
   * Signs a TpSlReq intent (no deadline by design; freshness comes from
   * signTimestamp) and stores it with the Veranta operator via
   * `POST {core}/price-triggers`. The operator executes it on-chain when
   * the trigger price hits. Returns the stored order; keep its `entityId`
   * to update or cancel later.
   */
  async partialTpSl(
    pair: PairRef,
    tradeIndex: number,
    args: {
      /** Side of the POSITION being trimmed. */
      side: Side;
      /** "tp"/"take_profit" | "sl"/"stop_loss". */
      kind: string;
      coinExposure: Num;
      trigger?: TriggerType;
      price?: Num;
      percentage?: Num;
      openTimestamp?: number;
    },
  ): Promise<Record<string, any>> {
    const submission = await this.partialTpSlSubmission(pair, tradeIndex, {
      side: args.side,
      kind: args.kind,
      coinExposure: args.coinExposure,
      trigger: args.trigger ?? "fixed",
      price: args.price,
      percentage: args.percentage,
      openTimestamp: args.openTimestamp,
    });
    const stored = await this.transport.json("POST", `${this.cfg.coreApiUrl}/price-triggers`, {
      json: submission,
    });
    // The response is the persisted order (carries entityId); merge it over
    // the submission so callers keep the signed fields too.
    return { ...submission, ...(stored && typeof stored === "object" ? stored : {}) };
  }

  /**
   * Positions' `priceTriggers` mix off-chain orders with synthetic global
   * entries (`global-tp-*` / `global-sl-*`, `isGlobal` true). The global
   * ones live on-chain; manage them with updateTpSl (takeProfit: 0 resets
   * the TP, stopLoss: 0 removes the SL), not the partial-order CRUD.
   */
  private requirePartialEntityId(entityId: string, what: string): void {
    if (entityId.startsWith("global-")) {
      throw new ValidationError(
        `${what}: ${JSON.stringify(entityId)} is the synthetic id of the position's ` +
          "global on-chain TP/SL (priceTriggers entry with isGlobal). Change or " +
          "remove it with updateTpSl(); e.g. stopLoss: 0 removes the SL; the " +
          "partial-order CRUD only accepts stored order entityIds.",
        { code: "GLOBAL_TRIGGER_ID" },
      );
    }
  }

  /**
   * Replace a stored partial TP/SL order in place (atomic edit).
   *
   * `entityId` comes from the create response / a position's
   * `priceTriggers` (entries with `isGlobal` false). The replacement is a
   * freshly signed TpSlReq; pass the FULL new order, not a diff.
   *
   * The backend deletes the old order and stores the replacement
   * atomically, minting a NEW id: the returned object's `entityId` is the
   * replacement's id; adopt it, the old one is gone.
   */
  async updatePartialTpSl(
    entityId: string,
    pair: PairRef,
    tradeIndex: number,
    args: {
      side: Side;
      kind: string;
      coinExposure: Num;
      trigger?: TriggerType;
      price?: Num;
      percentage?: Num;
      openTimestamp?: number;
    },
  ): Promise<Record<string, any>> {
    this.requirePartialEntityId(entityId, "updatePartialTpSl");
    const submission = await this.partialTpSlSubmission(pair, tradeIndex, {
      side: args.side,
      kind: args.kind,
      coinExposure: args.coinExposure,
      trigger: args.trigger ?? "fixed",
      price: args.price,
      percentage: args.percentage,
      openTimestamp: args.openTimestamp,
    });
    const response = await this.transport.json(
      "PUT",
      `${this.cfg.coreApiUrl}/price-triggers/${entityId}`,
      { json: submission },
    );
    // Mutation response: {success, result: {oldEntityId, newEntityId}}.
    const result = response && typeof response === "object" ? response.result : undefined;
    const newId = result?.newEntityId ?? entityId;
    return { ...submission, entityId: newId, oldEntityId: entityId };
  }

  /**
   * Cancel a stored partial TP/SL trigger order.
   *
   * `order` is the object returned by partialTpSl / an entry from a
   * position's `priceTriggers` with `isGlobal` false (must carry
   * `entityId`), or the `entityId` string itself. Global (on-chain)
   * triggers cannot be cancelled here; use updateTpSl with 0. Ownership
   * proof is an EIP-712 `CancelOffchainOrder` signature over the entityId;
   * the trader or an active delegate may sign.
   */
  async cancelPartialTpSl(order: Record<string, any> | string): Promise<void> {
    const entityId =
      typeof order === "string" ? order : (order.entityId ?? order.documentId ?? undefined);
    if (!entityId) {
      throw new ConfigError(
        "cancelPartialTpSl needs the order's entityId (returned by partialTpSl " +
          "and on positions' priceTriggers entries).",
      );
    }
    this.requirePartialEntityId(String(entityId), "cancelPartialTpSl");
    const signer = this.engine.requireSigner();
    const builder = await this.localIntents();
    const intent = builder.cancelOffchainOrder({ entityId: String(entityId) });
    const signed = await signIntent(intent, signer);
    await this.transport.json("DELETE", `${this.cfg.coreApiUrl}/price-triggers`, {
      json: { entityId: String(entityId), signedMessage: signed.signature },
    });
  }

  // ------------------------------------------------------------------ TWAP / RFQ

  /**
   * Sign a TWAP intent and submit it to the twap-app API.
   *
   * The twap-app verifies the signature, sends executeTwapBatched itself
   * (operator wallet) and responds synchronously with
   * {twapId, transactionHash, blockNumber}; no relayer involved. Body shape
   * follows the twap-app DTOs: pairIndex/index as numbers, other numerics
   * as decimal strings, `__reserved1` renamed `reserved1`.
   */
  private async submitTwap(path: string, intent: IntentPayload): Promise<ExecutionReceipt> {
    const signer = this.engine.requireSigner();
    const signed = await signIntent(intent, signer);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(intent.message)) {
      if (key === "__reserved1") body.reserved1 = String(value);
      else if (key === "pairIndex" || key === "index") body[key] = Number(value);
      else if (typeof value === "boolean") body[key] = value;
      else body[key] = String(value);
    }
    body.signature = signed.signature;
    const raw = await this.transport.json("POST", `${this.cfg.twapApiUrl}${path}`, { json: body });
    const data = raw && typeof raw === "object" ? raw : {};
    return {
      route: "twap-api",
      txHash: data.transactionHash,
      orderId: data.twapId !== undefined && data.twapId !== null ? Number(data.twapId) : undefined,
      description: intent.intent,
      raw: data,
    };
  }

  /**
   * Open a TWAP order (collateral spread over runTimeSeconds slices).
   *
   * Not available on Upside pairs (their TWAP params are zeroed on-chain).
   * `coinExposure` switches to fixed exposure targeting. Leverage bounds
   * are required by the contract struct. The receipt's `orderId` is the
   * on-chain twapId (use it to cancel).
   */
  async twapOpen(
    pair: PairRef,
    side: Side,
    args: {
      collateral: Num;
      runTimeSeconds: number;
      leverage: Num;
      maxLeverage: Num;
      coinExposure?: Num;
    },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    this.requireNotUpside(info, "twapOpen");
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      side,
      collateralUsdc: args.collateral,
      coinExposure: args.coinExposure,
      leverage: args.leverage,
      maxLeverage: args.maxLeverage,
      runTimeSeconds: args.runTimeSeconds,
    };
    const intent = await this.txb.intent("/v2/intents/twap-open", params);
    return await this.submitTwap("/twaps/open", intent);
  }

  /**
   * Close exposure via TWAP slices spread over `runTimeSeconds`. Not
   * available on Upside pairs (market-only).
   */
  async twapClose(
    pair: PairRef,
    tradeIndex: number,
    args: { coinExposureToClose: Num; runTimeSeconds: number },
  ): Promise<ExecutionReceipt> {
    const info = await this.resolvePair(pair);
    this.requireNotUpside(info, "twapClose");
    const params: Record<string, unknown> = {
      pairIndex: info.index,
      trader: this.trader,
      tradeIndex,
      coinExposureToClose: args.coinExposureToClose,
      runTimeSeconds: args.runTimeSeconds,
    };
    const intent = await this.txb.intent("/v2/intents/twap-close", params);
    return await this.submitTwap("/twaps/close", intent);
  }

  /**
   * Cancel a TWAP by its on-chain `twapId` (receipt.orderId from twapOpen,
   * or `account.twaps()`). Signs a TwapCancelReq built locally (needs no
   * chain state; digest-equal to the tx-builder's /v2/intents/twap-cancel).
   */
  async twapCancel(twapId: number | bigint): Promise<ExecutionReceipt> {
    const builder = await this.localIntents();
    const intent = builder.twapCancel({ trader: this.trader, twapId });
    return await this.submitTwap("/twaps/cancel", intent);
  }

  /**
   * Open an RFQ order (fill at expectedPrice ± maxSlippagePercent).
   *
   * NOTE: RFQ is not live on Veranta yet; kept for when it ships.
   */
  async rfqOpen(
    pair: PairRef,
    side: Side,
    args: {
      collateral: Num;
      leverage: Num;
      maxLeverage: Num;
      maxSlippagePercent: Num;
      expectedPrice?: Num;
      coinExposure?: Num;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    const params: Record<string, unknown> = {
      pairIndex: (await this.resolvePair(pair)).index,
      trader: this.trader,
      side,
      collateralUsdc: args.collateral,
      coinExposure: args.coinExposure,
      leverage: args.leverage,
      maxLeverage: args.maxLeverage,
      expectedPrice: args.expectedPrice,
      maxSlippagePercent: args.maxSlippagePercent,
    };
    return await this.passthroughOrDirect("/v2/rfq/open", params, args.wait ?? true);
  }

  /** NOTE: RFQ is not live on Veranta yet; kept for when it ships. */
  async rfqClose(
    pair: PairRef,
    tradeIndex: number,
    args: {
      coinExposureToClose: Num;
      maxSlippagePercent: Num;
      expectedPrice?: Num;
      wait?: boolean;
    },
  ): Promise<ExecutionReceipt> {
    const params: Record<string, unknown> = {
      pairIndex: (await this.resolvePair(pair)).index,
      trader: this.trader,
      tradeIndex,
      coinExposureToClose: args.coinExposureToClose,
      expectedPrice: args.expectedPrice,
      maxSlippagePercent: args.maxSlippagePercent,
    };
    return await this.passthroughOrDirect("/v2/rfq/close", params, args.wait ?? true);
  }
}
