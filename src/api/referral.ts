/**
 * Referral actions: codes, gasless registration, ownership transfer.
 *
 * Referral contract calls are msg.sender-scoped (no delegatedAction
 * wrapping), so direct calldata requires signer == caller. Gasless
 * variants use the referral WithSig intents (signed by the
 * referrer/referee themselves) wrapped via the relayer passthrough.
 */

import type { Address, Hex } from "viem";
import { concatHex, encodeAbiParameters, keccak256, stringToBytes } from "viem";
import { ConfigError } from "../errors.js";
import { signIntent } from "../signing/intents.js";
import type { CallData, ExecutionReceipt, IntentPayload } from "../types.js";
import { ExecutingApi } from "./base.js";

const REGISTER_CODE_WITH_SIG = keccak256(stringToBytes("registerCodeWithSig(bytes,bytes)")).slice(
  0,
  10,
) as Hex;
const SET_CODE_WITH_SIG = keccak256(
  stringToBytes("setTraderReferralCodeByUserWithSig(bytes,bytes)"),
).slice(0, 10) as Hex;

/** client.referral: actions execute as the SDK's signing key. */
export class ReferralApi extends ExecutingApi {
  get caller(): Address {
    const signer = this.engine.signer;
    if (!signer) throw new ConfigError("Referral actions require a signer.");
    return signer.address;
  }

  // ------------------------------------------------------------------ core actions

  /** Register a referral code owned by the caller. */
  async registerCode(code: string, options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/register-code",
      { caller: this.caller, code },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  /** Attach the caller to someone else's referral code. */
  async setCode(code: string, options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/set-code",
      { caller: this.caller, code },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  /** Sign a RegisterCodeReq intent and relay registerCodeWithSig. */
  async registerCodeGasless(
    code: string,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    const intent = await this.txb.intent("/v2/intents/referral-register-code", {
      referrer: this.caller,
      code,
    });
    return await this.withSig(intent, REGISTER_CODE_WITH_SIG, options.wait ?? true);
  }

  /** Sign a SetTraderReferralCodeByUserReq intent and relay it. */
  async setCodeGasless(code: string, options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    const intent = await this.txb.intent("/v2/intents/referral-set-code", {
      referee: this.caller,
      code,
    });
    return await this.withSig(intent, SET_CODE_WITH_SIG, options.wait ?? true);
  }

  // ------------------------------------------------------------------ special / ownership

  async requestSpecialCode(
    code: string,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/request-special-code",
      { caller: this.caller, code },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async cancelRequest(options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/cancel-request",
      { caller: this.caller },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async relinquishCode(options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/relinquish-code",
      { caller: this.caller },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  /** Approve a pending private-code request (code owner only). */
  async setCodeByOwner(
    code: string,
    trader: Address,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/set-code-by-owner",
      { caller: this.caller, code, trader },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async transferOwnership(
    code: string,
    newOwner: Address,
    options: { wait?: boolean } = {},
  ): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/transfer-ownership",
      { caller: this.caller, code, newOwner },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  async acceptOwnership(code: string, options: { wait?: boolean } = {}): Promise<ExecutionReceipt> {
    return await this.passthroughOrDirect(
      "/v2/referral/accept-ownership",
      { caller: this.caller, code },
      options.wait ?? true,
      { delegatable: false },
    );
  }

  // ------------------------------------------------------------------ helpers

  private async withSig(
    intent: IntentPayload,
    selector: Hex,
    wait: boolean,
  ): Promise<ExecutionReceipt> {
    const signer = this.engine.signer;
    if (!signer) throw new ConfigError("Gasless referral actions require a signer.");
    const signed = await signIntent(intent, signer);
    const referral = intent.domain.verifyingContract;
    const data = concatHex([
      selector,
      encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }],
        [signed.signature, intent.encodedIntent],
      ),
    ]);
    const calldata: CallData = {
      to: referral,
      from: signer.address,
      data,
      value: "0x0",
      chainId: await this.engine.chainId(),
      description: `${intent.intent} withSig`,
    };
    return await this.route(calldata, wait);
  }
}
