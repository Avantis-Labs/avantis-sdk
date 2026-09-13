/** TanStack Query key factory for all Avantis hooks. */

export const avantisKeys = {
  all: ["avantis"] as const,
  meta: () => [...avantisKeys.all, "meta"] as const,
  pairs: (network: string) => [...avantisKeys.all, network, "pairs"] as const,
  pair: (network: string, ref: string | number) =>
    [...avantisKeys.all, network, "pair", ref] as const,
  price: (network: string, ref: string | number) =>
    [...avantisKeys.all, network, "price", ref] as const,
  spread: (network: string, ref: string | number, args: unknown) =>
    [...avantisKeys.all, network, "spread", ref, args] as const,
  openInterests: (network: string) => [...avantisKeys.all, network, "open-interests"] as const,
  positions: (trader?: string) => [...avantisKeys.all, "positions", trader ?? ""] as const,
  twaps: (trader?: string) => [...avantisKeys.all, "twaps", trader ?? ""] as const,
  allowance: (trader?: string, spender?: string) =>
    [...avantisKeys.all, "allowance", trader ?? "", spender ?? "default"] as const,
  balance: (trader?: string) => [...avantisKeys.all, "balance", trader ?? ""] as const,
  delegation: (trader?: string, delegate?: string) =>
    [...avantisKeys.all, "delegation", trader ?? "", delegate ?? ""] as const,
  builderCode: (code: string) => [...avantisKeys.all, "builder-code", code] as const,
  tradeHistory: (trader?: string, page?: number, limit?: number) =>
    [...avantisKeys.all, "trade-history", trader ?? "", page ?? 0, limit ?? 20] as const,
  orderHistory: (trader?: string, page?: number, limit?: number) =>
    [...avantisKeys.all, "order-history", trader ?? "", page ?? 0, limit ?? 20] as const,
  portfolio: (trader?: string) => [...avantisKeys.all, "portfolio", trader ?? ""] as const,
};
