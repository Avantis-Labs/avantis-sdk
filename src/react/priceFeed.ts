/**
 * Shared live-price store: one Lazer SSE stream fanned out to every
 * `usePrice` subscriber (mirrors the production UI's price worker).
 */

import type { PairInfo } from "../api/marketModels.js";
import type { Avantis } from "../client.js";
import type { LazerPriceStream } from "../streams/prices.js";

export interface LivePrice {
  price: number;
  bestBid?: number;
  bestAsk?: number;
  timestampMs?: number;
}

export class PriceFeedStore {
  private readonly prices = new Map<number, LivePrice>(); // by pairIndex
  private readonly listeners = new Set<() => void>();
  private readonly refCounts = new Map<number, number>(); // pairIndex -> subscribers
  private readonly feedToPairs = new Map<number, number[]>(); // lazer feedId -> pairIndexes
  private stream: LazerPriceStream | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: Avantis) {}

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

  private scheduleRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restart(), 250);
  }

  private async restart(): Promise<void> {
    this.stream?.stop();
    this.stream = null;
    const pairIndexes = [...this.refCounts.keys()];
    if (pairIndexes.length === 0) return;

    let pairs: Map<number, PairInfo>;
    try {
      pairs = await this.client.markets.pairs();
    } catch {
      this.scheduleRestartLater();
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

    const stream = this.client.lazerPriceStream([...feedIds]);
    this.stream = stream;
    void stream.run((update) => {
      const targets = this.feedToPairs.get(Number(update.feedId)) ?? [];
      for (const pairIndex of targets) {
        this.prices.set(pairIndex, {
          price: update.price,
          bestBid: update.bestBid,
          bestAsk: update.bestAsk,
          timestampMs: update.timestampMs,
        });
      }
      if (targets.length > 0) {
        for (const listener of this.listeners) listener();
      }
    });
  }

  private scheduleRestartLater(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restart(), 3_000);
  }
}
