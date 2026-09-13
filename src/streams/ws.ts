/** WebSocket resolution: native in browsers/Node>=22, `ws` fallback in Node. */

import { ConfigError } from "../errors.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getWebSocket(): Promise<typeof WebSocket> {
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket;
  }
  try {
    // Variable specifier keeps bundlers from statically resolving the
    // Node-only fallback (browsers always have a native WebSocket).
    const specifier = "ws";
    const mod: any = await import(/* @vite-ignore */ specifier);
    return (mod.WebSocket ?? mod.default) as typeof WebSocket;
  } catch {
    throw new ConfigError(
      "No WebSocket implementation available: use Node >= 22 (native WebSocket) " +
        "or `npm install ws`.",
    );
  }
}
