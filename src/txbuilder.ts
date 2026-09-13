/**
 * Client for the avantis-tx-builder API (`/v2/*`).
 *
 * This is the SDK's payload factory: calldata for the direct route, EIP-712
 * intents for the relayer route, plus meta/reads. All build endpoints accept
 * POST JSON with human units; numeric values are sent as strings.
 */

import type { HttpTransport } from "./transport.js";
import type { CallData, IntentPayload } from "./types.js";

/** /v2/meta bootstrap: addresses, EIP-712 domains, enums, units, defaults. */
export interface TxBuilderMeta {
  chainId: number | string;
  addresses: Record<string, string> & {
    tradingRouter?: string;
    referral?: string;
    delegationTemplate?: string;
  };
  [key: string]: unknown;
}

/** Drop undefined/null and stringify numbers (exact decimal semantics). */
export function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" || typeof value === "bigint") out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

export class TxBuilderClient {
  private readonly transport: HttpTransport;
  private readonly base: string;

  constructor(transport: HttpTransport, baseUrl: string) {
    this.transport = transport;
    this.base = baseUrl.replace(/\/$/, "");
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  // -- meta / reads ---------------------------------------------------------

  async meta(): Promise<TxBuilderMeta> {
    return await this.transport.txb("GET", this.url("/v2/meta"));
  }

  async pairs(): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/pairs"));
  }

  async nonce(trader: string, check?: number | string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/nonce"), {
      params: cleanParams({ trader, check }),
    });
  }

  async positions(trader: string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/positions"), { params: { trader } });
  }

  async delegation(trader: string, delegate: string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/delegation"), {
      params: { trader, delegate },
    });
  }

  async allowance(trader: string, spender?: string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/allowance"), {
      params: cleanParams({ trader, spender }),
    });
  }

  async lpState(owner?: string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/lp/state"), {
      params: cleanParams({ owner }),
    });
  }

  async builderCode(code: string): Promise<any> {
    return await this.transport.txb("GET", this.url("/v2/builder-code"), { params: { code } });
  }

  // -- builders --------------------------------------------------------------

  /** POST a calldata builder endpoint, e.g. `calldata("/v2/trade/open", {...})`. */
  async calldata(path: string, params: Record<string, unknown>): Promise<CallData> {
    return (await this.transport.txb("POST", this.url(path), {
      json: cleanParams(params),
    })) as CallData;
  }

  /** POST an intent builder endpoint, e.g. `intent("/v2/intents/open", {...})`. */
  async intent(path: string, params: Record<string, unknown>): Promise<IntentPayload> {
    return (await this.transport.txb("POST", this.url(path), {
      json: cleanParams(params),
    })) as IntentPayload;
  }

  // -- raw-tx relay (direct route without user RPC) ---------------------------

  async relayRaw(rawTransaction: string, skipSimulation = false): Promise<any> {
    return await this.transport.txb("POST", this.url("/v2/relay"), {
      json: { rawTransaction, skipSimulation },
    });
  }

  async relayStatus(txHash: string): Promise<any> {
    return await this.transport.txb("GET", this.url(`/v2/relay/${txHash}`));
  }
}
