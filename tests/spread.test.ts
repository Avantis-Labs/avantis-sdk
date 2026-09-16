import { describe, expect, it } from "vitest";
import { MarketsApi } from "../src/api/markets.js";
import { resolveConfig } from "../src/config.js";
import { HttpTransport } from "../src/transport.js";

const PAIR = {
  index: 1,
  from: "ETH",
  to: "USD",
  groupIndex: 0,
  isPairListed: true,
  feed: { feedId: "0xeth", attributes: { symbol: "Crypto.ETH/USD", assetType: "crypto" } },
};

/** A MarketsApi whose snapshot and spread calls are answered by a recording fetch. */
function markets(record: (url: string, body: unknown) => void) {
  const cfg = resolveConfig({ network: "testnet" });
  const transport = new HttpTransport({
    fetch: (async (url: any, init?: any) => {
      const target = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      record(target, body);
      if (target.includes("/v2/trading")) {
        return new Response(JSON.stringify({ pairInfos: { "1": PAIR }, groupInfos: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ spreadPct: 0.02, spreadMechanism: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return new MarketsApi(cfg, transport);
}

describe("markets.spread request body", () => {
  it("sends the leverage tier and the close side when given", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const api = markets((url, body) => calls.push({ url, body }));
    await api.spread(1, {
      isLong: true,
      collateral: 100,
      leverage: 5,
      wantedPrice: 2500,
      isOpen: false,
      trader: "0x1111111111111111111111111111111111111111",
    });
    const spread = calls.find((c) => c.url.endsWith("/spread"));
    expect(spread).toBeDefined();
    expect(spread!.body).toMatchObject({
      pairIndex: 1,
      isLong: true,
      isOpen: false,
      trader: "0x1111111111111111111111111111111111111111",
      coinSize10: "2000000000",
      wantedPrice10: "25000000000000",
      leverage10: "50000000000",
    });
  });

  it("omits leverage10 when the size is given in coin units without leverage", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const api = markets((url, body) => calls.push({ url, body }));
    await api.spread(1, { isLong: false, coinSize: 0.5 });
    const spread = calls.find((c) => c.url.endsWith("/spread"));
    expect(spread!.body.leverage10).toBeUndefined();
    expect(spread!.body.isOpen).toBe(true);
  });
});
