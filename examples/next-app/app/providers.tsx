"use client";

/**
 * Provider stack: WagmiProvider -> QueryClientProvider -> AvantisProvider.
 *
 * Works with ANY wagmi-compatible wallet layer: swap `injected()` for
 * RainbowKit, ConnectKit, Privy, Reown AppKit connectors — the Avantis
 * hooks don't care which one you use.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AvantisProvider } from "avantis-sdk/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { http, WagmiProvider, createConfig } from "wagmi";
import { base } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: { [base.id]: http() },
  // Testnet (Avantis Base fork, same chainId): point BOTH layers at it —
  //   transports: { [base.id]: http(TESTNET_RPC_URL) }   (TESTNET_RPC_URL from "avantis-sdk")
  //   <AvantisProvider network="testnet">
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AvantisProvider network="mainnet">{children}</AvantisProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
