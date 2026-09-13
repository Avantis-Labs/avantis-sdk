/** Shared base for namespaces that execute transactions. */

import type { Address } from "viem";
import type { AvantisConfig } from "../config.js";
import { ConfigError } from "../errors.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { HttpTransport } from "../transport.js";
import type { TxBuilderClient } from "../txbuilder.js";
import type { CallData, ExecutionReceipt } from "../types.js";

export class ExecutingApi {
  constructor(
    protected readonly cfg: AvantisConfig,
    protected readonly engine: ExecutionEngine,
    protected readonly txb: TxBuilderClient,
    protected readonly transport: HttpTransport,
  ) {}

  /** The trader address whose account is being operated. */
  get trader(): Address {
    if (this.cfg.trader) return this.cfg.trader;
    if (this.engine.signer) return this.engine.signer.address;
    throw new ConfigError("No trader address: set `trader` / AVANTIS_TRADER_ADDRESS or a signer.");
  }

  /** Delegate address for calldata wrapping, when signer != trader. */
  protected get delegateParam(): Address | undefined {
    const signer = this.engine.signer;
    if (
      signer &&
      this.cfg.trader &&
      signer.address.toLowerCase() !== this.cfg.trader.toLowerCase()
    ) {
      return signer.address;
    }
    return undefined;
  }

  /** Fetch direct-route calldata, delegate-wrapped when signer != trader. */
  protected async calldata(
    path: string,
    params: Record<string, unknown>,
    options: { delegatable?: boolean } = {},
  ): Promise<CallData> {
    const cdParams = { ...params };
    const delegate = this.delegateParam;
    if (delegate && (options.delegatable ?? true)) cdParams.delegate = delegate;
    return await this.txb.calldata(path, cdParams);
  }

  protected async route(calldata: CallData, wait: boolean): Promise<ExecutionReceipt> {
    if (this.engine.isRelayerMode) {
      return await this.engine.submitPassthrough(calldata, { wait });
    }
    return await this.engine.submitDirect(calldata, { wait });
  }

  protected async passthroughOrDirect(
    path: string,
    params: Record<string, unknown>,
    wait: boolean,
    options: { delegatable?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const delegatable = options.delegatable ?? true;
    if (!delegatable) this.requireCallerIsSigner(path);
    const calldata = await this.calldata(path, params, { delegatable });
    return await this.route(calldata, wait);
  }

  /**
   * Guard for calls where msg.sender identity matters (referral, approve,
   * claims): they cannot be executed by a delegate on the trader's behalf.
   */
  protected requireCallerIsSigner(what: string): void {
    if (this.delegateParam !== undefined) {
      throw new ConfigError(
        `${what} executes as the caller's own address and cannot be routed through ` +
          "a delegate key. Run it with the trader key (or on the Avantis UI).",
      );
    }
  }
}
