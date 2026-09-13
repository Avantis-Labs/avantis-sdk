/**
 * Minimal SSE parser over a fetch ReadableStream (isomorphic: Node,
 * browsers, edge). Parses `id:` / `event:` / `data:` fields, blank-line
 * dispatch; `:` comments and `retry:` are ignored. Multi-line data joined
 * per the SSE spec.
 */

export interface SseEvent {
  type: string;
  data: Record<string, any>;
  seq: number | null;
}

/**
 * Iterate SSE events from a Response body.
 *
 * `idleTimeoutMs` bounds the gap between chunks (the batched-market server
 * heartbeats every 15s); when exceeded the stream is aborted and iteration
 * ends with an `SseIdleTimeout` error.
 */
export async function* iterSse(
  response: Response,
  options: { idleTimeoutMs?: number } = {},
): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;

  let buffer = "";
  let eventType: string | null = null;
  let dataLines: string[] = [];
  let seq: number | null = null;

  function flush(): SseEvent | null {
    if (eventType === null && dataLines.length === 0) {
      eventType = null;
      dataLines = [];
      seq = null;
      return null;
    }
    let data: Record<string, any> = {};
    const raw = dataLines.join("\n");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        data = parsed !== null && typeof parsed === "object" ? parsed : { value: parsed };
      } catch {
        data = { raw };
      }
    }
    const event: SseEvent = { type: eventType ?? "message", data, seq };
    eventType = null;
    dataLines = [];
    seq = null;
    return event;
  }

  function handleLine(rawLine: string): SseEvent | null {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") return flush();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") {
      const parsed = Number.parseInt(value, 10);
      seq = Number.isNaN(parsed) ? null : parsed;
    }
    // "retry" and unknown fields are ignored
    return null;
  }

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SseIdleTimeout(idleTimeoutMs)), idleTimeoutMs);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = handleLine(line);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    // trailing dispatch if the stream ended without a final blank line
    if (buffer) {
      const event = handleLine(buffer);
      if (event) yield event;
    }
    const final = flush();
    if (final) yield final;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already errored/closed
    }
  }
}

/** The gap between SSE chunks exceeded the idle timeout. */
export class SseIdleTimeout extends Error {
  override name = "SseIdleTimeout";
  constructor(readonly idleTimeoutMs: number) {
    super(`SSE stream idle for more than ${idleTimeoutMs}ms`);
  }
}
