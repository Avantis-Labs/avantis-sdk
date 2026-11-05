import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "../src/execution/rpc.js";

const RECEIPT = { status: "0x1", blockNumber: "0x10" };

/** Stubs fetch so the receipt shows up on the `arrivesOnPoll`-th receipt request. */
function stubRpc(arrivesOnPoll: number) {
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body));
      let result: unknown = null;
      if (method === "eth_getTransactionReceipt") {
        polls += 1;
        result = polls >= arrivesOnPoll ? RECEIPT : null;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { polls: () => polls };
}

describe("JsonRpcClient.waitForReceipt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls every 250 ms by default (Base blocks are 200 ms since Denim)", async () => {
    const rpc = stubRpc(4);
    const done = new JsonRpcClient("https://rpc.test").waitForReceipt("0xabc");

    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.polls()).toBe(1); // the first poll is immediate
    await vi.advanceTimersByTimeAsync(249);
    expect(rpc.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.polls()).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual(RECEIPT);
    expect(rpc.polls()).toBe(4);
  });

  it("keeps pollMs as an option", async () => {
    const rpc = stubRpc(3);
    const done = new JsonRpcClient("https://rpc.test").waitForReceipt("0xabc", 120_000, 1_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(rpc.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.polls()).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toEqual(RECEIPT);
  });
});
