/** Read hooks: market data, account state, history. All TanStack queries. */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import type { UserData } from "../api/accountModels.js";
import type { PairInfo, TradingSnapshot } from "../api/marketModels.js";
import type { SpreadQuote } from "../api/markets.js";
import type { Num } from "../types.js";
import { avantisKeys } from "./keys.js";
import type { LivePrice } from "./priceFeed.js";
import { useAvantisContext } from "./provider.js";

/** The connected trader address (wagmi account). */
export function useTrader(): Address | undefined {
  return useAccount().address;
}

/** Full /v2/trading snapshot (5s cache in the core client). */
export function useTradingSnapshot(options: { refetchIntervalMs?: number } = {}) {
  const { readClient } = useAvantisContext();
  return useQuery({
    queryKey: avantisKeys.pairs(readClient.config.network),
    queryFn: () => readClient.markets.snapshot(),
    refetchInterval: options.refetchIntervalMs ?? 15_000,
  }) as UseQueryResult<TradingSnapshot>;
}

/** All pairs keyed by index. */
export function usePairs() {
  const { readClient } = useAvantisContext();
  return useQuery({
    queryKey: [...avantisKeys.pairs(readClient.config.network), "map"],
    queryFn: async () => await readClient.markets.pairs(),
    refetchInterval: 15_000,
  }) as UseQueryResult<Map<number, PairInfo>>;
}

/** One pair by symbol ("ETH/USD") or index. */
export function usePair(ref: string | number | undefined) {
  const { readClient } = useAvantisContext();
  return useQuery({
    queryKey: avantisKeys.pair(readClient.config.network, ref ?? ""),
    queryFn: async () => await readClient.markets.pair(ref!),
    enabled: ref !== undefined,
  }) as UseQueryResult<PairInfo>;
}

/**
 * Live price for a pair, streamed over the shared Lazer SSE feed.
 *
 * Returns undefined until the first tick (an initial REST snapshot seeds
 * the value so it renders quickly).
 */
export function usePrice(ref: string | number | undefined): LivePrice | undefined {
  const { readClient, priceFeed } = useAvantisContext();
  const pairQuery = usePair(ref);
  const pairIndex = pairQuery.data?.index;

  const live = useSyncExternalStore(
    (listener) => (pairIndex === undefined ? () => {} : priceFeed.track(pairIndex, listener)),
    () => (pairIndex === undefined ? undefined : priceFeed.get(pairIndex)),
    () => undefined,
  );

  // REST seed so the UI has a price before the stream's first tick.
  const [seed, setSeed] = useState<LivePrice | undefined>(undefined);
  useEffect(() => {
    if (pairIndex === undefined || live) return;
    let cancelled = false;
    readClient.markets
      .price(pairIndex)
      .then((price) => {
        if (!cancelled) setSeed({ price });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pairIndex, live, readClient]);

  return live ?? seed;
}

/** Quoted spread from the risk-engine v2 (see markets.spread). */
export function useSpread(
  ref: string | number | undefined,
  args: {
    isLong: boolean;
    coinSize?: Num;
    collateral?: Num;
    leverage?: Num;
    isOpen?: boolean;
    orderType?: number | string;
    wantedPrice?: Num;
  },
  options: { enabled?: boolean; refetchIntervalMs?: number } = {},
) {
  const { readClient } = useAvantisContext();
  const trader = useTrader();
  const stableArgs = useMemo(() => JSON.stringify(args), [args]);
  return useQuery({
    queryKey: avantisKeys.spread(readClient.config.network, ref ?? "", stableArgs),
    queryFn: async () => await readClient.markets.spread(ref!, { ...args, trader }),
    enabled: (options.enabled ?? true) && ref !== undefined,
    refetchInterval: options.refetchIntervalMs ?? 5_000,
  }) as UseQueryResult<SpreadQuote>;
}

/** Live per-pair long/short OI (core API). */
export function useOpenInterests(options: { refetchIntervalMs?: number } = {}) {
  const { readClient } = useAvantisContext();
  return useQuery({
    queryKey: avantisKeys.openInterests(readClient.config.network),
    queryFn: () => readClient.markets.openInterests(),
    refetchInterval: options.refetchIntervalMs ?? 10_000,
  });
}

/** Open positions + limit orders for the connected trader. */
export function usePositions(options: { trader?: Address; refetchIntervalMs?: number } = {}) {
  const { client } = useAvantisContext();
  const connected = useTrader();
  const trader = options.trader ?? connected;
  return useQuery({
    queryKey: avantisKeys.positions(trader),
    queryFn: async () => await client.account.positions(trader),
    enabled: !!trader,
    refetchInterval: options.refetchIntervalMs ?? 5_000,
  }) as UseQueryResult<UserData>;
}

/** TWAP orders for the connected trader. */
export function useTwaps(
  options: { trader?: Address; includeCanceled?: boolean; page?: number; pageSize?: number } = {},
) {
  const { client } = useAvantisContext();
  const connected = useTrader();
  const trader = options.trader ?? connected;
  return useQuery({
    queryKey: [...avantisKeys.twaps(trader), options.page ?? 0],
    queryFn: async () => await client.account.twaps(trader, options),
    enabled: !!trader,
    refetchInterval: 10_000,
  });
}

/** USDC balance + allowance (spender defaults to TradingStorage). */
export function useAllowance(options: { spender?: Address; refetchIntervalMs?: number } = {}) {
  const { client } = useAvantisContext();
  const trader = useTrader();
  return useQuery({
    queryKey: avantisKeys.allowance(trader, options.spender),
    queryFn: async () => await client.account.allowance(options.spender),
    enabled: !!trader,
    refetchInterval: options.refetchIntervalMs ?? 10_000,
  });
}

/** USDC wallet balance in human units. */
export function useUsdcBalance() {
  const { client } = useAvantisContext();
  const trader = useTrader();
  return useQuery({
    queryKey: avantisKeys.balance(trader),
    queryFn: async () => await client.account.usdcBalance(),
    enabled: !!trader,
    refetchInterval: 10_000,
  });
}

/** Delegation status for (trader, delegate). */
export function useDelegationStatus(delegate?: Address) {
  const { client } = useAvantisContext();
  const trader = useTrader();
  return useQuery({
    queryKey: avantisKeys.delegation(trader, delegate),
    queryFn: async () => await client.account.delegationStatus(delegate),
    enabled: !!trader && !!delegate,
    refetchInterval: 15_000,
  });
}

/** Builder-code registry lookup. */
export function useBuilderCodeInfo(code: string | undefined) {
  const { readClient } = useAvantisContext();
  return useQuery({
    queryKey: avantisKeys.builderCode(code ?? ""),
    queryFn: async () => await readClient.account.builderCode(code!),
    enabled: !!code,
  });
}

/** Paged fill history (info API). */
export function useTradeHistory(options: { trader?: Address; page?: number; limit?: number } = {}) {
  const { readClient } = useAvantisContext();
  const connected = useTrader();
  const trader = options.trader ?? connected;
  return useQuery({
    queryKey: avantisKeys.tradeHistory(trader, options.page, options.limit),
    queryFn: async () =>
      await readClient.info.tradeHistory(trader!, options.page ?? 0, options.limit ?? 20),
    enabled: !!trader,
  });
}

/** Paged order history (info API). */
export function useOrderHistory(options: { trader?: Address; page?: number; limit?: number } = {}) {
  const { readClient } = useAvantisContext();
  const connected = useTrader();
  const trader = options.trader ?? connected;
  return useQuery({
    queryKey: avantisKeys.orderHistory(trader, options.page, options.limit),
    queryFn: async () =>
      await readClient.info.orderHistory(trader!, options.page ?? 0, options.limit ?? 20),
    enabled: !!trader,
  });
}

/** Portfolio PnL summary (info API). */
export function usePortfolioPnl(options: { trader?: Address; grouped?: boolean } = {}) {
  const { readClient } = useAvantisContext();
  const connected = useTrader();
  const trader = options.trader ?? connected;
  return useQuery({
    queryKey: [...avantisKeys.portfolio(trader), options.grouped ?? false],
    queryFn: async () => await readClient.info.portfolioPnl(trader!, options),
    enabled: !!trader,
  });
}
