/**
 * LP (liquidity provider) actions on the ERC-4626 tranche (avUSDC).
 *
 * USDC must be approved to the TRANCHE (not TradingStorage) first:
 * `client.account.approveUsdc(amount, { spender: trancheAddress })`.
 * No lock/epoch in v2: withdrawals are immediate, gated by utilization.
 */

import type { Address } from "viem";
import { ConfigError } from "../errors.js";
import type { ExecutionReceipt, Num } from "../types.js";
import { ExecutingApi } from "./base.js";

export class LpApi extends ExecutingApi {
  get caller(): Address {
    const signer = this.engine.signer;
    if (!signer) throw new ConfigError("LP actions require a signer.");
    return signer.address;
  }

  /** Vault totals, share price, utilization, per-owner max withdraw/redeem. */
  async state(owner?: Address): Promise<any> {
    return await this.txb.lpState(owner ?? this.caller);
  }

  async deposit(
    amount: Num,
    options: { receiver?: Address; wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/lp/deposit",
      { caller: this.caller, amountUsdc: amount, receiver: options.receiver },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async mint(
    shares: Num,
    options: { receiver?: Address; wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/lp/mint",
      { caller: this.caller, shares, receiver: options.receiver },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async withdraw(
    amount: Num,
    options: { receiver?: Address; owner?: Address; wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/lp/withdraw",
      {
        caller: this.caller,
        amountUsdc: amount,
        receiver: options.receiver,
        owner: options.owner,
      },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async redeem(
    shares: Num,
    options: { receiver?: Address; owner?: Address; wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/lp/redeem",
      { caller: this.caller, shares, receiver: options.receiver, owner: options.owner },
      options.wait ?? true,
      { delegatable: false },
    );
  }
}
