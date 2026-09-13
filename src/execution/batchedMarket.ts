/**
 * Batched-market execution client (`POST /market/execute-batched`).
 *
 * The batched-market service is the front door for market execution: one
 * endpoint for every supported order type, streaming the order lifecycle
 * back as Server-Sent Events over the POST response.
 *
 * Request body (`erc712` required, `eip7702` OPTIONAL: when present the
 * server picks which mechanism to act on via its own strategy switch; when
 * omitted the server executes the EIP-712 intent directly, which is the
 * market-maker fast path with zero extra round-trips):
 *
 *     {
 *       "orderType": <AggregatorOrderType int>,
 *       "erc712":  { "userIntent": "0x…", "userSignature": "0x…" },
 *       "eip7702": { "chainId": "8453", "to": "0x…", "data": "0x…",
 *                    "gas": "2500000", "authorizationList": [...] }   // optional
 *     }
 *
 * Stream: `MarketOrderAccepted` (seq 0, carries trackingId) -> zero or more
 * non-terminal `AttemptFailed` events -> one initiation event
 * (`MarketOrderInitiated` for opens/closes, `IncreasePositionRequested` for
 * increases) -> exactly one terminal event (`MarketOrderExecuted` /
 * `PositionSizeIncreased` on success; `MarketOrderCanceled` when the
 * protocol declined the fill, e.g. slippage; `Error`). All uints are strings
 * in raw units (1e6 USDC, 1e10 prices/leverage). Keep-alives are SSE
 * comments (`: hb`). A dropped stream is recoverable via
 * `GET /tracking-id/{trackingId}/status?afterSeq={lastSeenSeq}`: every event
 * is persisted with its seq, so the replay is complete.
 *
 * `AttemptFailed` and `Error` payloads carry a machine-readable `code` next
 * to the human `message`: a bare Avantis contract error name (`WrongSl`,
 * `HighSlippage`) when the failure decoded to a revert, or a synthetic
 * backend code (`NO_PRICE`, `SPREAD_BLOCKED`, `SPREAD_UNAVAILABLE`,
 * `SUBMISSION_FAILED`, `ATTEMPTS_EXHAUSTED`, `TX_NOT_EXECUTED`,
 * `STREAM_TIMEOUT`, `ENQUEUE_FAILED`, plus `RELAY_FAILED` / `TX_REVERTED` /
 * `RELAY_TIMEOUT` in 7702 mode).
 *
 * `code == "STREAM_TIMEOUT"` is the one `Error` that is NOT the request's
 * outcome: only this connection's view of it timed out. This client falls
 * back to status polling for it; every other `Error` is a real terminal
 * failure and throws {@link RelayError} carrying the `code`.
 */

import { ApiError, RelayError, RelayTimeoutError } from "../errors.js";
import type { HttpTransport } from "../transport.js";
import { type SseEvent, iterSse } from "./sse.js";

export const ACCEPTED = "MarketOrderAccepted";
/** Non-terminal: one retryable attempt failed. */
export const ATTEMPT_FAILED = "AttemptFailed";
export const TERMINAL_SUCCESS: ReadonlySet<string> = new Set([
  "MarketOrderExecuted",
  "PositionSizeIncreased",
]);
export const TERMINAL_FAILURE: ReadonlySet<string> = new Set(["MarketOrderCanceled", "Error"]);
const TERMINAL = new Set([...TERMINAL_SUCCESS, ...TERMINAL_FAILURE]);

// Error codes emitted by the controller for THIS CONNECTION's stream view
// rather than the request itself. STREAM_TIMEOUT means the order may still
// be executing (recover via status polling); ENQUEUE_FAILED means the
// request never reached the execution queue.
const STREAM_TIMEOUT_CODE = "STREAM_TIMEOUT";
const ENQUEUE_FAILED_CODE = "ENQUEUE_FAILED";

// Server heartbeats every 15s; anything above that with margin works.
const SSE_IDLE_TIMEOUT_MS = 45_000;

export interface BatchedMarketEvent {
  type: string;
  data: Record<string, any>;
  seq: number | null;
}

/**
 * Observer for the order journey while the SDK settles the outcome.
 *
 * Called once per lifecycle event, in stream order. The terminal is
 * delivered even when it makes the call throw (`RelayError` on
 * `MarketOrderCanceled` / `Error`), so a journey log is complete on
 * failures. Sync and async callbacks both work.
 */
export type BatchedMarketEventHook = (event: BatchedMarketEvent) => void | Promise<void>;

async function emit(hook: BatchedMarketEventHook | undefined, event: BatchedMarketEvent) {
  if (!hook) return;
  await hook(event);
}

/**
 * Result of a batched-market execution.
 *
 * `terminal` is null only for `wait: false` submissions (accepted, not yet
 * settled). Failure terminals throw instead of being returned.
 */
export class BatchedMarketOutcome {
  constructor(
    readonly trackingId: string,
    readonly terminal: BatchedMarketEvent | null,
    readonly events: BatchedMarketEvent[],
  ) {}

  get txHash(): string | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const hash = this.events[i]!.data.transactionHash;
      if (hash) return String(hash);
    }
    return undefined;
  }

  get orderId(): number | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const data = this.events[i]!.data;
      if ("orderId" in data) return Number(data.orderId);
    }
    return undefined;
  }

  /**
   * Non-terminal `AttemptFailed` events observed along the way (payloads:
   * `{attempt, code, message, willRetry}`). Informational: a successful
   * outcome can still have several.
   */
  get attemptFailures(): BatchedMarketEvent[] {
    return this.events.filter((event) => event.type === ATTEMPT_FAILED);
  }
}

export interface BatchedMarketErc712 {
  userIntent: string;
  userSignature: string;
}

export class BatchedMarketClient {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  private readonly base: string;

  constructor(
    private readonly transport: HttpTransport,
    baseUrl: string,
    options: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ) {
    this.base = baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  // ------------------------------------------------------------------ execute

  /**
   * Submit a signed order and follow its lifecycle stream.
   *
   * `eip7702` is optional: when provided the server may execute either leg
   * (server-side mechanism switch); when omitted the EIP-712 intent executes
   * directly (market-maker fast path).
   *
   * With `wait: false` returns as soon as the request is accepted
   * (trackingId minted); settle later with {@link wait}. Throws
   * {@link RelayError} on `MarketOrderCanceled` / terminal `Error`,
   * {@link ApiError} on a 4xx/5xx rejection.
   */
  async execute(
    orderType: number,
    erc712: BatchedMarketErc712,
    eip7702?: Record<string, unknown>,
    options: { wait?: boolean; onEvent?: BatchedMarketEventHook } = {},
  ): Promise<BatchedMarketOutcome> {
    const wait = options.wait ?? true;
    const body: Record<string, unknown> = { orderType, erc712 };
    if (eip7702 !== undefined) body.eip7702 = eip7702;
    const url = `${this.base}/market/execute-batched`;

    let trackingId: string | null = null;
    const events: BatchedMarketEvent[] = [];
    try {
      const response = await this.transport.stream("POST", url, { json: body });
      if (response.status >= 400) throw await httpError(response, url);
      for await (const sse of iterSse(response, { idleTimeoutMs: SSE_IDLE_TIMEOUT_MS })) {
        const event: BatchedMarketEvent = sse;
        events.push(event);
        await emit(options.onEvent, event);
        if (event.type === ACCEPTED) {
          trackingId = String(event.data.trackingId ?? "") || trackingId;
          if (!wait) return new BatchedMarketOutcome(trackingId ?? "", null, events);
          continue;
        }
        if (TERMINAL.has(event.type)) {
          if (event.type === "Error") {
            const code = String(event.data.code ?? "");
            const message = String(event.data.message ?? "");
            // STREAM_TIMEOUT is this connection's view timing out, not the
            // request's outcome; the order may still execute. (Older servers
            // sent it without a code or an id: line; keep that sniff as a
            // fallback.) Recover via status polling.
            const streamTimedOut =
              code === STREAM_TIMEOUT_CODE ||
              (!code && event.seq === null && message.toLowerCase().includes("timed out"));
            if (streamTimedOut && trackingId) break; // fall through to status polling
            if (code === ENQUEUE_FAILED_CODE || event.seq === null) {
              // Never reached the execution queue (or an unpersisted
              // transport-side rejection).
              throw new RelayError(
                `batched-market rejected the order: ${message || JSON.stringify(event.data)}`,
                { requestId: trackingId ?? undefined, code: code || undefined },
              );
            }
          }
          return this.settle(trackingId, event, events);
        }
      }
    } catch (error) {
      if (error instanceof RelayError || error instanceof ApiError) throw error;
      // Connection dropped mid-stream; the order may still be executing.
      if (trackingId === null) {
        throw new ApiError(`batched-market stream failed: ${(error as Error).message}`, { url });
      }
    }

    if (trackingId === null) {
      throw new ApiError("batched-market stream ended before MarketOrderAccepted", { url });
    }
    return await this.wait(trackingId, {
      afterSeq: lastSeq(events) ?? undefined,
      events,
      onEvent: options.onEvent,
    });
  }

  // ------------------------------------------------------------------ status

  /** Replay the persisted lifecycle events for a trackingId. */
  async status(trackingId: string, afterSeq?: number): Promise<BatchedMarketEvent[]> {
    const data = await this.transport.json("GET", `${this.base}/tracking-id/${trackingId}/status`, {
      params: afterSeq !== undefined ? { afterSeq } : undefined,
    });
    return (data?.events ?? []).map((e: any) => ({
      type: String(e.type),
      data: e.payload ?? {},
      seq: e.seq ?? null,
    }));
  }

  /**
   * Poll the status replay until a terminal event lands.
   *
   * `onEvent` observes each newly replayed event (never the already-seen
   * `events` seed).
   */
  async wait(
    trackingId: string,
    options: {
      afterSeq?: number;
      events?: BatchedMarketEvent[];
      timeoutMs?: number;
      onEvent?: BatchedMarketEventHook;
    } = {},
  ): Promise<BatchedMarketOutcome> {
    const collected = [...(options.events ?? [])];
    let seenSeq = options.afterSeq;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const event of await this.status(trackingId, seenSeq)) {
        collected.push(event);
        await emit(options.onEvent, event);
        if (event.seq !== null) seenSeq = event.seq;
        if (TERMINAL.has(event.type)) return this.settle(trackingId, event, collected);
      }
      await sleep(this.pollIntervalMs);
    }
    throw new RelayTimeoutError(
      `batched-market order ${trackingId} not settled after ${Math.round(timeoutMs / 1000)}s`,
      { requestId: trackingId },
    );
  }

  // ------------------------------------------------------------------ internal

  private settle(
    trackingId: string | null,
    terminal: BatchedMarketEvent,
    events: BatchedMarketEvent[],
  ): BatchedMarketOutcome {
    const outcome = new BatchedMarketOutcome(trackingId ?? "", terminal, events);
    if (terminal.type === "MarketOrderCanceled") {
      throw new RelayError(
        "order canceled by the protocol (the transaction succeeded but the fill was " +
          `declined, e.g. slippage): ${JSON.stringify(terminal.data)}`,
        { requestId: trackingId ?? undefined },
      );
    }
    if (terminal.type === "Error") {
      const code = String(terminal.data.code ?? "") || undefined;
      throw new RelayError(
        `batched-market execution failed${code ? ` [${code}]` : ""}: ${
          terminal.data.message ?? JSON.stringify(terminal.data)
        }`,
        { requestId: trackingId ?? undefined, code },
      );
    }
    return outcome;
  }
}

function lastSeq(events: BatchedMarketEvent[]): number | null {
  const seqs = events.map((e) => e.seq).filter((s): s is number => s !== null);
  return seqs.length ? Math.max(...seqs) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpError(response: Response, url: string): Promise<ApiError> {
  const raw = await response.text().catch(() => "");
  let message = raw.slice(0, 300);
  try {
    const body = JSON.parse(raw);
    const m = body.message;
    message = Array.isArray(m) ? m.join("; ") : String(m ?? raw.slice(0, 300));
  } catch {
    // keep raw slice
  }
  return new ApiError(`batched-market rejected the request (${response.status}): ${message}`, {
    status: response.status,
    url,
  });
}
