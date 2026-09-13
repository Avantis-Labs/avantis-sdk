import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

const ENV_KEYS = [
  "AVANTIS_NETWORK",
  "AVANTIS_API_BASE_URL",
  "AVANTIS_CORE_API_URL",
  "AVANTIS_PRIVATE_KEY",
  "AVANTIS_TRADER_ADDRESS",
  "AVANTIS_EXECUTION",
  "AVANTIS_BUILDER_CODE",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveConfig", () => {
  it("derives central routes from apiBaseUrl", () => {
    const config = resolveConfig();
    expect(config.network).toBe("mainnet");
    expect(config.apiBaseUrl).toBe("https://prod-api.avantisfi.com");
    expect(config.coreApiUrl).toBe("https://prod-api.avantisfi.com/core");
    expect(config.twapApiUrl).toBe("https://prod-api.avantisfi.com/twap");
    expect(config.batchedMarketUrl).toBe("https://prod-api.avantisfi.com/batched-market");
    expect(config.relayerUrl).toBe("https://prod-api.avantisfi.com/blitz");
    expect(config.dataApiUrl).toBe("https://prod-api.avantisfi.com/data");
    expect(config.riskV2ApiUrl).toBe("https://prod-api.avantisfi.com/risk/v2");
    expect(config.txBuilderUrl).toBe("https://tx-builder.avantisfi.com");
  });

  it("testnet profile", () => {
    const config = resolveConfig({ network: "testnet" });
    expect(config.apiBaseUrl).toBe("https://staging-api.avantisfi.com");
    expect(config.txBuilderUrl).toBe("https://tx-builder-testnet.avantisfi.com");
    expect(config.coreApiUrl).toBe("https://staging-api.avantisfi.com/core");
    expect(config.pusherKey).toBe("f86bc7e9919fc938694a");
  });

  it("env overrides beat profile; explicit input beats env", () => {
    process.env.AVANTIS_NETWORK = "testnet";
    process.env.AVANTIS_CORE_API_URL = "https://core.example";
    const fromEnv = resolveConfig();
    expect(fromEnv.network).toBe("testnet");
    expect(fromEnv.coreApiUrl).toBe("https://core.example");

    const explicit = resolveConfig({ network: "mainnet", coreApiUrl: "https://core2.example" });
    expect(explicit.network).toBe("mainnet");
    expect(explicit.coreApiUrl).toBe("https://core2.example");
  });

  it("central route derivation respects apiBaseUrl override", () => {
    process.env.AVANTIS_API_BASE_URL = "https://staging-api.avantisfi.com";
    const config = resolveConfig();
    expect(config.batchedMarketUrl).toBe("https://staging-api.avantisfi.com/batched-market");
  });

  it("identity + execution from env", () => {
    process.env.AVANTIS_PRIVATE_KEY = "0x".padEnd(66, "1");
    process.env.AVANTIS_TRADER_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.AVANTIS_EXECUTION = "direct";
    const config = resolveConfig();
    expect(config.privateKey).toBe("0x".padEnd(66, "1"));
    expect(config.trader).toBe("0x0000000000000000000000000000000000000001");
    expect(config.execution).toBe("direct");
  });

  it("rejects unknown network", () => {
    expect(() => resolveConfig({ network: "goerli" as any })).toThrow(/Unknown network/);
  });
});
