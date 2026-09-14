/**
 * React hooks for Veranta v2 (wagmi + TanStack Query).
 *
 *     import { VerantaProvider, useMarketOpen, usePrice, usePositions,
 *              useSessionKey } from "veranta-sdk/react";
 *
 * Wrap your app (inside WagmiProvider + QueryClientProvider):
 *
 *     <VerantaProvider network="mainnet">{children}</VerantaProvider>
 */

export { verantaKeys } from "./keys.js";
export {
  VerantaProvider,
  type VerantaContextValue,
  type VerantaProviderProps,
  useVeranta,
  useVerantaContext,
} from "./provider.js";
export type { LivePrice, PriceTransport } from "./priceFeed.js";
export { createPriceWorker, supportsPriceWorker } from "./priceWorker.js";

// reads
export {
  useAllowance,
  useBuilderCodeInfo,
  useBuilderFeeAllowance,
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
export {
  type ApproveBuilderFeesVars,
  type ApproveStrategy,
  type ApproveUsdcVars,
  useApproveBuilderFees,
  useApproveUsdc,
} from "./approve.js";

// session keys / 1CT
export {
  type SessionKeyStatus,
  type UseSessionKeyResult,
  useSessionKey,
} from "./sessionKey.js";
export type { SessionKeyRecord } from "./sessionStore.js";
