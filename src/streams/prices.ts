/**
 * Real-time price streams.
 *
 * - LazerPriceStream: feed-v3 SSE (`/v1/stream?price_feed_ids=...`, event
 *   `price_update`, 30s heartbeats); lowest latency, Avantis-hosted.
 * - HermesPriceStream: Pyth Hermes WebSocket (`wss://hermes.pyth.network/ws`).
 *
 * Both reconnect with exponential backoff and deliver `PriceUpdate` objects
 * to a callback or via `for await`.
 */

import { ApiError } from "../errors.js";
import { iterSse } from "../execution/sse.js";
import { getWebSocket, sleep } from "./ws.js";

export interface PriceUpdate {
  feedId: string | number;
  price: number;
  timestampMs?: number;
  bestBid?: number;
  bestAsk?: number;
  raw?: Record<string, any>;
}

export type PriceCallback = (update: PriceUpdate) => void | Promise<void>;

abstract class ReconnectingStream {
  protected stopped = false;
  protected abort: AbortController | null = null;

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  protected async backoff(attempt: number): Promise<void> {
    await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
  }

  abstract run(callback: PriceCallback): Promise<void>;

  /** Consume updates with `for await (const update of stream)`. */
  async *[Symbol.asyncIterator](): AsyncGenerator<PriceUpdate> {
    const queue: PriceUpdate[] = [];
    let notify: (() => void) | null = null;
    const runner = this.run((update) => {
      queue.push(update);
      notify?.();
    });
    runner.catch(() => {});
    try {
      while (!this.stopped) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
            // re-check periodically so stop() unblocks the iterator
            setTimeout(resolve, 1_000);
          });
          notify = null;
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      this.stop();
    }
  }
}

/** feed-v3 SSE price stream (Pyth Lazer relays). */
export class LazerPriceStream extends ReconnectingStream {
  private readonly url: string;

  constructor(feedUrl: string, lazerFeedIds: number[]) {
    super();
    const params = new URLSearchParams({ price_feed_ids: lazerFeedIds.join(",") });
    this.url = `${feedUrl.replace(/\/$/, "")}/v1/stream?${params}`;
  }

  async run(callback: PriceCallback): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(this.url, {
          headers: { accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (response.status >= 400) {
          throw new ApiError(`SSE stream HTTP ${response.status}`, { status: response.status });
        }
        attempt = 0;
        for await (const event of iterSse(response, { idleTimeoutMs: 90_000 })) {
          if (this.stopped) return;
          if (event.type !== "price_update") continue;
          const data = event.data;
          // feed-v3 sends timestampUs as a decimal string
          const ts = data.timestampUs !== undefined ? Number(data.timestampUs) : undefined;
          for (const feed of data.priceFeeds ?? []) {
            const exponent = 10 ** (feed.exponent ?? 0);
            await callback({
              feedId: feed.priceFeedId,
              price: Number(feed.price) * exponent,
              timestampMs: ts !== undefined ? Math.floor(ts / 1000) : undefined,
              bestBid: feed.bestBidPrice ? Number(feed.bestBidPrice) * exponent : undefined,
              bestAsk: feed.bestAskPrice ? Number(feed.bestAskPrice) * exponent : undefined,
              raw: feed,
            });
          }
        }
      } catch {
        if (this.stopped) return;
        await this.backoff(attempt);
        attempt += 1;
      }
    }
  }
}

/** Pyth Hermes WebSocket subscription (feed ids are 0x-hex Pyth ids). */
export class HermesPriceStream extends ReconnectingStream {
  constructor(
    private readonly wsUrl: string,
    private readonly feedIds: string[],
  ) {
    super();
  }

  async run(callback: PriceCallback): Promise<void> {
    const WS = await getWebSocket();
    let attempt = 0;
    while (!this.stopped) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WS(this.wsUrl);
          const closeOnStop = setInterval(() => {
            if (this.stopped) ws.close();
          }, 500);
          ws.onopen = () => {
            attempt = 0;
            ws.send(JSON.stringify({ type: "subscribe", ids: this.feedIds }));
          };
          ws.onmessage = async (message: MessageEvent) => {
            if (this.stopped) {
              ws.close();
              return;
            }
            let data: any;
            try {
              data = JSON.parse(String(message.data));
            } catch {
              return;
            }
            if (data.type !== "price_update") return;
            const feed = data.price_feed ?? {};
            const p = feed.price ?? {};
            await callback({
              feedId: feed.id,
              price: Number(p.price ?? 0) * 10 ** (p.expo ?? 0),
              timestampMs: p.publish_time ? p.publish_time * 1000 : undefined,
              raw: feed,
            });
          };
          ws.onerror = (event: unknown) => {
            clearInterval(closeOnStop);
            reject(new Error(`Hermes websocket error: ${String(event)}`));
          };
          ws.onclose = () => {
            clearInterval(closeOnStop);
            resolve();
          };
        });
        if (this.stopped) return;
        await this.backoff(attempt);
        attempt += 1;
      } catch {
        if (this.stopped) return;
        await this.backoff(attempt);
        attempt += 1;
      }
    }
  }
}
