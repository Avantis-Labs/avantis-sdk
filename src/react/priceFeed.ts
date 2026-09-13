/**
 * Shared live-price store: one Lazer SSE stream fanned out to every
 * `usePrice` subscriber.
 *
 * Transport (mirrors the production Avantis UI):
 * - "worker" (default in browsers): the SSE stream + JSON parsing run in a
 *   dedicated Web Worker spawned from an inline Blob (no bundler config),
 *   so heavy tick traffic never competes with React renders on the main
 *   thread. The in-worker EventSource reconnects natively.
 * - "main": fetch-based SSE on the main thread (Node/SSR/tests, or strict
 *   CSPs without `worker-src blob:`). Automatic fallback when a worker
 *   cannot be created.
 */

import type { PairInfo } from "../api/marketModels.js";
import type { Avantis } from "../client.js";
import type { LazerPriceStream } from "../streams/prices.js";
import { type PriceWorkerMessage, createPriceWorker } from "./priceWorker.js";

export interface LivePrice {
  price: number;
  bestBid?: number;
  bestAsk?: number;
  timestampMs?: number;
}

export type PriceTransport = "worker" | "main";

export class PriceFeedStore {
  private readonly prices = new Map<number, LivePrice>(); // by pairIndex
  private readonly listeners = new Set<() => void>();
  private readonly refCounts = new Map<number, number>(); // pairIndex -> subscribers
  private readonly feedToPairs = new Map<number, number[]>(); // lazer feedId -> pairIndexes
  private stream: LazerPriceStream | null = null;
  private worker: Worker | null = null;
  private workerFailed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: Avantis,
    private readonly transport: PriceTransport = "worker",
  ) {}

  /** Subscribe a component to one pair; returns the unsubscribe. */
  track(pairIndex: number, listener: () => void): () => void {
    this.listeners.add(listener);
    this.refCounts.set(pairIndex, (this.refCounts.get(pairIndex) ?? 0) + 1);
    this.scheduleRestart();
    return () => {
      this.listeners.delete(listener);
      const count = (this.refCounts.get(pairIndex) ?? 1) - 1;
      if (count <= 0) this.refCounts.delete(pairIndex);
      else this.refCounts.set(pairIndex, count);
      this.scheduleRestart();
    };
  }

  get(pairIndex: number): LivePrice | undefined {
    return this.prices.get(pairIndex);
  }

  /** Stop all transports (worker + stream). */
  destroy(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.stream?.stop();
    this.stream = null;
    this.worker?.postMessage({ type: "close" });
    this.worker?.terminate();
    this.worker = null;
  }

  private scheduleRestart(delayMs = 250): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restart(), delayMs);
  }

  private async restart(): Promise<void> {
    // Stop the previous leg (worker keeps living; it just reconnects).
    this.stream?.stop();
    this.stream = null;

    const pairIndexes = [...this.refCounts.keys()];
    if (pairIndexes.length === 0) {
      this.worker?.postMessage({ type: "close" });
      return;
    }

    let pairs: Map<number, PairInfo>;
    try {
      pairs = await this.client.markets.pairs();
    } catch {
      this.scheduleRestart(3_000);
      return;
    }
    this.feedToPairs.clear();
    const feedIds = new Set<number>();
    for (const pairIndex of pairIndexes) {
      const feedId = pairs.get(pairIndex)?.lazerFeed?.feedId;
      if (feedId === undefined || feedId === null) continue;
      feedIds.add(feedId);
      this.feedToPairs.set(feedId, [...(this.feedToPairs.get(feedId) ?? []), pairIndex]);
    }
    if (feedIds.size === 0) return;

    if (this.transport === "worker" && !this.workerFailed) {
      const url =
        `${this.client.config.feedUrl.replace(/\/$/, "")}/v1/stream?` +
        new URLSearchParams({ price_feed_ids: [...feedIds].join(",") });
      this.worker ??= createPriceWorker((message) => this.onWorkerMessage(message));
      if (this.worker) {
        this.worker.postMessage({ type: "connect", url });
        return;
      }
      this.workerFailed = true; // no Worker/Blob support: fall through
    }

    const stream = this.client.lazerPriceStream([...feedIds]);
    this.stream = stream;
    void stream.run((update) => {
      this.applyUpdate(Number(update.feedId), {
        price: update.price,
        bestBid: update.bestBid,
        bestAsk: update.bestAsk,
        timestampMs: update.timestampMs,
      });
    });
  }

  private onWorkerMessage(message: PriceWorkerMessage): void {
    if (message.type !== "price_update" || !message.data) return;
    const ts =
      message.data.timestampUs !== undefined ? Number(message.data.timestampUs) : undefined;
    for (const feed of message.data.priceFeeds ?? []) {
      const exponent = 10 ** (feed.exponent ?? 0);
      this.applyUpdate(Number(feed.priceFeedId), {
        price: Number(feed.price) * exponent,
        bestBid: feed.bestBidPrice ? Number(feed.bestBidPrice) * exponent : undefined,
        bestAsk: feed.bestAskPrice ? Number(feed.bestAskPrice) * exponent : undefined,
        timestampMs: ts !== undefined ? Math.floor(ts / 1000) : undefined,
      });
    }
  }

  private applyUpdate(feedId: number, price: LivePrice): void {
    const targets = this.feedToPairs.get(feedId) ?? [];
    for (const pairIndex of targets) this.prices.set(pairIndex, price);
    if (targets.length > 0) {
      for (const listener of this.listeners) listener();
    }
  }
}
