import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";

const ENV_KEYS = [
  "VERANTA_NETWORK",
  "VERANTA_API_BASE_URL",
  "VERANTA_CORE_API_URL",
  "VERANTA_PRIVATE_KEY",
  "VERANTA_TRADER_ADDRESS",
  "VERANTA_EXECUTION",
  "VERANTA_BUILDER_CODE",
  "AVANTIS_PRIVATE_KEY",
  "AVANTIS_NETWORK",
  "AVANTIS_CORE_API_URL",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveConfig", () => {
  it("derives central routes from apiBaseUrl", () => {
    const config = resolveConfig();
    expect(config.network).toBe("mainnet");
    expect(config.apiBaseUrl).toBe("https://prod-api.veranta.xyz");
    expect(config.coreApiUrl).toBe("https://prod-api.veranta.xyz/core");
    expect(config.twapApiUrl).toBe("https://prod-api.veranta.xyz/twap");
    expect(config.batchedMarketUrl).toBe("https://prod-api.veranta.xyz/batched-market");
    expect(config.relayerUrl).toBe("https://prod-api.veranta.xyz/blitz");
    expect(config.dataApiUrl).toBe("https://prod-api.veranta.xyz/data");
    expect(config.riskV2ApiUrl).toBe("https://prod-api.veranta.xyz/risk/v2");
    expect(config.txBuilderUrl).toBe("https://tx-builder.veranta.xyz");
  });

  it("testnet profile", () => {
    const config = resolveConfig({ network: "testnet" });
    expect(config.apiBaseUrl).toBe("https://staging-api.veranta.xyz");
    expect(config.txBuilderUrl).toBe("https://tx-builder-testnet.veranta.xyz");
    expect(config.coreApiUrl).toBe("https://staging-api.veranta.xyz/core");
    expect(config.pusherKey).toBe("f86bc7e9919fc938694a");
    // Testnet DX: the public fork RPC is defaulted in (explicit still wins).
    expect(config.rpcUrl).toBe("https://devnet-rpc.veranta.xyz");
    expect(resolveConfig({ network: "testnet", rpcUrl: "http://x" }).rpcUrl).toBe("http://x");
  });

  it("mainnet stays RPC-less by default", () => {
    expect(resolveConfig().rpcUrl).toBeUndefined();
  });

  it("env overrides beat profile; explicit input beats env", () => {
    process.env.VERANTA_NETWORK = "testnet";
    process.env.VERANTA_CORE_API_URL = "https://core.example";
    const fromEnv = resolveConfig();
    expect(fromEnv.network).toBe("testnet");
    expect(fromEnv.coreApiUrl).toBe("https://core.example");

    const explicit = resolveConfig({ network: "mainnet", coreApiUrl: "https://core2.example" });
    expect(explicit.network).toBe("mainnet");
    expect(explicit.coreApiUrl).toBe("https://core2.example");
  });

  it("central route derivation respects apiBaseUrl override", () => {
    process.env.VERANTA_API_BASE_URL = "https://staging-api.veranta.xyz";
    const config = resolveConfig();
    expect(config.batchedMarketUrl).toBe("https://staging-api.veranta.xyz/batched-market");
  });

  it("identity + execution from env", () => {
    process.env.VERANTA_PRIVATE_KEY = "0x".padEnd(66, "1");
    process.env.VERANTA_TRADER_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.VERANTA_EXECUTION = "direct";
    const config = resolveConfig();
    expect(config.privateKey).toBe("0x".padEnd(66, "1"));
    expect(config.trader).toBe("0x0000000000000000000000000000000000000001");
    expect(config.execution).toBe("direct");
  });

  it("falls back to pre-rename AVANTIS_* env vars with a warning; VERANTA_* wins", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AVANTIS_PRIVATE_KEY = "0x".padEnd(66, "2");
    process.env.AVANTIS_NETWORK = "testnet";
    process.env.AVANTIS_CORE_API_URL = "https://core.legacy";
    const legacy = resolveConfig();
    expect(legacy.privateKey).toBe("0x".padEnd(66, "2"));
    expect(legacy.network).toBe("testnet");
    expect(legacy.coreApiUrl).toBe("https://core.legacy");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AVANTIS_PRIVATE_KEY is deprecated"));

    process.env.VERANTA_NETWORK = "mainnet";
    process.env.VERANTA_CORE_API_URL = "https://core.new";
    const mixed = resolveConfig();
    expect(mixed.network).toBe("mainnet");
    expect(mixed.coreApiUrl).toBe("https://core.new");
    warn.mockRestore();
  });

  it("rejects unknown network", () => {
    expect(() => resolveConfig({ network: "goerli" as any })).toThrow(/Unknown network/);
  });
});
