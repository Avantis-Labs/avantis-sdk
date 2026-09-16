import { describe, expect, it } from "vitest";
import { Veranta } from "../src/index.js";

describe("Veranta custom fetch", () => {
  it("routes every SDK request through the fetch passed to the client", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new Veranta({ network: "testnet", fetch: fetchFn });
    const body = await client.transport.json("GET", "https://testnet-api.veranta.xyz/v2/ping");
    expect(body).toEqual({ ok: true });
    expect(calls).toEqual(["GET https://testnet-api.veranta.xyz/v2/ping"]);
  });

  it("falls back to the global fetch when none is given", () => {
    expect(() => new Veranta({ network: "testnet" })).not.toThrow();
  });
});
