/**
 * History / portfolio / referral / vault analytics (veranta-server API).
 *
 * All endpoints degrade gracefully: a missing endpoint on a given
 * deployment throws ApiError with status 404 rather than crashing the
 * client. Human units throughout (per the v2 history swagger).
 */

import type { Address } from "viem";
import type { VerantaConfig } from "../config.js";
import type { HttpTransport } from "../transport.js";

export class InfoApi {
  constructor(
    private readonly cfg: VerantaConfig,
    private readonly transport: HttpTransport,
  ) {}

  private v1(path: string): string {
    return `${this.cfg.historyApiUrl}/v1${path}`;
  }

  private v2(path: string): string {
    return `${this.cfg.historyApiUrl}/v2${path}`;
  }

  // ------------------------------------------------------------------ history

  /** Fill history with full fee breakdown (gross/net PnL, fees, funding). */
  async tradeHistory(trader: Address, page = 0, limit = 20): Promise<any> {
    return await this.transport.json(
      "GET",
      this.v2(`/history/trade-history/${trader}/${page}/${limit}`),
    );
  }

  async orderHistory(trader: Address, page = 0, limit = 20): Promise<any> {
    return await this.transport.json(
      "GET",
      this.v2(`/history/order-history/${trader}/${page}/${limit}`),
    );
  }

  async recentTrades(pairIndex: number): Promise<any> {
    return await this.transport.json("GET", this.v1(`/history/recent-trades/${pairIndex}`));
  }

  // ------------------------------------------------------------------ portfolio

  async portfolioPnl(trader: Address, options: { grouped?: boolean } = {}): Promise<any> {
    const suffix = options.grouped ? "/grouped" : "";
    return await this.transport.json(
      "GET",
      this.v2(`/history/portfolio/profit-loss/${trader}${suffix}`),
    );
  }

  async portfolioPnlHistory(trader: Address, period: string, dateGroup = "day"): Promise<any> {
    return await this.transport.json(
      "GET",
      this.v1(`/history/portfolio/profit-loss/history/${trader}/${period}/${dateGroup}`),
    );
  }

  async portfolioVolume(trader: Address, options: { grouped?: boolean } = {}): Promise<any> {
    const suffix = options.grouped ? "/grouped" : "";
    return await this.transport.json(
      "GET",
      this.v1(`/history/portfolio/total-size/${trader}${suffix}`),
    );
  }

  async winRate(trader: Address, options: { grouped?: boolean } = {}): Promise<any> {
    const suffix = options.grouped ? "/grouped" : "";
    return await this.transport.json(
      "GET",
      this.v1(`/history/portfolio/win-rate/${trader}${suffix}`),
    );
  }

  async totalFees(trader: Address): Promise<any> {
    return await this.transport.json("GET", this.v1(`/history/portfolio/total-fees/${trader}`));
  }

  async lossProtectionReceived(trader: Address): Promise<any> {
    return await this.transport.json(
      "GET",
      this.v1(`/history/portfolio/loss-protection/${trader}`),
    );
  }

  async portfolioHighlights(trader: Address): Promise<any> {
    return await this.transport.json("GET", this.v1(`/history/portfolio/top/${trader}`));
  }

  async leaderboard(trader?: Address): Promise<any> {
    const path = trader
      ? `/history/portfolio/leader-board/${trader}`
      : "/history/portfolio/leader-board";
    return await this.transport.json("GET", this.v1(path));
  }

  // ------------------------------------------------------------------ referral

  /** {asReferrer: {totalFees, totalRebates, totalTraders}, asTrader: {...}}. */
  async referralStats(trader: Address): Promise<any> {
    return await this.transport.json("GET", this.v2(`/history/referral/stats/${trader}`));
  }

  async referralCount(trader: Address): Promise<any> {
    return await this.transport.json("GET", this.v1(`/history/referrals/count/${trader}`));
  }

  async referredFees(trader: Address): Promise<any> {
    return await this.transport.json("GET", this.v1(`/history/referrals/fees/referred/${trader}`));
  }

  // ------------------------------------------------------------------ vault / LP

  async vaultReturns(): Promise<any> {
    return await this.transport.json("GET", this.v1("/vault/returns"));
  }

  async vaultShareRateReturns(options: { chart?: boolean } = {}): Promise<any> {
    const path = options.chart ? "/vault/share-rate-returns/chart" : "/vault/share-rate-returns";
    return await this.transport.json("GET", this.v2(path));
  }

  async userVaultInfo(vaultType: string, trader: Address): Promise<any> {
    return await this.transport.json(
      "GET",
      this.v2(`/history/vaults/user-vault-info/${vaultType}/${trader}`),
    );
  }

  // ------------------------------------------------------------------ status

  async appStatus(): Promise<any> {
    return await this.transport.json("GET", this.v1("/app/status"));
  }
}
