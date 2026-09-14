/** TanStack Query key factory for all Veranta hooks. */

export const verantaKeys = {
  all: ["veranta"] as const,
  meta: () => [...verantaKeys.all, "meta"] as const,
  pairs: (network: string) => [...verantaKeys.all, network, "pairs"] as const,
  pair: (network: string, ref: string | number) =>
    [...verantaKeys.all, network, "pair", ref] as const,
  price: (network: string, ref: string | number) =>
    [...verantaKeys.all, network, "price", ref] as const,
  spread: (network: string, ref: string | number, args: unknown) =>
    [...verantaKeys.all, network, "spread", ref, args] as const,
  openInterests: (network: string) => [...verantaKeys.all, network, "open-interests"] as const,
  positions: (trader?: string) => [...verantaKeys.all, "positions", trader ?? ""] as const,
  twaps: (trader?: string) => [...verantaKeys.all, "twaps", trader ?? ""] as const,
  allowance: (trader?: string, spender?: string) =>
    [...verantaKeys.all, "allowance", trader ?? "", spender ?? "default"] as const,
  builderFeeAllowance: (trader?: string) =>
    [...verantaKeys.all, "allowance", trader ?? "", "builder-code-registry"] as const,
  balance: (trader?: string) => [...verantaKeys.all, "balance", trader ?? ""] as const,
  delegation: (trader?: string, delegate?: string) =>
    [...verantaKeys.all, "delegation", trader ?? "", delegate ?? ""] as const,
  builderCode: (code: string) => [...verantaKeys.all, "builder-code", code] as const,
  tradeHistory: (trader?: string, page?: number, limit?: number) =>
    [...verantaKeys.all, "trade-history", trader ?? "", page ?? 0, limit ?? 20] as const,
  orderHistory: (trader?: string, page?: number, limit?: number) =>
    [...verantaKeys.all, "order-history", trader ?? "", page ?? 0, limit ?? 20] as const,
  portfolio: (trader?: string) => [...verantaKeys.all, "portfolio", trader ?? ""] as const,
};
