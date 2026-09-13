/**
 * React hooks for Avantis v2 (wagmi + TanStack Query).
 *
 *     import { AvantisProvider, useMarketOpen, usePrice, usePositions,
 *              useSessionKey } from "avantis-sdk/react";
 *
 * Wrap your app (inside WagmiProvider + QueryClientProvider):
 *
 *     <AvantisProvider network="mainnet">{children}</AvantisProvider>
 */

export { avantisKeys } from "./keys.js";
export {
  AvantisProvider,
  type AvantisContextValue,
  type AvantisProviderProps,
  useAvantis,
  useAvantisContext,
} from "./provider.js";
export type { LivePrice } from "./priceFeed.js";

// reads
export {
  useAllowance,
  useBuilderCodeInfo,
  useDelegationStatus,
  useOpenInterests,
  useOrderHistory,
  usePair,
  usePairs,
  usePortfolioPnl,
  usePositions,
  usePrice,
  useSpread,
  useTradeHistory,
  useTrader,
  useTradingSnapshot,
  useTwaps,
  useUsdcBalance,
} from "./queries.js";

// mutations
export {
  type LimitOpenVars,
  type MarketCloseVars,
  type MarketOpenVars,
  type PartialTpSlVars,
  type TradeMutationOptions,
  useCancelLimitOrder,
  useIncreasePosition,
  useInvalidatePositions,
  useLimitOpen,
  useMarketClose,
  useMarketOpen,
  useModifyBuilderCode,
  usePartialTpSl,
  useRegisterBuilderCode,
  useTwapCancel,
  useTwapClose,
  useTwapOpen,
  useUpdateLimitOrder,
  useUpdateMargin,
  useUpdateTpSl,
} from "./mutations.js";

// approvals
export { type ApproveUsdcVars, useApproveUsdc } from "./approve.js";

// session keys / 1CT
export {
  type SessionKeyStatus,
  type UseSessionKeyResult,
  useSessionKey,
} from "./sessionKey.js";
export type { SessionKeyRecord } from "./sessionStore.js";
