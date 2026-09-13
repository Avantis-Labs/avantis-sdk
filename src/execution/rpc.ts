/**
 * Minimal JSON-RPC client (fetch-based; no extra dependency).
 *
 * Used for: EOA nonces + code checks (EIP-7702 authorizations), gas
 * estimation, direct-route broadcasting, and receipt polling.
 */

import { RpcError, TransactionRevertedError } from "../errors.js";

let nextId = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonRpcClient {
  constructor(
    readonly url: string,
    readonly timeoutMs: number = 30_000,
  ) {}

  async call(method: string, params: unknown[] = []): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RpcError(`RPC transport error (${method}): ${(error as Error).message}`);
    }
    const body: any = await response.json().catch(() => {
      throw new RpcError(`RPC returned non-JSON for ${method}`);
    });
    if (body.error) {
      throw new RpcError(`RPC error on ${method}: ${body.error.message}`, {
        code: body.error.code,
        data: body.error.data,
      });
    }
    return body.result;
  }

  // -- typed helpers ---------------------------------------------------------

  async chainId(): Promise<number> {
    return Number.parseInt(await this.call("eth_chainId"), 16);
  }

  async getTransactionCount(address: string, block = "pending"): Promise<number> {
    return Number.parseInt(await this.call("eth_getTransactionCount", [address, block]), 16);
  }

  async getCode(address: string): Promise<string> {
    return (await this.call("eth_getCode", [address, "latest"])) ?? "0x";
  }

  async getBalance(address: string): Promise<bigint> {
    return BigInt(await this.call("eth_getBalance", [address, "latest"]));
  }

  async estimateGas(tx: Record<string, unknown>): Promise<number> {
    return Number.parseInt(await this.call("eth_estimateGas", [tx]), 16);
  }

  /** Returns [maxFeePerGas, maxPriorityFeePerGas]. */
  async gasFees(): Promise<[bigint, bigint]> {
    let priority: bigint;
    try {
      priority = BigInt(await this.call("eth_maxPriorityFeePerGas"));
    } catch {
      priority = 1_000_000n; // 0.001 gwei floor on Base
    }
    const block = await this.call("eth_getBlockByNumber", ["latest", false]);
    const baseFee = BigInt(block?.baseFeePerGas ?? "0x0");
    return [baseFee * 2n + priority, priority];
  }

  async sendRawTransaction(raw: string): Promise<string> {
    return await this.call("eth_sendRawTransaction", [raw]);
  }

  async getReceipt(txHash: string): Promise<Record<string, any> | null> {
    return await this.call("eth_getTransactionReceipt", [txHash]);
  }

  async waitForReceipt(
    txHash: string,
    timeoutMs = 120_000,
    pollMs = 1_000,
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.getReceipt(txHash);
      if (receipt !== null) {
        if (Number.parseInt(receipt.status ?? "0x0", 16) !== 1) {
          throw new TransactionRevertedError(`transaction ${txHash} reverted`, { txHash });
        }
        return receipt;
      }
      await sleep(pollMs);
    }
    throw new RpcError(`timed out waiting for receipt of ${txHash}`);
  }
}
