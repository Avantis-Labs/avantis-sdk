/**
 * Local intent builder: the market-maker fast path.
 *
 * Builds ready-to-sign IntentPayloads with ZERO HTTP round-trips on the hot
 * path: schemas/domains come from `signing/schema` (mirrored from the
 * contracts and proven by the golden-vector suite), the digest is computed
 * locally, and `encodedIntent` is abi-encoded in Solidity struct order.
 *
 * Bootstrap once with `/v2/meta` (chainId + addresses), then
 * build/sign/submit without touching the tx-builder. The digest produced
 * here feeds the same `signIntent` gate, so a schema drift still fails
 * loudly instead of reverting on-chain.
 */

import type { AbiParameter, Address, Hex } from "viem";
import { encodeAbiParameters, getAddress, hashTypedData, stringToHex } from "viem";
import { ConfigError } from "../errors.js";
import { toBigIntMessage } from "../signing/intents.js";
import {
  INTENT_TYPES,
  REFERRAL_INTENTS,
  TNC_STRING,
  referralDomain,
  tradingDomain,
} from "../signing/schema.js";
import type { TxBuilderMeta } from "../txbuilder.js";
import type { IntentPayload, Num } from "../types.js";

const USDC = 6;
const P10 = 10;

/**
 * Human units -> raw integer via exact decimal scaling.
 *
 * Binary-float multiplication can truncate one unit low
 * (`Math.trunc(0.0003 * 1e10) === 2_999_999_999` is fine but
 * `0.0000003 * 1e10` style artifacts bite low-priced pair prices and
 * TP/SL); a JS number's `String()` is its shortest exact decimal
 * representation, so scaling through decimal-string arithmetic gives the
 * raw value the user actually meant.
 */
export function scaleDecimal(value: Num, decimals: number): bigint {
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new ConfigError(`not a decimal number: ${JSON.stringify(text)}`);
  const [, sign, intPart, fracPart = "", expPart] = match;
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");
  // value = digits * 10^(exp - fracLen); result = value * 10^decimals
  const exponent = (expPart ? Number.parseInt(expPart, 10) : 0) - fracPart.length + decimals;
  let result: bigint;
  if (exponent >= 0) {
    result = BigInt(digits) * 10n ** BigInt(exponent);
  } else {
    // truncate toward zero, like Python's int(Decimal * factor)
    result = BigInt(digits) / 10n ** BigInt(-exponent);
  }
  return sign === "-" ? -result : result;
}

const usdc = (value: Num) => scaleDecimal(value, USDC);
const p10 = (value: Num) => scaleDecimal(value, P10);

/**
 * Solidity struct component order for abi.encode(struct). Identical to the
 * typed-data order except DelegateReq (declares expiry, tnc, deadline).
 */
const ABI_ORDERS: Record<string, string[]> = {
  DelegateReq: ["trader", "delegate", "expiry", "tnc", "deadline", "nonce"],
};

/** ITradingStorage.TriggerType (partial TP/SL). */
const TRIGGER_TYPE_CODES: Record<string, number> = { fixed: 0, percentage: 1 };
/** ITradingStorage.LimitOrder: partial TP/SL live at codes 4/5. */
const PARTIAL_KIND_CODES: Record<string, number> = {
  take_profit: 4,
  tp: 4,
  stop_loss: 5,
  sl: 5,
};

/** Referral code as bytes32 hex: pass 0x… through, right-pad short strings. */
export function codeBytes32(code: string): Hex {
  if (code.startsWith("0x")) {
    if (code.length !== 66) throw new ConfigError("hex referral code must be exactly 32 bytes");
    return code as Hex;
  }
  if (new TextEncoder().encode(code).length > 32) {
    throw new ConfigError("referral code must be at most 32 bytes");
  }
  return stringToHex(code, { size: 32 });
}

/** Random 256-bit unordered nonces with local dedup (parallel-order safe). */
export class NoncePool {
  private readonly used = new Set<bigint>();

  next(): bigint {
    for (;;) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let nonce = 0n;
      for (const byte of bytes) nonce = (nonce << 8n) | BigInt(byte);
      if (!this.used.has(nonce)) {
        this.used.add(nonce);
        return nonce;
      }
    }
  }

  release(nonce: bigint): void {
    this.used.delete(nonce);
  }
}

/** (abi tuple parameter, ordered field names) for the top-level struct. */
function abiSchema(kind: string): { param: AbiParameter; order: string[] } {
  const types = INTENT_TYPES[kind]!;
  const fields = types[kind]!;
  const order = ABI_ORDERS[kind] ?? fields.map((f) => f.name);
  const fieldTypes = new Map(fields.map((f) => [f.name, f.type]));

  const components: AbiParameter[] = order.map((name) => {
    const type = fieldTypes.get(name)!;
    if (type in types) {
      return {
        name,
        type: "tuple",
        components: types[type]!.map((f) => ({ name: f.name, type: f.type })),
      } as AbiParameter;
    }
    return { name, type } as AbiParameter;
  });
  return { param: { type: "tuple", components } as AbiParameter, order };
}

function abiValues(kind: string, message: Record<string, any>): Record<string, unknown> {
  const types = INTENT_TYPES[kind]!;
  const fieldTypes = new Map(types[kind]!.map((f) => [f.name, f.type]));
  const { order } = abiSchema(kind);
  const value: Record<string, unknown> = {};
  for (const name of order) {
    const type = fieldTypes.get(name)!;
    value[name] = type in types ? { ...message[name] } : message[name];
  }
  return value;
}

export interface LocalIntentBuilderOptions {
  referral?: Address;
  defaultDeadlineMs?: number;
}

export class LocalIntentBuilder {
  readonly chainId: number;
  readonly tradingRouter: Address;
  readonly referral: Address | null;
  readonly defaultDeadlineMs: number;
  readonly nonces = new NoncePool();

  constructor(chainId: number, tradingRouter: Address, options: LocalIntentBuilderOptions = {}) {
    this.chainId = chainId;
    this.tradingRouter = getAddress(tradingRouter);
    this.referral = options.referral ? getAddress(options.referral) : null;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 120_000;
  }

  static fromMeta(meta: TxBuilderMeta): LocalIntentBuilder {
    const addresses = meta.addresses;
    return new LocalIntentBuilder(Number(meta.chainId), addresses.tradingRouter as Address, {
      referral: addresses.referral as Address | undefined,
    });
  }

  // ------------------------------------------------------------------ core

  /**
   * Build an IntentPayload from a raw-scale message (bigint or
   * decimal-string values; bools stay bools).
   */
  build(kind: string, message: Record<string, any>): IntentPayload {
    const types = INTENT_TYPES[kind];
    if (!types) throw new ConfigError(`unknown intent kind ${kind}`);
    const domain = REFERRAL_INTENTS.has(kind)
      ? referralDomain(this.chainId, this.requireReferral())
      : tradingDomain(this.chainId, this.tradingRouter);

    // Canonical bigint-typed message: coerces int fields (accepts bigint,
    // number or string), passes bools/addresses/strings/bytes32 through.
    const intMessage = toBigIntMessage(types, kind, message);

    const digest = hashTypedData({
      domain,
      types,
      primaryType: kind,
      message: intMessage,
    } as any);

    const { param } = abiSchema(kind);
    const encoded = encodeAbiParameters([param], [abiValues(kind, intMessage) as any]);

    const stringify = (value: unknown): unknown => {
      if (typeof value === "boolean") return value;
      if (typeof value === "bigint" || typeof value === "number") return String(value);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stringify(v)]),
        );
      }
      return value;
    };

    return {
      intent: kind,
      signerRule: kind === "DelegateReq" ? "trader-only" : "trader-or-delegate",
      domain: domain as IntentPayload["domain"],
      primaryType: kind,
      types,
      message: Object.fromEntries(
        Object.entries(intMessage).map(([k, v]) => [k, stringify(v)]),
      ) as Record<string, any>,
      digest,
      encodedIntent: encoded,
    };
  }

  // ------------------------------------------------------------------ trading helpers

  private deadline(deadlineMs?: number): number {
    return deadlineMs ?? Date.now() + this.defaultDeadlineMs;
  }

  private nonce(nonce?: bigint): bigint {
    return nonce ?? this.nonces.next();
  }

  private tradeStruct(args: {
    trader: Address;
    pairIndex: number;
    isLong: boolean;
    collateralUsdc: Num;
    leverage: Num;
    openPrice: Num;
    tp?: Num;
    sl?: Num;
  }): Record<string, unknown> {
    return {
      trader: getAddress(args.trader),
      pairIndex: args.pairIndex,
      index: 0,
      initialPosToken: 0,
      positionSizeUSDC: usdc(args.collateralUsdc),
      openPrice: p10(args.openPrice),
      buy: args.isLong,
      leverage: p10(args.leverage),
      tp: p10(args.tp ?? 0),
      sl: p10(args.sl ?? 0),
      timestamp: 0,
    };
  }

  openTrade(args: {
    trader: Address;
    pairIndex: number;
    isLong: boolean;
    collateralUsdc: Num;
    leverage: Num;
    openPrice: Num;
    /** 0 market, 1 stop_limit, 2 limit, 3 market_pnl. */
    orderType?: number;
    tp?: Num;
    sl?: Num;
    slippagePercent?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("OpenTradeReq", {
      _t: this.tradeStruct(args),
      _type: args.orderType ?? 0,
      _slippageP: p10(args.slippagePercent ?? 1),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  /**
   * Open targeting a fixed base-asset exposure (fill leverage floats within
   * [minLeverage, maxLeverage]; `leverage` is the reference).
   */
  openTradeCoin(args: {
    trader: Address;
    pairIndex: number;
    isLong: boolean;
    collateralUsdc: Num;
    coinExposure: Num;
    leverage: Num;
    minLeverage: Num;
    maxLeverage: Num;
    openPrice: Num;
    /** 0 market, 3 market_pnl. */
    orderType?: number;
    tp?: Num;
    sl?: Num;
    slippagePercent?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("OpenTradeCoinExposureReq", {
      _t: this.tradeStruct(args),
      _type: args.orderType ?? 0,
      _coinExposure: p10(args.coinExposure),
      _minLeverage: p10(args.minLeverage),
      _maxLeverage: p10(args.maxLeverage),
      _slippageP: p10(args.slippagePercent ?? 1),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  closeTrade(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    openTimestamp: number;
    amountUsdc: Num;
    wantedPrice: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("CloseTradeReq", {
      _trader: getAddress(args.trader),
      _pairIndex: args.pairIndex,
      _index: args.index,
      _openTimestamp: args.openTimestamp,
      _amount: usdc(args.amountUsdc),
      _wantedPrice: p10(args.wantedPrice),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  /** Close a fixed base-asset exposure instead of a USDC amount. */
  closeTradeCoin(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    openTimestamp: number;
    coinExposure: Num;
    wantedPrice: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("CloseTradeCoinExposureReq", {
      _trader: getAddress(args.trader),
      _pairIndex: args.pairIndex,
      _index: args.index,
      _openTimestamp: args.openTimestamp,
      _coinExposure: p10(args.coinExposure),
      _wantedPrice: p10(args.wantedPrice),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  private updatePositionSizeStruct(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    openPrice: Num;
    additionalCollateralUsdc: Num;
    leverage: Num;
  }): Record<string, unknown> {
    return {
      trader: getAddress(args.trader),
      pairIndex: args.pairIndex,
      index: args.index,
      openPrice: p10(args.openPrice),
      initialPosToken: usdc(args.additionalCollateralUsdc),
      leverage: p10(args.leverage),
    };
  }

  /**
   * Increase position size (`openPrice` is the reference price for the
   * added size; no feed locally, so the caller must supply it).
   */
  increasePosition(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    additionalCollateralUsdc: Num;
    leverage: Num;
    openPrice: Num;
    slippagePercent?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("IncreasePositionSizeReq", {
      _updateInfo: this.updatePositionSizeStruct(args),
      _slippageP: p10(args.slippagePercent ?? 1),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  /**
   * Increase targeting a fixed base-asset exposure (fill leverage floats
   * within [minLeverage, maxLeverage]).
   */
  increasePositionCoin(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    additionalCollateralUsdc: Num;
    coinExposure: Num;
    leverage: Num;
    minLeverage: Num;
    maxLeverage: Num;
    openPrice: Num;
    slippagePercent?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("IncreasePositionSizeWithCoinExposureReq", {
      _updateInfo: this.updatePositionSizeStruct(args),
      _coinExposure: p10(args.coinExposure),
      _minLeverage: p10(args.minLeverage),
      _maxLeverage: p10(args.maxLeverage),
      _slippageP: p10(args.slippagePercent ?? 1),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  updateTpSl(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    tp?: Num;
    sl?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("UpdateTpSlReq", {
      trader: getAddress(args.trader),
      _pairIndex: args.pairIndex,
      _index: args.index,
      _newTp: p10(args.tp ?? 0),
      _newSl: p10(args.sl ?? 0),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  /**
   * Partial TP/SL trigger order (TpSlReq).
   *
   * NO deadline by design; freshness comes from `signTimestamp` (ms, must
   * not be in the future). The signed order is stored OFF-CHAIN via the
   * core API /price-triggers; building/signing alone does nothing.
   */
  partialTpSl(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    /** "tp"/"take_profit" | "sl"/"stop_loss". */
    kind: string;
    /** Side of the POSITION being trimmed. */
    isLong: boolean;
    coinExposure: Num;
    /** The position's Trade.timestamp. */
    openTimestamp: number;
    trigger?: "fixed" | "percentage";
    /** Required with trigger="fixed". */
    price?: Num;
    /** Signed, 1 = 1%; required with trigger="percentage". */
    percentage?: Num;
    signTimestampMs?: number;
    nonce?: bigint;
  }): IntentPayload {
    const trigger = args.trigger ?? "fixed";
    if (!(trigger in TRIGGER_TYPE_CODES)) {
      throw new ConfigError(`trigger must be one of ${Object.keys(TRIGGER_TYPE_CODES).sort()}`);
    }
    if (!(args.kind in PARTIAL_KIND_CODES)) {
      throw new ConfigError(`kind must be one of ${Object.keys(PARTIAL_KIND_CODES).sort()}`);
    }
    if (trigger === "fixed" && args.price === undefined) {
      throw new ConfigError("price is required with trigger='fixed'");
    }
    if (trigger === "percentage" && args.percentage === undefined) {
      throw new ConfigError("percentage is required with trigger='percentage'");
    }
    return this.build("TpSlReq", {
      trader: getAddress(args.trader),
      pairIndex: args.pairIndex,
      index: args.index,
      triggerType: TRIGGER_TYPE_CODES[trigger],
      coinSize: p10(args.coinExposure),
      buy: args.isLong,
      price: args.price !== undefined ? p10(args.price) : 0,
      percentage: args.percentage !== undefined ? p10(args.percentage) : 0,
      timestamp: args.openTimestamp,
      signTimestamp: args.signTimestampMs ?? Date.now(),
      orderType: PARTIAL_KIND_CODES[args.kind],
      nonce: this.nonce(args.nonce),
    });
  }

  /**
   * TWAP open (collateral spread over runTimeSeconds slices);
   * `coinExposure` switches to fixed base-asset exposure targeting.
   */
  twapOpen(args: {
    trader: Address;
    pairIndex: number;
    isLong: boolean;
    collateralUsdc: Num;
    runTimeSeconds: number;
    leverage: Num;
    maxLeverage: Num;
    coinExposure?: Num;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("TwapOpenOrder", {
      trader: getAddress(args.trader),
      pairIndex: args.pairIndex,
      collateral: usdc(args.collateralUsdc),
      buy: args.isLong,
      isCoin: args.coinExposure !== undefined,
      coinSize: args.coinExposure !== undefined ? p10(args.coinExposure) : 0,
      defaultLeverage: p10(args.leverage),
      maxLeverage: p10(args.maxLeverage),
      runTime: args.runTimeSeconds,
      nonce: this.nonce(args.nonce),
      deadline: this.deadline(args.deadlineMs),
      __reserved1: 0,
    });
  }

  twapClose(args: {
    trader: Address;
    pairIndex: number;
    index: number;
    coinExposureToClose: Num;
    runTimeSeconds: number;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("TwapCloseOrder", {
      trader: getAddress(args.trader),
      pairIndex: args.pairIndex,
      index: args.index,
      coinSizeToClose: p10(args.coinExposureToClose),
      runTime: args.runTimeSeconds,
      nonce: this.nonce(args.nonce),
      deadline: this.deadline(args.deadlineMs),
      __reserved1: 0,
    });
  }

  /** Cancel a TWAP by its on-chain `twapId` (no __reserved1 field). */
  twapCancel(args: {
    trader: Address;
    twapId: number | bigint;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("TwapCancelReq", {
      trader: getAddress(args.trader),
      twapId: args.twapId,
      nonce: this.nonce(args.nonce),
      deadline: this.deadline(args.deadlineMs),
    });
  }

  /**
   * Delete proof for a stored partial TP/SL: signs the order's `entityId`
   * (from the create response / a position's `priceTriggers`). Off-chain
   * only; never submitted to a contract.
   */
  cancelOffchainOrder(args: { entityId: string }): IntentPayload {
    return this.build("CancelOffchainOrder", { entityId: args.entityId });
  }

  delegateReq(args: {
    trader: Address;
    delegate: Address;
    /** ABSOLUTE unix timestamp in seconds. */
    expirySeconds: number;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    return this.build("DelegateReq", {
      trader: getAddress(args.trader),
      delegate: getAddress(args.delegate),
      expiry: args.expirySeconds,
      deadline: this.deadline(args.deadlineMs),
      tnc: TNC_STRING,
      nonce: this.nonce(args.nonce),
    });
  }

  // ------------------------------------------------------------------ referral
  // Separate EIP-712 domain (verifyingContract = Referral) and a
  // Referral-local nonce bitmap. msg.sender-scoped on-chain: trader key only.

  private requireReferral(): Address {
    if (this.referral === null) {
      throw new ConfigError(
        "referral intents need the Referral contract address; pass referral in " +
          "options (fromMeta sets it automatically)",
      );
    }
    return this.referral;
  }

  registerCode(args: {
    /** bytes32 hex or short string (right-padded). */
    code: string;
    referrer: Address;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    this.requireReferral();
    return this.build("RegisterCodeReq", {
      _code: codeBytes32(args.code),
      _referrer: getAddress(args.referrer),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }

  setReferralCode(args: {
    /** bytes32 hex or short string (right-padded). */
    code: string;
    referee: Address;
    nonce?: bigint;
    deadlineMs?: number;
  }): IntentPayload {
    this.requireReferral();
    return this.build("SetTraderReferralCodeByUserReq", {
      _code: codeBytes32(args.code),
      _referee: getAddress(args.referee),
      _deadline: this.deadline(args.deadlineMs),
      _nonce: this.nonce(args.nonce),
    });
  }
}
