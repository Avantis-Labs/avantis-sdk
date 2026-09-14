/**
 * HTTP transport shared by all API clients (fetch-based, isomorphic).
 *
 * Handles the tx-builder `{ok, data|error}` envelope, retries on transient
 * failures, and mapping of error codes to typed exceptions.
 */

import { ApiError, apiErrorFromEnvelope } from "./errors.js";
import { VERSION } from "./version.js";

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const DEFAULT_RETRIES = 2;

const IS_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";

export interface RequestOptions {
  params?: Record<string, unknown>;
  json?: unknown;
  retries?: number;
  allow404?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function buildUrl(url: string, params?: Record<string, unknown>): string {
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpTransport {
  readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private baseHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    // Browsers forbid setting User-Agent (and it would trigger preflights).
    if (!IS_BROWSER) headers["User-Agent"] = `veranta-sdk/${VERSION}`;
    return headers;
  }

  async request(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const target = buildUrl(url, options.params);
    const headers = this.baseHeaders(options.headers);
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
        response = await this.fetchFn(target, { method, headers, body, signal });
      } catch (error) {
        if (attempt < retries) {
          attempt += 1;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new ApiError(`network error calling ${target}: ${(error as Error).message}`, {
          url: target,
        });
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        attempt += 1;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  /**
   * Streaming request (SSE). Returns the raw Response; the caller reads
   * `response.body`. No overall timeout is applied, the batched-market
   * stream heartbeats every 15s and the SSE consumer enforces idle gaps.
   */
  async stream(
    method: string,
    url: string,
    options: { json?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers = this.baseHeaders({ accept: "text/event-stream", ...options.headers });
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    try {
      return await this.fetchFn(url, { method, headers, body, signal: options.signal });
    } catch (error) {
      throw new ApiError(`network error calling ${url}: ${(error as Error).message}`, { url });
    }
  }

  // -- tx-builder envelope ---------------------------------------------------

  /** Call a tx-builder endpoint and unwrap `{ok, data}` / raise on error. */
  async txb(method: string, url: string, options: RequestOptions = {}): Promise<any> {
    const response = await this.request(method, url, options);
    let bodyText: string;
    let parsed: unknown;
    try {
      bodyText = await response.text();
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ApiError(`non-JSON response (${response.status}) from ${url}`, {
        status: response.status,
        url,
      });
    }
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      const envelope = parsed as { ok: boolean; data?: unknown; error?: any };
      if (envelope.ok === true) return envelope.data;
      if (envelope.ok === false) {
        throw apiErrorFromEnvelope(envelope.error ?? {}, { status: response.status, url });
      }
    }
    if (response.status >= 400) {
      throw new ApiError(`HTTP ${response.status} from ${url}: ${bodyText.slice(0, 300)}`, {
        status: response.status,
        url,
      });
    }
    return parsed;
  }

  // -- plain JSON APIs (data/core/history/risk/feed) ---------------------------

  async json(method: string, url: string, options: RequestOptions = {}): Promise<any> {
    const response = await this.request(method, url, options);
    if (options.allow404 && response.status === 404) return null;
    const text = await response.text();
    if (response.status >= 400) {
      throw new ApiError(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`, {
        status: response.status,
        url,
      });
    }
    // e.g. 200/204 with empty body (core API deletes)
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(`non-JSON response from ${url}`, { url });
    }
  }
}
