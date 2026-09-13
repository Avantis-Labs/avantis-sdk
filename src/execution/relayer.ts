/**
 * Blitz relayer client (`POST /relays`, `GET /relays/{requestId}`,
 * `GET /relays/by-tx-hash/{txHash}`).
 *
 * The blitz relayer is a pure transaction broadcaster: callers submit
 * ready-to-broadcast `txParams` and it handles wallet selection, nonces,
 * gas bumping, and receipt tracking.
 *
 * - type-2 relays may only target whitelisted contracts (the TradingRouter);
 * - type-4 (EIP-7702) relays may target any account (delegated smart accounts);
 * - `wallet` is the originating EOA, used only for broadcast routing;
 * - status lifecycle: `Inflight` -> `Finalised` (mined; check
 *   `receipt.status` for revert) or `Failed` (timed out / rejected).
 */

import { ApiError, RelayError, RelayTimeoutError } from "../errors.js";
import type { HttpTransport } from "../transport.js";
import type { RelayStatus } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayerClient {
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  private readonly base: string;

  constructor(
    private readonly transport: HttpTransport,
    baseUrl: string,
    options: { pollIntervalMs?: number; pollTimeoutMs?: number } = {},
  ) {
    this.base = baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  }

  /**
   * Submit txParams for broadcast; returns the requestId to poll.
   *
   * 503 means every relayer wallet is busy; retried a few times since it
   * clears as soon as an in-flight relay settles.
   */
  async create(txParams: Record<string, unknown>, wallet?: string): Promise<string> {
    const body: Record<string, unknown> = { txParams };
    if (wallet) body.wallet = wallet;

    let lastError = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      // retries: 0 in the transport: a blind re-POST after an ambiguous
      // network failure could double-broadcast.
      const response = await this.transport.request("POST", `${this.base}/relays`, {
        json: body,
        retries: 0,
      });
      if (response.status === 503) {
        lastError = (await response.text()).slice(0, 200);
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      const text = await response.text();
      if (response.status >= 400) {
        throw new RelayError(
          `blitz relayer rejected relay (${response.status}): ${text.slice(0, 300)}`,
        );
      }
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new RelayError(`blitz relayer returned non-JSON: ${text.slice(0, 300)}`);
      }
      const requestId = data.requestId;
      if (!requestId) {
        throw new RelayError(`blitz relayer returned no requestId: ${text.slice(0, 300)}`);
      }
      return String(requestId);
    }
    throw new RelayError(`blitz relayer busy (503) after retries: ${lastError}`);
  }

  async status(requestId: string): Promise<RelayStatus> {
    const response = await this.transport.request("GET", `${this.base}/relays/${requestId}`, {
      allow404: true,
    });
    if (response.status === 404) {
      throw new RelayError(`unknown relay ${requestId}`, { requestId });
    }
    return await this.parseStatus(response);
  }

  /**
   * Look up a relay by its broadcast transaction hash.
   *
   * `GET /relays/by-tx-hash/{txHash}`; returns null when the hash is not
   * known to the relayer (unknown hash answers 200 with a null body).
   */
  async statusByTxHash(txHash: string): Promise<RelayStatus | null> {
    const response = await this.transport.request(
      "GET",
      `${this.base}/relays/by-tx-hash/${txHash}`,
      { allow404: true },
    );
    if (response.status === 404) return null;
    const text = await response.text();
    if (!text || text.trim() === "" || text.trim() === "null") return null;
    return this.parseStatusText(text, response.status);
  }

  private async parseStatus(response: Response): Promise<RelayStatus> {
    return this.parseStatusText(await response.text(), response.status);
  }

  private parseStatusText(text: string, status: number): RelayStatus {
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(`blitz relayer status returned non-JSON: ${text.slice(0, 300)}`, {
        status,
      });
    }

    const state = body.status;
    const receipt = body.receipt;
    if (state === "Failed") {
      return { settled: true, success: false, errorMessage: "relay failed (timed out)" };
    }
    if (state === "Finalised") {
      const txHash = receipt?.transactionHash ?? receipt?.hash;
      if (receiptReverted(receipt)) {
        return {
          settled: true,
          success: false,
          txHash,
          receipt,
          errorMessage: `transaction ${txHash} reverted`,
        };
      }
      return { settled: true, success: true, txHash, receipt };
    }
    // Pending / Inflight
    return { settled: false };
  }

  async wait(requestId: string, timeoutMs?: number): Promise<RelayStatus> {
    const timeout = timeoutMs ?? this.pollTimeoutMs;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await this.status(requestId);
      if (status.settled) {
        if (!status.success) {
          throw new RelayError(status.errorMessage ?? "relay failed", { requestId });
        }
        return status;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new RelayTimeoutError(
      `relay ${requestId} not settled after ${Math.round(timeout / 1000)}s`,
      { requestId },
    );
  }
}

function receiptReverted(receipt: Record<string, any> | null | undefined): boolean {
  if (!receipt) return false;
  const status = receipt.status;
  if (status === null || status === undefined) return false;
  if (typeof status === "string") {
    return Number.parseInt(status, status.startsWith("0x") ? 16 : 10) === 0;
  }
  return Number(status) === 0;
}
