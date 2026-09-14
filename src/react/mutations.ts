/**
 * Trading mutation hooks. Each wraps the corresponding client.trade /
 * client.account method in a TanStack mutation and invalidates the
 * position/balance queries on settle (immediately + 5s + 15s, covering
 * indexer lag like the Veranta delegate UI).
 *
 * Batched-market lifecycle events stream through the hook's `onEvent`
 * option (MarketOrderAccepted -> AttemptFailed* -> terminal).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { PairRef } from "../api/trade.js";
import type { BatchedMarketEventHook } from "../execution/batchedMarket.js";
import type { ExecutionReceipt, MarginAction, Num, Side, TriggerType } from "../types.js";
import { verantaKeys } from "./keys.js";
import { useVerantaContext } from "./provider.js";
import { useTrader } from "./queries.js";

export interface TradeMutationOptions {
  /** Observes batched-market lifecycle events (relayer route only). */
  onEvent?: BatchedMarketEventHook;
  onSuccess?: (receipt: ExecutionReceipt) => void;
  onError?: (error: Error) => void;
}

/** Invalidate positions/balances now and again after indexer lag. */
export function useInvalidatePositions(): () => void {
  const queryClient = useQueryClient();
  const trader = useTrader();
  return useCallback(() => {
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: verantaKeys.positions(trader) });
      void queryClient.invalidateQueries({ queryKey: verantaKeys.balance(trader) });
      void queryClient.invalidateQueries({ queryKey: verantaKeys.allowance(trader) });
      void queryClient.invalidateQueries({ queryKey: verantaKeys.builderFeeAllowance(trader) });
      void queryClient.invalidateQueries({ queryKey: verantaKeys.twaps(trader) });
    };
    invalidate();
    setTimeout(invalidate, 5_000);
    setTimeout(invalidate, 15_000);
  }, [queryClient, trader]);
}

function useTradeMutation<Vars>(
  run: (vars: Vars, onEvent?: BatchedMarketEventHook) => Promise<ExecutionReceipt>,
  options: TradeMutationOptions = {},
) {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: (vars: Vars) => run(vars, options.onEvent),
    onSuccess: (receipt) => {
      invalidate();
      options.onSuccess?.(receipt);
    },
    onError: (error) => options.onError?.(error as Error),
  });
}

// ---------------------------------------------------------------- opens

export interface MarketOpenVars {
  pair: PairRef;
  side: Side;
  collateral: Num;
  leverage: Num;
  openPrice?: Num;
  takeProfit?: Num;
  stopLoss?: Num;
  slippagePercent?: Num;
  builderFeePercent?: Num;
}

/** Open a market position (Upside pairs route as PnL automatically). */
export function useMarketOpen(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<MarketOpenVars>(
    ({ pair, side, ...args }, onEvent) => client.trade.marketOpen(pair, side, { ...args, onEvent }),
    options,
  );
}

export interface LimitOpenVars {
  pair: PairRef;
  side: Side;
  collateral: Num;
  leverage: Num;
  price: Num;
  stop?: boolean;
  takeProfit?: Num;
  stopLoss?: Num;
  slippagePercent?: Num;
}

/** Place a limit / stop-limit open order (escrows USDC on placement). */
export function useLimitOpen(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<LimitOpenVars>(
    ({ pair, side, ...args }) => client.trade.limitOpen(pair, side, args),
    options,
  );
}

// ---------------------------------------------------------------- closes

export interface MarketCloseVars {
  pair: PairRef;
  tradeIndex: number;
  /** Pass the full collateral for a full close. */
  collateralToClose: Num;
  expectedPrice?: Num;
  builderFeePercent?: Num;
}

export function useMarketClose(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<MarketCloseVars>(
    ({ pair, tradeIndex, ...args }, onEvent) =>
      client.trade.marketClose(pair, tradeIndex, { ...args, onEvent }),
    options,
  );
}

// ---------------------------------------------------------------- limit mgmt

export function useUpdateLimitOrder(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    orderIndex: number;
    price: Num;
    slippagePercent?: Num;
    takeProfit?: Num;
    stopLoss?: Num;
  }>(
    ({ pair, orderIndex, ...args }) => client.trade.updateLimitOrder(pair, orderIndex, args),
    options,
  );
}

export function useCancelLimitOrder(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{ pair: PairRef; orderIndex: number }>(
    ({ pair, orderIndex }) => client.trade.cancelLimitOrder(pair, orderIndex),
    options,
  );
}

// ---------------------------------------------------------------- position updates

export function useUpdateMargin(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    tradeIndex: number;
    action: MarginAction;
    amount: Num;
  }>(
    ({ pair, tradeIndex, action, amount }) =>
      client.trade.updateMargin(pair, tradeIndex, action, amount),
    options,
  );
}

export function useIncreasePosition(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    tradeIndex: number;
    collateral: Num;
    leverage: Num;
    openPrice?: Num;
    slippagePercent?: Num;
    builderFeePercent?: Num;
  }>(
    ({ pair, tradeIndex, ...args }, onEvent) =>
      client.trade.increasePosition(pair, tradeIndex, { ...args, onEvent }),
    options,
  );
}

// ---------------------------------------------------------------- TP/SL

/**
 * Update the GLOBAL (on-chain) TP/SL. `undefined` keeps a leg, `0` clears
 * it (tp=0 resets to the max-gain cap).
 */
export function useUpdateTpSl(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    tradeIndex: number;
    takeProfit?: Num;
    stopLoss?: Num;
  }>(({ pair, tradeIndex, ...args }) => client.trade.updateTpSl(pair, tradeIndex, args), options);
}

export interface PartialTpSlVars {
  pair: PairRef;
  tradeIndex: number;
  side: Side;
  kind: "tp" | "sl";
  coinExposure: Num;
  trigger?: TriggerType;
  price?: Num;
  percentage?: Num;
  openTimestamp?: number;
}

/** Create / update / cancel partial (off-chain) TP/SL trigger orders. */
export function usePartialTpSl(options: { onSettled?: () => void } = {}) {
  const { client } = useVerantaContext();
  const invalidate = useInvalidatePositions();
  const settled = () => {
    invalidate();
    options.onSettled?.();
  };
  const create = useMutation({
    mutationFn: ({ pair, tradeIndex, ...args }: PartialTpSlVars) =>
      client.trade.partialTpSl(pair, tradeIndex, args),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({ entityId, pair, tradeIndex, ...args }: PartialTpSlVars & { entityId: string }) =>
      client.trade.updatePartialTpSl(entityId, pair, tradeIndex, args),
    onSettled: settled,
  });
  const cancel = useMutation({
    mutationFn: (order: string | Record<string, any>) => client.trade.cancelPartialTpSl(order),
    onSettled: settled,
  });
  return { create, update, cancel };
}

// ---------------------------------------------------------------- TWAP

export function useTwapOpen(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    side: Side;
    collateral: Num;
    runTimeSeconds: number;
    leverage: Num;
    maxLeverage: Num;
    coinExposure?: Num;
  }>(({ pair, side, ...args }) => client.trade.twapOpen(pair, side, args), options);
}

export function useTwapClose(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    pair: PairRef;
    tradeIndex: number;
    coinExposureToClose: Num;
    runTimeSeconds: number;
  }>(({ pair, tradeIndex, ...args }) => client.trade.twapClose(pair, tradeIndex, args), options);
}

export function useTwapCancel(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{ twapId: number | bigint }>(
    ({ twapId }) => client.trade.twapCancel(twapId),
    options,
  );
}

// ---------------------------------------------------------------- builder codes

export function useRegisterBuilderCode(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    code: string;
    feeCollector: `0x${string}`;
    maxOpenFeePercent: Num;
    maxCloseFeePercent: Num;
    maxPnlCloseFeePercent: Num;
  }>(({ code, ...args }) => client.account.registerBuilderCode(code, args), options);
}

export function useModifyBuilderCode(options: TradeMutationOptions = {}) {
  const { client } = useVerantaContext();
  return useTradeMutation<{
    code: string;
    feeCollector: `0x${string}`;
    maxOpenFeePercent: Num;
    maxCloseFeePercent: Num;
    maxPnlCloseFeePercent: Num;
  }>(({ code, ...args }) => client.account.modifyBuilderCode(code, args), options);
}
