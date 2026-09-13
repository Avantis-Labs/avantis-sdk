/**
 * SDK configuration: explicit options > environment variables > network
 * profile.
 *
 * Environment variables (Node only; browsers pass explicit options):
 *
 * - `AVANTIS_PRIVATE_KEY`    the signing key (delegate/agent key or trader key)
 * - `AVANTIS_TRADER_ADDRESS` if set and != key's address -> delegate mode
 * - `AVANTIS_EXECUTION`      "relayer" (default) | "direct"
 * - `AVANTIS_RPC_URL`        Base RPC. Required for execution=direct
 *                            (broadcast) and for relayer mode when signing
 *                            with the trader EOA directly (reads the
 *                            EIP-7702 authorization nonce). Not needed with
 *                            a delegate/API key (the normal setup).
 * - `AVANTIS_NETWORK`        "mainnet" (default) | "testnet"
 * - `AVANTIS_API_BASE_URL`   central-routing host (prod-api / staging-api);
 *                            /core, /twap, /batched-market, /blitz, /data
 *                            and /risk/v2 are derived from it unless
 *                            individually overridden
 * - `AVANTIS_TX_BUILDER_URL` / `AVANTIS_RELAYER_URL` / `AVANTIS_DATA_API_URL`
 *   / `AVANTIS_CORE_API_URL` / `AVANTIS_TWAP_API_URL`
 *   / `AVANTIS_BATCHED_MARKET_URL` / `AVANTIS_HISTORY_API_URL`
 *   / `AVANTIS_RISK_API_URL` / `AVANTIS_RISK_V2_API_URL`
 *   / `AVANTIS_FEED_URL`     per-service overrides
 * - `AVANTIS_BUILDER_CODE`   builder code to attribute order flow to (string
 *                            or 0x-hex bytes32)
 * - `AVANTIS_BUILDER_FEE_PERCENT` default per-order builder fee rate,
 *                            percent of notional (0.05 = 0.05%)
 */

import type { Address, Hex } from "viem";
import { ConfigError } from "./errors.js";
import type { ExecutionMode } from "./types.js";

/**
 * Gelato EIP-7702 delegation template (same on Base mainnet and the internal
 * testnet fork; from @gelatocloud/gasless constants).
 */
export const DEFAULT_DELEGATION_ADDRESS: Address = "0x5aF42746a8Af42d8a4708dF238C53F1F71abF0E0";

export interface NetworkProfile {
  name: "mainnet" | "testnet";
  apiBaseUrl: string;
  txBuilderUrl: string;
  historyApiUrl: string;
  /**
   * LEGACY risk-engine (dynamicSpread): standalone host. Testnet-only since
   * the 2026-08-12 cutover; empty = not deployed on that network.
   */
  riskApiUrl: string;
  feedUrl: string;
  // Centrally-routed services: derived from apiBaseUrl when left empty.
  relayerUrl?: string;
  coreApiUrl?: string;
  twapApiUrl?: string;
  batchedMarketUrl?: string;
  dataApiUrl?: string;
  riskV2ApiUrl?: string;
  hermesWsUrl?: string;
  pusherKey?: string;
  pusherCluster?: string;
}

/**
 * Central-routing path prefixes (HTTPRoute `central-routes` on the public
 * envoy gateway; rules rewrite the prefix to "/" before the backend). The
 * gateway also routes /ws (iris websocket app), which the SDK does not
 * consume.
 */
const CENTRAL_ROUTES = {
  coreApiUrl: "/core",
  twapApiUrl: "/twap",
  batchedMarketUrl: "/batched-market",
  relayerUrl: "/blitz",
  dataApiUrl: "/data",
  riskV2ApiUrl: "/risk/v2",
} as const;

export const TESTNET: NetworkProfile = {
  name: "testnet",
  apiBaseUrl: "https://staging-api.avantisfi.com",
  txBuilderUrl: "https://tx-builder-testnet.avantisfi.com",
  historyApiUrl: "https://testnet-api.avantisfi.com",
  riskApiUrl: "https://risk-api-testnet-public.avantisfi.com",
  feedUrl: "https://feed-v3-testnet.avantisfi.com",
  pusherKey: "f86bc7e9919fc938694a",
  pusherCluster: "mt1",
};

export const MAINNET: NetworkProfile = {
  name: "mainnet",
  apiBaseUrl: "https://prod-api.avantisfi.com",
  txBuilderUrl: "https://tx-builder.avantisfi.com",
  historyApiUrl: "https://api.avantisfi.com",
  // Production spreads come from the v2 engine at {apiBaseUrl}/risk/v2
  // (markets.spread()). The legacy engine was decommissioned at the
  // 2026-08-12 cutover, so markets.dynamicSpread() throws on mainnet.
  riskApiUrl: "",
  feedUrl: "https://feed-v3.avantisfi.com",
};

export const PROFILES: Record<string, NetworkProfile> = {
  testnet: TESTNET,
  mainnet: MAINNET,
};

const ENV_URL_OVERRIDES = {
  apiBaseUrl: "AVANTIS_API_BASE_URL",
  txBuilderUrl: "AVANTIS_TX_BUILDER_URL",
  relayerUrl: "AVANTIS_RELAYER_URL",
  dataApiUrl: "AVANTIS_DATA_API_URL",
  coreApiUrl: "AVANTIS_CORE_API_URL",
  twapApiUrl: "AVANTIS_TWAP_API_URL",
  batchedMarketUrl: "AVANTIS_BATCHED_MARKET_URL",
  historyApiUrl: "AVANTIS_HISTORY_API_URL",
  riskApiUrl: "AVANTIS_RISK_API_URL",
  riskV2ApiUrl: "AVANTIS_RISK_V2_API_URL",
  feedUrl: "AVANTIS_FEED_URL",
} as const;

type UrlField = keyof typeof ENV_URL_OVERRIDES;

/** Options accepted by the `Avantis` client constructor. */
export interface AvantisConfigInput {
  // identity / execution
  /** 0x-hex private key (backend / bots). Prefer `signer` for wallets. */
  privateKey?: Hex;
  /** Trader wallet. If set and != signer address -> delegate mode. */
  trader?: Address;
  execution?: ExecutionMode;
  /**
   * Base RPC. Broadcast path in direct mode; in relayer mode used only to
   * read the EIP-7702 authorization nonce, which is required when signing
   * with the trader EOA directly (delegate/API keys are fresh EOAs and need
   * no RPC at all).
   */
  rpcUrl?: string;

  // service endpoints
  network?: "mainnet" | "testnet";
  apiBaseUrl?: string;
  txBuilderUrl?: string;
  relayerUrl?: string;
  dataApiUrl?: string;
  coreApiUrl?: string;
  twapApiUrl?: string;
  batchedMarketUrl?: string;
  historyApiUrl?: string;
  riskApiUrl?: string;
  riskV2ApiUrl?: string;
  feedUrl?: string;
  hermesWsUrl?: string;
  pusherKey?: string;
  pusherCluster?: string;

  /**
   * EIP-7702 delegation template. Default is the plain Gelato template; when
   * builder params are set the engine resolves the canonical fee-charging
   * template from /v2/meta (addresses.delegationTemplate) instead. An
   * explicit value here always wins.
   */
  delegationAddress?: Address;

  /**
   * Builder codes: `builderCode` is the code to attribute order flow to (a
   * plain string like "MYAPP" or its 0x-hex 32-byte form) and
   * `builderFeePercent` the default per-order fee rate in percent of the
   * order's NOTIONAL (0.05 = 0.05%; 0 charges nothing). Trade methods can
   * override the rate per order.
   */
  builderCode?: string;
  builderFeePercent?: number | string;

  /**
   * Fallback when no RPC is available to estimate (the normal relayer
   * setup). updateMargin burns >1M gas and the blitz relayer caps relays at
   * 3M; the backend budgets 2M for the same call class.
   */
  defaultGasLimit?: number;

  // behavior
  timeoutMs?: number;
  relayPollIntervalMs?: number;
  relayPollTimeoutMs?: number;
}

/** Fully resolved SDK configuration. */
export interface AvantisConfig {
  privateKey?: Hex;
  trader?: Address;
  execution: ExecutionMode;
  rpcUrl?: string;

  network: "mainnet" | "testnet";
  apiBaseUrl: string;
  txBuilderUrl: string;
  relayerUrl: string;
  dataApiUrl: string;
  coreApiUrl: string;
  twapApiUrl: string;
  batchedMarketUrl: string;
  historyApiUrl: string;
  riskApiUrl: string;
  riskV2ApiUrl: string;
  feedUrl: string;
  hermesWsUrl: string;
  pusherKey?: string;
  pusherCluster: string;

  delegationAddress: Address;
  builderCode?: string;
  builderFeePercent?: number | string;
  defaultGasLimit: number;

  timeoutMs: number;
  relayPollIntervalMs: number;
  relayPollTimeoutMs: number;
}

function env(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name];
  return value ? value : undefined;
}

/** Build config from explicit options + env + network profile. */
export function resolveConfig(input: AvantisConfigInput = {}): AvantisConfig {
  const network = input.network ?? (env("AVANTIS_NETWORK") as "mainnet" | "testnet") ?? "mainnet";
  const profile = PROFILES[network];
  if (!profile) {
    throw new ConfigError(
      `Unknown network ${JSON.stringify(network)}; use one of ${Object.keys(PROFILES).join(", ")}`,
    );
  }

  const executionEnv = env("AVANTIS_EXECUTION")?.toLowerCase();
  if (executionEnv && executionEnv !== "relayer" && executionEnv !== "direct") {
    throw new ConfigError(`Invalid AVANTIS_EXECUTION ${executionEnv}; use "relayer" or "direct"`);
  }

  const urls = {} as Record<UrlField, string>;
  for (const field of Object.keys(ENV_URL_OVERRIDES) as UrlField[]) {
    urls[field] =
      input[field] ??
      env(ENV_URL_OVERRIDES[field]) ??
      (profile[field as keyof NetworkProfile] as string | undefined) ??
      "";
  }

  const config: AvantisConfig = {
    privateKey: input.privateKey ?? (env("AVANTIS_PRIVATE_KEY") as Hex | undefined),
    trader: input.trader ?? (env("AVANTIS_TRADER_ADDRESS") as Address | undefined),
    execution: input.execution ?? (executionEnv as ExecutionMode | undefined) ?? "relayer",
    rpcUrl: input.rpcUrl ?? env("AVANTIS_RPC_URL"),

    network,
    apiBaseUrl: urls.apiBaseUrl,
    txBuilderUrl: urls.txBuilderUrl,
    relayerUrl: urls.relayerUrl,
    dataApiUrl: urls.dataApiUrl,
    coreApiUrl: urls.coreApiUrl,
    twapApiUrl: urls.twapApiUrl,
    batchedMarketUrl: urls.batchedMarketUrl,
    historyApiUrl: urls.historyApiUrl,
    riskApiUrl: urls.riskApiUrl,
    riskV2ApiUrl: urls.riskV2ApiUrl,
    feedUrl: urls.feedUrl,
    hermesWsUrl: input.hermesWsUrl ?? profile.hermesWsUrl ?? "wss://hermes.pyth.network/ws",
    pusherKey: input.pusherKey ?? profile.pusherKey,
    pusherCluster: input.pusherCluster ?? profile.pusherCluster ?? "us2",

    delegationAddress: input.delegationAddress ?? DEFAULT_DELEGATION_ADDRESS,
    builderCode: input.builderCode ?? env("AVANTIS_BUILDER_CODE"),
    builderFeePercent: input.builderFeePercent ?? env("AVANTIS_BUILDER_FEE_PERCENT"),
    defaultGasLimit: input.defaultGasLimit ?? 2_000_000,

    timeoutMs: input.timeoutMs ?? 30_000,
    relayPollIntervalMs: input.relayPollIntervalMs ?? 1_000,
    relayPollTimeoutMs: input.relayPollTimeoutMs ?? 60_000,
  };

  // Central-routing derivation: any routed service left unset resolves to
  // {apiBaseUrl}{prefix}. Explicit values (input/env) win.
  const base = config.apiBaseUrl.replace(/\/$/, "");
  for (const [field, prefix] of Object.entries(CENTRAL_ROUTES) as [UrlField, string][]) {
    if (!config[field] && base) {
      (config as unknown as Record<string, string>)[field] = `${base}${prefix}`;
    }
  }
  return config;
}
