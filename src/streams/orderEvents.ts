/**
 * Order-execution event stream (Pusher public channels).
 *
 * The Avantis operator publishes per-trader execution events on channel
 * `events-{traderAddress}`: `OrderPickedUpForExecution`,
 * `ExecutionConfirmedInFlashblock`, `OrderFilled`, `OrderCanceled`.
 *
 * Implemented directly over the Pusher WebSocket protocol (protocol 7,
 * public channels, no auth), so no pusher-js dependency is required.
 */

import { getWebSocket, sleep } from "./ws.js";

export const ORDER_EVENTS = [
  "OrderPickedUpForExecution",
  "ExecutionConfirmedInFlashblock",
  "OrderFilled",
  "OrderCanceled",
] as const;

export interface OrderEvent {
  event: string;
  data: Record<string, any>;
  channel: string;
}

export type OrderEventCallback = (event: OrderEvent) => void | Promise<void>;

export class OrderEventStream {
  private readonly url: string;
  private readonly channel: string;
  private stopped = false;
  private ws: WebSocket | null = null;

  constructor(pusherKey: string, trader: string, options: { cluster?: string } = {}) {
    const cluster = options.cluster ?? "us2";
    this.url =
      `wss://ws-${cluster}.pusher.com/app/${pusherKey}` +
      "?protocol=7&client=avantis-sdk&version=2.0";
    this.channel = `events-${trader}`;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  async run(callback: OrderEventCallback): Promise<void> {
    const WS = await getWebSocket();
    let attempt = 0;
    while (!this.stopped) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WS(this.url);
          this.ws = ws;
          ws.onopen = () => {
            attempt = 0;
            ws.send(JSON.stringify({ event: "pusher:subscribe", data: { channel: this.channel } }));
          };
          ws.onmessage = async (message: MessageEvent) => {
            if (this.stopped) {
              ws.close();
              return;
            }
            let msg: any;
            try {
              msg = JSON.parse(String(message.data));
            } catch {
              return;
            }
            const event: string = msg.event ?? "";
            if (event === "pusher:ping") {
              ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
              return;
            }
            if (event.startsWith("pusher")) return;
            let data = msg.data ?? {};
            if (typeof data === "string") {
              try {
                data = JSON.parse(data);
              } catch {
                data = { raw: data };
              }
            }
            await callback({ event, data, channel: msg.channel ?? "" });
          };
          ws.onerror = (error: unknown) => reject(new Error(`pusher socket error: ${error}`));
          ws.onclose = () => resolve();
        });
        if (this.stopped) return;
        await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
        attempt += 1;
      } catch {
        if (this.stopped) return;
        await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
        attempt += 1;
      }
    }
  }
}
