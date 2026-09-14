/**
 * Veranta v2 TypeScript SDK: API-first perpetuals trading on Base.
 *
 * Quick start (relayer route, delegate key from the Veranta UI):
 *
 *     export VERANTA_PRIVATE_KEY=0x...      # your API/agent key
 *     export VERANTA_TRADER_ADDRESS=0x...   # your wallet
 *
 *     import { Veranta } from "veranta-sdk";
 *
 *     const client = new Veranta();
 *     await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10 });
 *
 * React hooks live at `veranta-sdk/react`.
 */

export { VERSION } from "./version.js";

// client
export { Veranta, type VerantaOptions } from "./client.js";

// config
export {
  type VerantaConfig,
  type VerantaConfigInput,
  DEFAULT_DELEGATION_ADDRESS,
  MAINNET,
  type NetworkProfile,
  PROFILES,
  resolveConfig,
  TESTNET,
  TESTNET_RPC_URL,
} from "./config.js";

// testnet faucet (fork devnet only)
export {
  type FundTestnetWalletResult,
  fundTestnetWallet,
  TESTNET_EXPLORER_URL,
} from "./testnet.js";

// errors
export {
  ApiError,
  apiErrorFromEnvelope,
  VerantaError,
  ConfigError,
  DelegationError,
  DigestMismatchError,
  GeoRestrictedError,
  RateLimitedError,
  RelayError,
  RelayTimeoutError,
  RpcError,
  SigningError,
  SimulationFailedError,
  TransactionRevertedError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

// core types
export {
  AggregatorOrderType,
  BATCHED_MARKET_INTENT_KINDS,
  BATCHED_MARKET_ORDER_TYPES,
  type CallData,
  callDataValueWei,
  type Eip712Field,
  type ExecutionMode,
  type ExecutionReceipt,
  type ExecutionRoute,
  from1e10,
  fromUsdc,
  type IntentPayload,
  intentPairIndex,
  isLong,
  type MarginAction,
  type Num,
  type OrderType,
  PRECISION_10,
  type RelayStatus,
  type Side,
  type SignedIntent,
  toApiNum,
  type TriggerType,
  USDC_SCALE,
} from "./types.js";

// signing
export {
  assertIntentDigest,
  intentDigest,
  signIntent,
  toBigIntMessage,
  toTypedDataPayload,
} from "./signing/intents.js";
export {
  INTENT_TYPES,
  REFERRAL_INTENTS,
  referralDomain,
  TNC_STRING,
  tradingDomain,
} from "./signing/schema.js";
export {
  type VerantaSigner,
  normalizeSignature,
  type SignedAuthorization,
  type SignerSource,
  toSigner,
  type TypedDataPayload,
} from "./signing/signer.js";

// EIP-7702
export {
  type Call,
  delegationCode,
  encodeNonce,
  EXECUTE_SELECTOR,
  EXECUTION_MODE_OP_DATA,
  freshNonce,
  GelatoDelegationEncoder,
  type Type4TxParams,
} from "./eip7702/account.js";

// execution
export {
  ACCEPTED,
  ATTEMPT_FAILED,
  BatchedMarketClient,
  type BatchedMarketErc712,
  type BatchedMarketEvent,
  type BatchedMarketEventHook,
  BatchedMarketOutcome,
  TERMINAL_FAILURE,
  TERMINAL_SUCCESS,
} from "./execution/batchedMarket.js";
export { ExecutionEngine, relayRequestParams } from "./execution/engine.js";
export {
  codeBytes32,
  LocalIntentBuilder,
  type LocalIntentBuilderOptions,
  NoncePool,
  scaleDecimal,
} from "./execution/localIntents.js";
export { RelayerClient } from "./execution/relayer.js";
export { JsonRpcClient } from "./execution/rpc.js";
export { iterSse, SseIdleTimeout, type SseEvent } from "./execution/sse.js";

// transport / tx-builder
export { HttpTransport, type RequestOptions } from "./transport.js";
export { cleanParams, TxBuilderClient, type TxBuilderMeta } from "./txbuilder.js";

// namespaces (for advanced wiring; normally accessed via the client)
export { AccountApi } from "./api/account.js";
export { InfoApi } from "./api/info.js";
export { LpApi } from "./api/lp.js";
export { MarketsApi, SPREAD_ORDER_TYPES, type SpreadQuote, ZERO_ADDRESS } from "./api/markets.js";
export { ReferralApi } from "./api/referral.js";
export { type PairRef, TradeApi } from "./api/trade.js";

// models
export {
  findPosition,
  globalTriggers,
  type LimitOrder,
  limitOrderCollateral,
  limitOrderLeverage,
  limitOrderPrice,
  limitOrderSide,
  partialTriggers,
  type Position,
  positionCollateral,
  positionLeverage,
  positionLiquidationPrice,
  positionNotional,
  positionOpenPrice,
  positionRolloverFee,
  positionSide,
  positionSizeInAsset,
  positionSl,
  positionTp,
  positionUnrealisedFundingFee,
  type PriceTrigger,
  triggerCoinSize,
  triggerKind,
  triggerPrice,
  toUserData,
  type UserData,
} from "./api/accountModels.js";
export {
  type AdditionalPairParams2,
  baseSymbol,
  type Feed,
  type FeedAttributes,
  type FundingRate,
  type GroupInfo,
  isMarketOpen,
  isUpside,
  type LazerFeed,
  type Leverages,
  type OpenInterest,
  type PairInfo,
  pairBySymbol,
  pairSymbol,
  type PairValues,
  type PnlFees,
  snapshotPairs,
  type StoragePairParams,
  stripUpsideSuffix,
  type TradingSnapshot,
  type TwapParams,
  UPSIDE_SUFFIX,
} from "./api/marketModels.js";

// streams
export {
  HermesPriceStream,
  LazerPriceStream,
  ORDER_EVENTS,
  type OrderEvent,
  type OrderEventCallback,
  OrderEventStream,
  PairDataStream,
  type PairDataCallback,
  type PriceCallback,
  type PriceUpdate,
} from "./streams/index.js";

// compute (also importable as a namespace: `import * as compute from "veranta-sdk/compute"`)
export * as compute from "./compute/index.js";
