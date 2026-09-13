/**
 * Web-Worker leg of the live price feed.
 *
 * The production Avantis UI runs its Lazer SSE stream inside a dedicated
 * worker so high-frequency tick parsing (JSON + fan-out for many pairs)
 * never blocks the main thread during renders. The SDK ships the same
 * pattern with zero bundler configuration: the worker is spawned from an
 * inline Blob URL, and the in-worker `EventSource` reconnects natively.
 *
 * Falls back to the main-thread stream when Workers/Blob URLs are
 * unavailable (SSR, strict CSP without `worker-src blob:`, old runtimes).
 */

/** Self-contained worker source (no imports; EventSource is native). */
const WORKER_SOURCE = `
let es = null;
self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "connect") {
    if (es) es.close();
    es = null;
    if (!msg.url) return;
    es = new EventSource(msg.url);
    es.addEventListener("price_update", (ev) => {
      try {
        self.postMessage({ type: "price_update", data: JSON.parse(ev.data) });
      } catch (_) {}
    });
    // EventSource auto-reconnects; surface errors for observability only.
    es.onerror = () => {
      self.postMessage({ type: "stream_error" });
    };
  } else if (msg.type === "close") {
    if (es) es.close();
    es = null;
  }
};
`;

export interface PriceWorkerMessage {
  type: "price_update" | "stream_error";
  data?: {
    timestampUs?: string | number;
    priceFeeds?: Array<{
      priceFeedId: number;
      price: string;
      exponent?: number;
      bestBidPrice?: string;
      bestAskPrice?: string;
      [key: string]: unknown;
    }>;
  };
}

export function supportsPriceWorker(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

/** Spawn the price worker, or null when the environment cannot host one. */
export function createPriceWorker(onMessage: (message: PriceWorkerMessage) => void): Worker | null {
  if (!supportsPriceWorker()) return null;
  try {
    const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { name: "avantis-price-feed" });
    URL.revokeObjectURL(url); // the worker keeps its own reference
    worker.onmessage = (event: MessageEvent<PriceWorkerMessage>) => onMessage(event.data);
    return worker;
  } catch {
    // e.g. CSP without worker-src blob:
    return null;
  }
}
