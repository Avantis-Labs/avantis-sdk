/**
 * Veranta v2 client.
 *
 * Backend (env-based):
 *
 *     import { Veranta } from "veranta-sdk";
 *
 *     const client = new Veranta(); // reads VERANTA_* env vars
 *     await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10 });
 *
 * Browser (wagmi wallet):
 *
 *     const client = new Veranta({ signer: walletClient, network: "mainnet" });
 */

import { AccountApi } from "./api/account.js";
import { InfoApi } from "./api/info.js";
import { LpApi } from "./api/lp.js";
import { MarketsApi } from "./api/markets.js";
import { ReferralApi } from "./api/referral.js";
import { TradeApi } from "./api/trade.js";
import { type VerantaConfig, type VerantaConfigInput, resolveConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { ExecutionEngine } from "./execution/engine.js";
import { LocalIntentBuilder } from "./execution/localIntents.js";
import { type SignerSource, type VerantaSigner, toSigner } from "./signing/signer.js";
import {
  HermesPriceStream,
  LazerPriceStream,
  OrderEventStream,
  PairDataStream,
} from "./streams/index.js";
import { HttpTransport } from "./transport.js";
import { TxBuilderClient, type TxBuilderMeta } from "./txbuilder.js";

export interface VerantaOptions extends VerantaConfigInput {
  /**
   * Signing key source: a 0x private key, a viem LocalAccount, a viem
   * WalletClient (browser wallets via wagmi), or a custom VerantaSigner.
   * Falls back to `privateKey` / VERANTA_PRIVATE_KEY.
   */
  signer?: SignerSource;
  /**
   * Custom fetch used for every HTTP call the SDK makes (history API, feed,
   * transaction builder, relayer). Use it to route through a proxy, add
   * headers for a private gateway, or record requests in tests. Defaults to
   * the global fetch.
   */
  fetch?: typeof fetch;
}

export class Veranta {
  readonly config: VerantaConfig;
  readonly signer?: VerantaSigner;
  readonly transport: HttpTransport;
  readonly txb: TxBuilderClient;
  readonly engine: ExecutionEngine;

  private metaCache: Promise<TxBuilderMeta> | null = null;
  private tradeApi?: TradeApi;
  private accountApi?: AccountApi;
  private marketsApi?: MarketsApi;
  private infoApi?: InfoApi;
  private referralApi?: ReferralApi;
  private lpApi?: LpApi;

  constructor(options: VerantaOptions = {}) {
    const { signer, fetch: fetchFn, ...configInput } = options;
    this.config = resolveConfig(configInput);
    const source = signer ?? this.config.privateKey;
    this.signer = source !== undefined ? toSigner(source) : undefined;

    this.transport = new HttpTransport({ timeoutMs: this.config.timeoutMs, fetch: fetchFn });
    this.txb = new TxBuilderClient(this.transport, this.config.txBuilderUrl);
    this.engine = new ExecutionEngine(this.config, this.signer, this.transport, this.txb);
  }

  // ------------------------------------------------------------------ bootstrap

  /** Cached /v2/meta bootstrap (addresses, domains, enums, units, defaults). */
  async meta(): Promise<TxBuilderMeta> {
    if (this.metaCache === null) {
      this.metaCache = this.txb.meta().catch((error) => {
        this.metaCache = null; // allow retry after a failed bootstrap
        throw error;
      });
    }
    return await this.metaCache;
  }

  async chainId(): Promise<number> {
    return Number((await this.meta()).chainId);
  }

  // ------------------------------------------------------------------ namespaces

  /** Opens / closes / limits / margin / increase / TP-SL / TWAP / RFQ. */
  get trade(): TradeApi {
    this.tradeApi ??= new TradeApi(this.config, this.engine, this.txb, this.transport, (ref) =>
      this.markets.pair(ref),
    );
    return this.tradeApi;
  }

  /** Positions, allowance, delegation, approvals, claims, builder codes. */
  get account(): AccountApi {
    this.accountApi ??= new AccountApi(
      this.config,
      this.engine,
      this.txb,
      this.transport,
      () => this.meta(),
      () => this.markets.pairs(),
    );
    return this.accountApi;
  }

  /** Pair catalog, prices, spread, candles. */
  get markets(): MarketsApi {
    this.marketsApi ??= new MarketsApi(this.config, this.transport);
    return this.marketsApi;
  }

  /** History, portfolio, referral stats, vault APY. */
  get info(): InfoApi {
    this.infoApi ??= new InfoApi(this.config, this.transport);
    return this.infoApi;
  }

  /** Referral actions (caller-scoped; trader key only). */
  get referral(): ReferralApi {
    this.referralApi ??= new ReferralApi(this.config, this.engine, this.txb, this.transport);
    return this.referralApi;
  }

  /** LP vault actions (caller-scoped; trader key only). */
  get lp(): LpApi {
    this.lpApi ??= new LpApi(this.config, this.engine, this.txb, this.transport);
    return this.lpApi;
  }

  // ------------------------------------------------------------------ streams

  /**
   * SSE price stream (feed-v3 / Pyth Lazer). Feed ids from pair snapshot
   * `lazerFeed.feedId`.
   */
  lazerPriceStream(lazerFeedIds: number[]): LazerPriceStream {
    return new LazerPriceStream(this.config.feedUrl, lazerFeedIds);
  }

  /** Pyth Hermes WebSocket stream (0x-hex feed ids from `feed.feedId`). */
  hermesPriceStream(pythFeedIds: string[]): HermesPriceStream {
    return new HermesPriceStream(this.config.hermesWsUrl, pythFeedIds);
  }

  /** Socket.IO RES:DATA pair/OI/funding snapshot stream. */
  pairDataStream(): PairDataStream {
    return new PairDataStream(this.config.dataApiUrl);
  }

  /** Pusher order-execution events for a trader (needs pusherKey config). */
  orderEventStream(trader?: string): OrderEventStream {
    if (!this.config.pusherKey) {
      throw new ConfigError("orderEventStream requires pusherKey in config");
    }
    const address = trader ?? this.config.trader ?? this.signer?.address;
    if (!address) throw new ConfigError("orderEventStream requires a trader address");
    return new OrderEventStream(this.config.pusherKey, address, {
      cluster: this.config.pusherCluster,
    });
  }

  // ------------------------------------------------------------------ MM fast path

  /**
   * Local intent builder (no per-order HTTP round-trips). Combine with
   * `signIntent` + the relayer; see execution/localIntents.ts.
   */
  async localIntents(): Promise<LocalIntentBuilder> {
    return LocalIntentBuilder.fromMeta(await this.meta());
  }
}
