import { describe, expect, it } from "vitest";
import { RelayError } from "../src/errors.js";
import { BatchedMarketClient } from "../src/execution/batchedMarket.js";
import { HttpTransport } from "../src/transport.js";

function sseBody(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
}

function makeClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const transport = new HttpTransport({
    fetch: (async (url: any, init?: any) => handler(String(url), init)) as typeof fetch,
  });
  return new BatchedMarketClient(transport, "https://bm.test", {
    pollIntervalMs: 5,
    timeoutMs: 2_000,
  });
}

const ERC712 = { userIntent: "0xdead", userSignature: "0xbeef" };

describe("BatchedMarketClient", () => {
  it("settles on MarketOrderExecuted and exposes txHash/orderId/attempts", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody([
            'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-1"}\n\n',
            'id: 1\nevent: AttemptFailed\ndata: {"attempt":1,"code":"NO_PRICE","willRetry":true}\n\n',
            'id: 2\nevent: MarketOrderInitiated\ndata: {"orderId":"42"}\n\n',
            'id: 3\nevent: MarketOrderExecuted\ndata: {"orderId":"42","transactionHash":"0xabc"}\n\n',
          ]),
        ),
    );
    const seen: string[] = [];
    const outcome = await client.execute(0, ERC712, undefined, {
      onEvent: (e) => {
        seen.push(e.type);
      },
    });
    expect(outcome.trackingId).toBe("t-1");
    expect(outcome.txHash).toBe("0xabc");
    expect(outcome.orderId).toBe(42);
    expect(outcome.attemptFailures).toHaveLength(1);
    expect(seen).toEqual([
      "MarketOrderAccepted",
      "AttemptFailed",
      "MarketOrderInitiated",
      "MarketOrderExecuted",
    ]);
  });

  it("throws RelayError with code on terminal Error", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody([
            'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-2"}\n\n',
            'id: 1\nevent: Error\ndata: {"code":"WrongSl","message":"sl rejected"}\n\n',
          ]),
        ),
    );
    const error = await client.execute(0, ERC712).catch((e) => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe("WrongSl");
    expect(error.requestId).toBe("t-2");
  });

  it("throws RelayError on MarketOrderCanceled", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody([
            'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-3"}\n\n',
            'id: 1\nevent: MarketOrderCanceled\ndata: {"reason":"slippage"}\n\n',
          ]),
        ),
    );
    await expect(client.execute(0, ERC712)).rejects.toBeInstanceOf(RelayError);
  });

  it("falls back to status polling on STREAM_TIMEOUT", async () => {
    let statusCalls = 0;
    const client = makeClient((url) => {
      if (url.includes("/status")) {
        statusCalls++;
        return new Response(
          JSON.stringify({
            events: [
              {
                seq: 1,
                type: "MarketOrderExecuted",
                payload: { orderId: "9", transactionHash: "0xdef" },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        sseBody([
          'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-4"}\n\n',
          'event: Error\ndata: {"code":"STREAM_TIMEOUT","message":"stream timed out"}\n\n',
        ]),
      );
    });
    const outcome = await client.execute(0, ERC712);
    expect(statusCalls).toBeGreaterThan(0);
    expect(outcome.txHash).toBe("0xdef");
    expect(outcome.orderId).toBe(9);
  });

  it("unpersisted Error without code is a rejection", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody([
            'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-5"}\n\n',
            'event: Error\ndata: {"message":"boom"}\n\n',
          ]),
        ),
    );
    await expect(client.execute(0, ERC712)).rejects.toBeInstanceOf(RelayError);
  });

  it("wait=false returns after MarketOrderAccepted", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody(['id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-6"}\n\n']),
        ),
    );
    const outcome = await client.execute(0, ERC712, undefined, { wait: false });
    expect(outcome.trackingId).toBe("t-6");
    expect(outcome.terminal).toBeNull();
  });

  it("ignores unknown non-terminal event types", async () => {
    const client = makeClient(
      () =>
        new Response(
          sseBody([
            'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"t-7"}\n\n',
            'id: 1\nevent: SomeFutureEvent\ndata: {"x":1}\n\n',
            'id: 2\nevent: MarketOrderExecuted\ndata: {"transactionHash":"0x9"}\n\n',
          ]),
        ),
    );
    const outcome = await client.execute(0, ERC712);
    expect(outcome.txHash).toBe("0x9");
    expect(outcome.events.map((e) => e.type)).toContain("SomeFutureEvent");
  });
});
