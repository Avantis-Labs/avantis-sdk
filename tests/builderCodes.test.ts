/**
 * Builder-code v2 flow: per-order fee params + blitz routing.
 *
 * Mirrors the Python SDK's tests/test_builder_codes.py. `builderCode` + a
 * per-order `builderFeePercent` are sent to the tx-builder, which appends
 * the signed suffix `code || rate || 0x9481c2bc` to the INNER trading
 * calldata. Builder-fee market orders relay via blitz (the type-4 always
 * executes, so the fee always charges) instead of batched-market, and the
 * EIP-7702 authorization targets the canonical fee-charging template from
 * /v2/meta. The SDK never hard-codes registry/template addresses.
 */

import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Veranta, type VerantaOptions } from "../src/client.js";
import { DEFAULT_DELEGATION_ADDRESS, resolveConfig } from "../src/config.js";
import { ApiError, ConfigError } from "../src/errors.js";
import type { VerantaSigner } from "../src/signing/signer.js";

const TXB = "https://txb.test";
const RELAYER = "https://relayer.test";
const BATCHED = "https://batched.test";
const DATA = "https://data.test";
const RPC = "https://rpc.test";

// anvil account 0 (shared with the Python suite)
const TEST_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TRADER: Address = "0x1111111111111111111111111111111111111111";
const CODE = "MYAPP";

const META = {
  chainId: 31337,
  addresses: {
    tradingRouter: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    tradingStorage: "0x2222222222222222222222222222222222222222",
    usdc: "0x3333333333333333333333333333333333333333",
    referral: "0x4444444444444444444444444444444444444444",
    builderCode: "0x5555555555555555555555555555555555555555",
    delegationTemplate: "0x6666666666666666666666666666666666666666",
  },
  eip712: {
    trading: {
      name: "AvantisTrading",
      version: "1",
      chainId: 31337,
      verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    },
    signatureFormat: "rsv-65-bytes",
  },
  enums: { openOrderType: { market: 0, stop_limit: 1, limit: 2, market_pnl: 3 } },
  units: { price: "1e10", leverage: "1e10", usdc: "1e6" },
  defaults: { executionFeeWei: "0", intentDeadlineMs: 120000, slippagePercent: "1" },
};

/** Fixed-fee pairs plus an Upside twin listed as a separate _UPSIDE pair (testnet catalog). */
const TRADING_SNAPSHOT = {
  pairInfos: {
    "ETH/USD": {
      index: 1,
      from: "ETH",
      to: "USD",
      feed: { feedId: "0xeth" },
      storagePairParams: { isPnlTypeAllowed: 0 },
    },
    "BTC/USD": {
      index: 2,
      from: "BTC",
      to: "USD",
      feed: { feedId: "0xbtc" },
      storagePairParams: { isPnlTypeAllowed: 0 },
    },
    "BTC_UPSIDE/USD": {
      index: 116,
      from: "BTC_UPSIDE",
      to: "USD",
      feed: { feedId: "0xbtc" },
      storagePairParams: { isPnlTypeAllowed: 1 },
    },
  },
};

const CALLDATA = {
  to: META.addresses.tradingRouter,
  from: TRADER,
  data: "0xdeadbeef",
  value: "0x0",
  chainId: 31337,
  description: "Open long ETH/USD",
};

interface Recorded {
  method: string;
  url: URL;
  body: any;
}
type Responder = (req: Recorded) => Response;
interface Route {
  method: string;
  matches: (url: URL) => boolean;
  respond: Responder;
  calls: Recorded[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const ok = (data: unknown) => json({ ok: true, data });

/** Minimal fetch router: exact origin+path (string) or href regex; records every call. */
class FakeServer {
  private readonly routes: Route[] = [];
  readonly unmatched: Recorded[] = [];

  on(method: string, match: string | RegExp, respond: Responder): Route {
    const strip = (value: string) => value.replace(/\/$/, "");
    const matches =
      typeof match === "string"
        ? (url: URL) => strip(`${url.origin}${url.pathname}`) === strip(match)
        : (url: URL) => match.test(url.href);
    const route: Route = { method, matches, respond, calls: [] };
    this.routes.push(route);
    return route;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const req: Recorded = { method, url, body };
    const route = this.routes.find((r) => r.method === method && r.matches(url));
    if (!route) {
      this.unmatched.push(req);
      return json({ error: `unmatched ${method} ${href}` }, 599);
    }
    route.calls.push(req);
    return route.respond(req);
  };
}

/** /v2/meta, the pair snapshot, a 0x0-answering JSON-RPC, and a settling blitz relay. */
function mountCommon(server: FakeServer) {
  server.on("GET", `${TXB}/v2/meta`, () => ok(META));
  server.on("GET", `${DATA}/v2/trading`, () => json(TRADING_SNAPSHOT));
  server.on("POST", RPC, (req) => json({ jsonrpc: "2.0", id: req.body.id, result: "0x0" }));
  const relayCreate = server.on("POST", `${RELAYER}/relays`, () => json({ requestId: "req-7" }));
  server.on("GET", `${RELAYER}/relays/req-7`, () =>
    json({
      requestId: "req-7",
      status: "Finalised",
      receipt: { transactionHash: "0xbb", status: "0x1" },
    }),
  );
  return { relayCreate };
}

/** Delegate-key client (signer != trader) on isolated service URLs. */
function client(overrides: VerantaOptions = {}): Veranta {
  return new Veranta({
    network: "testnet",
    privateKey: TEST_KEY,
    trader: TRADER,
    txBuilderUrl: TXB,
    relayerUrl: RELAYER,
    batchedMarketUrl: BATCHED,
    dataApiUrl: DATA,
    rpcUrl: RPC,
    relayPollIntervalMs: 1,
    ...overrides,
  });
}

const openEth = (c: Veranta, extra: Record<string, unknown> = {}) =>
  c.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10, ...extra });

const ENV_KEYS = [
  "VERANTA_PRIVATE_KEY",
  "VERANTA_TRADER_ADDRESS",
  "VERANTA_EXECUTION",
  "VERANTA_RPC_URL",
  "VERANTA_NETWORK",
  "VERANTA_BUILDER_CODE",
  "VERANTA_BUILDER_FEE_PERCENT",
];
const savedEnv: Record<string, string | undefined> = {};
let server: FakeServer;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("builder codes: per-order rate + blitz routing", () => {
  it("relays a builder-fee open via blitz with builderCode/builderFeeRate and the canonical template", async () => {
    const { relayCreate } = mountCommon(server);
    const calldataRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));
    const intentRoute = server.on("POST", `${TXB}/v2/intents/open`, () => ok({}));
    const batchedRoute = server.on("POST", `${BATCHED}/market/execute-batched`, () => json({}));

    const receipt = await openEth(client({ builderCode: CODE, builderFeePercent: 0.05 }));

    expect(receipt.route).toBe("relayer-passthrough");
    expect(receipt.txHash).toBe("0xbb");
    // No intent, no batched-market: the fee suffix rides on the calldata leg only.
    expect(intentRoute.calls).toHaveLength(0);
    expect(batchedRoute.calls).toHaveLength(0);

    const body = calldataRoute.calls[0]!.body;
    expect(body.builderCode).toBe(CODE);
    expect(body.builderFeeRate).toBe("0.05");
    expect(body.orderType).toBe("market");
    expect(String(body.delegate).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

    // The EIP-7702 authorization targets the canonical template from /v2/meta.
    const relayBody = relayCreate.calls[0]!.body;
    expect(relayBody.wallet).toBe(TRADER);
    expect(relayBody.txParams.authorizationList).toHaveLength(1);
    expect(relayBody.txParams.authorizationList[0].address.toLowerCase()).toBe(
      META.addresses.delegationTemplate.toLowerCase(),
    );
    expect(server.unmatched).toEqual([]);
  });

  it("keeps an explicit delegationAddress even when a builder code is configured", async () => {
    const { relayCreate } = mountCommon(server);
    server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));
    const custom: Address = "0x7777777777777777777777777777777777777777";

    await openEth(
      client({ builderCode: CODE, builderFeePercent: 0.05, delegationAddress: custom }),
    );

    expect(relayCreate.calls[0]!.body.txParams.authorizationList[0].address.toLowerCase()).toBe(
      custom.toLowerCase(),
    );
  });

  it("per-call builderFeePercent overrides the config default", async () => {
    mountCommon(server);
    const closeRoute = server.on("POST", `${TXB}/v2/trade/close`, () => ok(CALLDATA));

    await client({ builderCode: CODE, builderFeePercent: 0.05 }).trade.marketClose("ETH/USD", 0, {
      collateralToClose: 100,
      builderFeePercent: 0.02,
    });

    expect(closeRoute.calls[0]!.body.builderFeeRate).toBe("0.02");
  });

  it("forces a zero rate on Upside opens/increases and keeps it on Upside closes", async () => {
    mountCommon(server);
    const openRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));
    const increaseRoute = server.on("POST", `${TXB}/v2/position/increase`, () => ok(CALLDATA));
    const closeRoute = server.on("POST", `${TXB}/v2/trade/close`, () => ok(CALLDATA));
    const c = client({ builderCode: CODE, builderFeePercent: 0.05 });

    await c.trade.marketOpen("BTC_UPSIDE", "long", { collateral: 100, leverage: 2 });
    await c.trade.increasePosition("BTC_UPSIDE", 0, { collateral: 50, leverage: 2 });
    await c.trade.marketClose("BTC_UPSIDE", 0, { collateralToClose: 100 });

    expect(openRoute.calls[0]!.body.orderType).toBe("market_pnl");
    expect(openRoute.calls[0]!.body.builderFeeRate).toBe("0");
    expect(increaseRoute.calls[0]!.body.builderFeeRate).toBe("0");
    // Closes are capped by the code's own PnL-close cap on-chain.
    expect(closeRoute.calls[0]!.body.builderFeeRate).toBe("0.05");
  });

  it("never attaches builder params to limit placements", async () => {
    mountCommon(server);
    const openRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));

    await client({ builderCode: CODE, builderFeePercent: 0.05 }).trade.limitOpen(
      "ETH/USD",
      "long",
      {
        collateral: 100,
        leverage: 10,
        price: 3000,
      },
    );

    const body = openRoute.calls[0]!.body;
    expect(body.orderType).toBe("limit");
    expect(body).not.toHaveProperty("builderCode");
    expect(body).not.toHaveProperty("builderFeeRate");
  });

  it("leaves the batched-market path untouched without builder params", async () => {
    mountCommon(server);
    const calldataRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));
    const intentRoute = server.on("POST", `${TXB}/v2/intents/open`, () =>
      json({ ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } }, 500),
    );
    const batchedRoute = server.on("POST", `${BATCHED}/market/execute-batched`, () => json({}));

    // The intent leg 500s -- proving it WAS requested (batched path).
    await expect(openEth(client())).rejects.toBeInstanceOf(ApiError);

    expect(intentRoute.calls).toHaveLength(1);
    expect(batchedRoute.calls).toHaveLength(0);
    for (const call of calldataRoute.calls) {
      expect(call.body).not.toHaveProperty("builderCode");
      expect(call.body).not.toHaveProperty("builderFeeRate");
    }
  });

  it("rejects misconfigured builder params before anything is built", async () => {
    mountCommon(server);
    const calldataRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));

    // Rate override without a configured code.
    await expect(openEth(client(), { builderFeePercent: 0.05 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(openEth(client(), { builderFeePercent: 0.05 })).rejects.toThrow(/no builder code/);
    // Code without any rate (config or per call).
    await expect(openEth(client({ builderCode: CODE }))).rejects.toThrow(/without a fee rate/);
    // Direct mode cannot charge builder fees (no 7702 template runs).
    await expect(
      openEth(client({ builderCode: CODE, builderFeePercent: 0.05, execution: "direct" })),
    ).rejects.toThrow(/relayer mode/);

    expect(calldataRoute.calls).toHaveLength(0);
  });

  it("refuses builder fees on signers that cannot sign EIP-7702 authorizations", async () => {
    mountCommon(server);
    const calldataRoute = server.on("POST", `${TXB}/v2/trade/open`, () => ok(CALLDATA));
    const sent: unknown[] = [];
    // A browser wallet: JSON-RPC account, can broadcast but not sign authorizations.
    const walletLike: VerantaSigner = {
      address: TEST_ADDRESS,
      canSignAuthorization: false,
      canSendTransaction: true,
      signTypedData: async () => {
        throw new Error("unexpected signTypedData");
      },
      signAuthorization: async () => {
        throw new Error("browser wallets cannot sign authorizations");
      },
      signTransaction: async () => {
        throw new Error("unexpected signTransaction");
      },
      sendTransaction: async (tx) => {
        sent.push(tx);
        return "0x77a11e7";
      },
    };
    const c = client({
      signer: walletLike,
      privateKey: undefined,
      builderCode: CODE,
      builderFeePercent: 0.05,
    });

    const attempt = openEth(c);
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(/EIP-7702-capable signer/);

    // Nothing was built or broadcast: no fee-less wallet transaction slipped through.
    expect(sent).toHaveLength(0);
    expect(calldataRoute.calls).toHaveLength(0);
  });
});

describe("builder codes: owner + trader onboarding", () => {
  it("registers a code with the three-cap params (caller-scoped, trader key)", async () => {
    const { relayCreate } = mountCommon(server);
    const registerRoute = server.on("POST", `${TXB}/v2/misc/builder-code/register`, () =>
      ok(CALLDATA),
    );

    await client({ trader: undefined }).account.registerBuilderCode(CODE, {
      feeCollector: TRADER,
      maxOpenFeePercent: 0.1,
      maxCloseFeePercent: 0.05,
      maxPnlCloseFeePercent: 0,
    });

    const body = registerRoute.calls[0]!.body;
    expect(body).toMatchObject({
      code: CODE,
      feeCollector: TRADER,
      maxOpenFeePercent: "0.1",
      maxCloseFeePercent: "0.05",
      maxPnlCloseFeePercent: "0",
    });
    expect(String(body.caller).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(body).not.toHaveProperty("isPercentFee");
    expect(body).not.toHaveProperty("delegate");
    // No builder params configured on this client: the plain Gelato template is used.
    expect(relayCreate.calls[0]!.body.txParams.authorizationList[0].address.toLowerCase()).toBe(
      DEFAULT_DELEGATION_ADDRESS.toLowerCase(),
    );
  });

  it("modifies a code with the same params", async () => {
    mountCommon(server);
    const modifyRoute = server.on("POST", `${TXB}/v2/misc/builder-code/modify`, () => ok(CALLDATA));

    await client({ trader: undefined }).account.modifyBuilderCode(CODE, {
      feeCollector: TRADER,
      maxOpenFeePercent: 0.2,
      maxCloseFeePercent: 0,
      maxPnlCloseFeePercent: 0.05,
    });

    expect(modifyRoute.calls[0]!.body).toMatchObject({
      code: CODE,
      feeCollector: TRADER,
      maxOpenFeePercent: "0.2",
      maxCloseFeePercent: "0",
      maxPnlCloseFeePercent: "0.05",
    });
  });

  it("blocks register/modify through a delegate key (msg.sender-scoped)", async () => {
    mountCommon(server);
    const registerRoute = server.on("POST", `${TXB}/v2/misc/builder-code/register`, () =>
      ok(CALLDATA),
    );

    await expect(
      client().account.registerBuilderCode(CODE, {
        feeCollector: TRADER,
        maxOpenFeePercent: 0.1,
        maxCloseFeePercent: 0.05,
        maxPnlCloseFeePercent: 0,
      }),
    ).rejects.toThrow(/cannot be routed through a delegate key/);
    expect(registerRoute.calls).toHaveLength(0);
  });

  it("approveBuilderFees approves USDC to the registry address from /v2/meta", async () => {
    mountCommon(server);
    const approveRoute = server.on("POST", `${TXB}/v2/token/approve`, () => ok(CALLDATA));
    const c = client({ trader: undefined });

    await c.account.approveBuilderFees();
    await c.account.approveBuilderFees(100);

    const unlimited = approveRoute.calls[0]!.body;
    expect(unlimited.spender).toBe(META.addresses.builderCode);
    expect(String(unlimited.trader).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(unlimited).not.toHaveProperty("amountUsdc");
    expect(approveRoute.calls[1]!.body.amountUsdc).toBe("100");
  });

  it("builderFeeAllowance reads the allowance with the registry as spender", async () => {
    mountCommon(server);
    const allowanceRoute = server.on("GET", `${TXB}/v2/allowance`, () =>
      ok({ balance: "5000000", allowance: "1000000", balanceUsdc: "5", allowanceUsdc: "1" }),
    );

    const info = await client().account.builderFeeAllowance();

    expect(info.allowanceUsdc).toBe("1");
    const url = allowanceRoute.calls[0]!.url;
    expect(url.searchParams.get("trader")).toBe(TRADER);
    expect(url.searchParams.get("spender")).toBe(META.addresses.builderCode);
  });

  it("looks a code up via GET /v2/builder-code", async () => {
    mountCommon(server);
    const lookup = server.on("GET", `${TXB}/v2/builder-code`, () =>
      ok({ code: "0x4d59415050", registered: false, owner: null, globalCapPercent: 1 }),
    );

    const info = await client().account.builderCode(CODE);

    expect(info.registered).toBe(false);
    expect(lookup.calls[0]!.url.searchParams.get("code")).toBe(CODE);
  });
});

describe("builder codes: config", () => {
  it("resolves VERANTA_BUILDER_CODE / VERANTA_BUILDER_FEE_PERCENT; explicit input wins", () => {
    process.env.VERANTA_BUILDER_CODE = CODE;
    process.env.VERANTA_BUILDER_FEE_PERCENT = "0.05";

    const fromEnv = resolveConfig({ network: "testnet" });
    expect(fromEnv.builderCode).toBe(CODE);
    expect(fromEnv.builderFeePercent).toBe("0.05");

    const explicit = resolveConfig({ builderCode: "OTHER", builderFeePercent: 0.1 });
    expect(explicit.builderCode).toBe("OTHER");
    expect(explicit.builderFeePercent).toBe(0.1);

    expect(resolveConfig({ network: "mainnet" }).builderCode).toBe(CODE);
    expect(resolveConfig().delegationAddress).toBe(DEFAULT_DELEGATION_ADDRESS);
  });
});
