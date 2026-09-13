import { describe, expect, it } from "vitest";
import { iterSse } from "../src/execution/sse.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

async function collect(response: Response) {
  const events = [];
  for await (const event of iterSse(response)) events.push(event);
  return events;
}

describe("iterSse", () => {
  it("parses id/event/data blocks and ignores comments", async () => {
    const events = await collect(
      sseResponse([
        ": hb\n\n",
        'id: 0\nevent: MarketOrderAccepted\ndata: {"trackingId":"abc"}\n\n',
        'id: 1\nevent: MarketOrderExecuted\ndata: {"orderId":"7","transactionHash":"0x1"}\n\n',
      ]),
    );
    expect(events).toEqual([
      { type: "MarketOrderAccepted", data: { trackingId: "abc" }, seq: 0 },
      { type: "MarketOrderExecuted", data: { orderId: "7", transactionHash: "0x1" }, seq: 1 },
    ]);
  });

  it("joins multi-line data and handles chunk splits mid-line", async () => {
    const events = await collect(sseResponse(['event: X\ndata: {"a"', ':1,\ndata: "b":2}\n\n']));
    expect(events).toEqual([{ type: "X", data: { a: 1, b: 2 }, seq: null }]);
  });

  it("handles CRLF line endings and non-JSON data", async () => {
    const events = await collect(sseResponse(["event: Y\r\ndata: not-json\r\n\r\n"]));
    expect(events).toEqual([{ type: "Y", data: { raw: "not-json" }, seq: null }]);
  });

  it("events without id get seq null (unpersisted)", async () => {
    const events = await collect(
      sseResponse(['event: Error\ndata: {"message":"request timed out"}\n\n']),
    );
    expect(events[0]!.seq).toBeNull();
  });
});
