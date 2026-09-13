/**
 * Pair/OI/funding snapshot stream: Socket.IO `RES:DATA` broadcasts from the
 * data-service (same host as /v2/trading).
 *
 * Requires the optional `socket.io-client` peer dependency.
 */

export type PairDataCallback = (payload: Record<string, any>) => void | Promise<void>;

export class PairDataStream {
  private readonly url: string;
  private readonly socketioPath: string;
  private socket: any = null;

  constructor(dataApiUrl: string) {
    this.url = dataApiUrl.replace(/\/$/, "");
    // socket.io discards the URL's path component, so the central routing
    // prefix ({apiBaseUrl}/data) must be re-applied via `path` for the
    // handshake to reach the gateway route.
    const prefix = new URL(this.url).pathname.replace(/^\/|\/$/g, "");
    this.socketioPath = prefix ? `/${prefix}/socket.io` : "/socket.io";
  }

  /** Connect and dispatch every RES:DATA payload (partial snapshots). */
  async run(callback: PairDataCallback): Promise<void> {
    let io: any;
    try {
      const mod: any = await import("socket.io-client");
      io = mod.io ?? mod.default;
    } catch {
      throw new Error(
        "PairDataStream needs the optional peer dependency socket.io-client: " +
          "`npm install socket.io-client`",
      );
    }

    const socket = io(this.url, {
      path: this.socketioPath,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;

    socket.on("RES:DATA", (payload: Record<string, any>) => {
      void callback(payload);
    });

    await new Promise<void>((resolve, reject) => {
      socket.on("connect_error", (error: Error) => {
        if (!socket.active) reject(error);
      });
      socket.on("disconnect", (reason: string) => {
        if (!socket.active) resolve(); // explicit stop()
        void reason;
      });
    });
  }

  async stop(): Promise<void> {
    this.socket?.disconnect();
  }
}
