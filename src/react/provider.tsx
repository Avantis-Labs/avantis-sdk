/**
 * VerantaProvider: wires the core client into React.
 *
 * Sits INSIDE WagmiProvider + QueryClientProvider:
 *
 *     <WagmiProvider config={wagmiConfig}>
 *       <QueryClientProvider client={queryClient}>
 *         <VerantaProvider network="mainnet">{children}</VerantaProvider>
 *       </QueryClientProvider>
 *     </WagmiProvider>
 *
 * The provider derives an `Veranta` client from the connected wallet:
 * - with an active session key (1CT), the session key signs silently and
 *   the connected wallet is the trader (delegate mode);
 * - otherwise the wallet itself signs (typed-data popups; batched-market
 *   intents work, gasless blitz ops fall back to wallet transactions).
 *
 * Config props are captured on first mount (like the Veranta UI, which
 * reloads on network switch); remount with a `key` to change networks.
 */

import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { Veranta } from "../client.js";
import type { VerantaConfigInput } from "../config.js";
import { PriceFeedStore, type PriceTransport } from "./priceFeed.js";
import { readSessionKey, sessionSignerFromKey, useSessionKeyRevision } from "./sessionStore.js";

export interface VerantaProviderProps extends VerantaConfigInput {
  children: ReactNode;
  /**
   * Live-price transport: "worker" (default) runs the SSE stream + parsing
   * in a Web Worker like the production Veranta UI (keeps heavy tick
   * traffic off the main thread); "main" streams on the main thread.
   * Falls back to "main" automatically when Workers are unavailable.
   */
  priceTransport?: PriceTransport;
}

export interface VerantaContextValue {
  /** Client bound to the connected wallet (or read-only when disconnected). */
  client: Veranta;
  /** Read-only client (no signer); stable across wallet changes. */
  readClient: Veranta;
  config: VerantaConfigInput;
  priceFeed: PriceFeedStore;
  /** True when an active (stored) session key is signing instead of the wallet. */
  usingSessionKey: boolean;
}

const VerantaContext = createContext<VerantaContextValue | null>(null);

export function VerantaProvider({ children, priceTransport, ...config }: VerantaProviderProps) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  // Config is captured once; remount the provider (key prop) to change it.
  const [initialConfig] = useState<VerantaConfigInput>(() => ({ ...config }));
  const [initialTransport] = useState<PriceTransport>(() => priceTransport ?? "worker");
  const readClient = useMemo(() => new Veranta(initialConfig), [initialConfig]);
  const priceFeed = useMemo(
    () => new PriceFeedStore(readClient, initialTransport),
    [readClient, initialTransport],
  );
  useEffect(() => () => priceFeed.destroy(), [priceFeed]);

  // Re-render on session-key storage changes, then re-read the record.
  useSessionKeyRevision();
  const session = address ? readSessionKey(readClient.config.network, address) : null;
  const sessionKey = session?.privateKey;

  const value = useMemo<VerantaContextValue>(() => {
    const sessionSigner = sessionKey ? sessionSignerFromKey(sessionKey) : null;
    const signer = sessionSigner ?? walletClient ?? undefined;
    const client =
      signer !== undefined
        ? new Veranta({ ...initialConfig, signer, trader: address })
        : readClient;
    return {
      client,
      readClient,
      config: initialConfig,
      priceFeed,
      usingSessionKey: sessionSigner !== null,
    };
  }, [initialConfig, readClient, priceFeed, walletClient, address, sessionKey]);

  return <VerantaContext.Provider value={value}>{children}</VerantaContext.Provider>;
}

/** The full Veranta react context (client + price feed). */
export function useVerantaContext(): VerantaContextValue {
  const context = useContext(VerantaContext);
  if (!context) {
    throw new Error("Veranta hooks must be used inside <VerantaProvider>");
  }
  return context;
}

/**
 * The Veranta client for the connected wallet: session key signer when 1CT
 * is enabled, wallet signer otherwise, read-only when disconnected.
 */
export function useVeranta(): Veranta {
  return useVerantaContext().client;
}
