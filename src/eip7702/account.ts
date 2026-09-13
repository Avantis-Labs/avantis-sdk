/**
 * Gelato EIP-7702 smart-account encoding (ERC-7821 op-data mode).
 *
 * Byte-for-byte compatible with `@gelatocloud/gasless`
 * `toGelatoSmartAccount().encodeCallData` against the on-chain template
 * `avantis-contracts-v2/src/EIP7702Template/Eip7702Template.sol`:
 *
 * 1. Sign EIP-712 `Execute(bytes32 mode,Call[] calls,uint256 nonce)` /
 *    `Call(address to,uint256 value,bytes data)` under the domain
 *    `{name: "GelatoDelegation", version: "0.0.1", chainId, verifyingContract: <signer EOA>}`.
 * 2. `opData = abi.encodePacked(uint192(nonce >> 64), signature)`.
 * 3. `executionData = abi.encode(Call[], bytes opData)` (ERC-7821 op-data mode).
 * 4. Calldata = `execute(bytes32 mode, bytes executionData)` sent **to the
 *    signer's own EOA** (whose code is delegated to the Gelato template).
 * 5. An EIP-7702 authorization for the delegation template is attached to
 *    every relayed transaction (idempotent once the code is set).
 */

import type { Address, Hex } from "viem";
import { concatHex, encodeAbiParameters, keccak256, numberToHex, stringToBytes } from "viem";
import type { AvantisSigner, SignedAuthorization } from "../signing/signer.js";

/** ERC-7821: callType=0x01 (batch), execType=0x00, selector=0x78210001 (op-data mode). */
export const EXECUTION_MODE_OP_DATA: Hex =
  "0x0100000000007821000100000000000000000000000000000000000000000000";

export const EXECUTE_SELECTOR: Hex = keccak256(stringToBytes("execute(bytes32,bytes)")).slice(
  0,
  10,
) as Hex;

const EXECUTE_TYPES = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Execute: [
    { name: "mode", type: "bytes32" },
    { name: "calls", type: "Call[]" },
    { name: "nonce", type: "uint256" },
  ],
};

/** ERC-7821 sequential nonce: `(key << 64) | seq` (key up to 192 bits). */
export function encodeNonce(key: bigint, seq = 0n): bigint {
  return (key << 64n) | seq;
}

/**
 * Fresh nonce with a time-based key so the on-chain sequence for the key is
 * 0. Mirrors the UI convention `encodeNonce(Date.now()*1000 + i, 0)`.
 */
export function freshNonce(salt = 0n): bigint {
  return encodeNonce(BigInt(Date.now()) * 1000n + salt, 0n);
}

/** A single call in the smart-account batch. */
export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** Blitz-relayer `txParams` payload for a type-4 (EIP-7702) relay. */
export interface Type4TxParams {
  to: Address;
  data: Hex;
  value: string;
  gasLimit: string;
  chainId: number;
  transactionType: 4;
  authorizationList: Array<SignedAuthorization & { v: number }>;
}

/**
 * Builds relayer-ready type-4 payloads for one signing key.
 *
 * Builder-fee params are NOT handled here: in the canonical-template model
 * they ride as a tagged suffix on the INNER trading calldata (appended by
 * the tx-builder), never on the outer `execute()` envelope.
 */
export class GelatoDelegationEncoder {
  private readonly authCache = new Map<number, SignedAuthorization>();

  constructor(
    readonly signer: AvantisSigner,
    readonly chainId: number,
    readonly delegationAddress: Address,
  ) {}

  // -- core encoding --------------------------------------------------------

  /** Sign the ERC-7821 Execute digest; returns the 65-byte signature. */
  async signExecute(calls: Call[], nonce: bigint): Promise<Hex> {
    return await this.signer.signTypedData({
      domain: {
        name: "GelatoDelegation",
        version: "0.0.1",
        chainId: this.chainId,
        verifyingContract: this.signer.address,
      },
      types: EXECUTE_TYPES,
      primaryType: "Execute",
      message: {
        mode: EXECUTION_MODE_OP_DATA,
        calls: calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })),
        nonce,
      },
    });
  }

  /** Full `execute(mode, executionData)` calldata with signed opData. */
  async encodeCallData(calls: Call[], nonce?: bigint): Promise<Hex> {
    const execNonce = nonce ?? freshNonce();
    const signature = await this.signExecute(calls, execNonce);
    const nonceKey = execNonce >> 64n;
    // abi.encodePacked(uint192, bytes)
    const opData = concatHex([numberToHex(nonceKey, { size: 24 }), signature]);
    const executionData = encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
        { type: "bytes" },
      ],
      [calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })), opData],
    );
    return concatHex([
      EXECUTE_SELECTOR,
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes" }],
        [EXECUTION_MODE_OP_DATA, executionData],
      ),
    ]);
  }

  // -- authorization ---------------------------------------------------------

  /** EIP-7702 set-code authorization for the Gelato delegation template. */
  async authorization(accountNonce: number): Promise<SignedAuthorization> {
    const cached = this.authCache.get(accountNonce);
    if (cached) return cached;
    const auth = await this.signer.signAuthorization({
      chainId: this.chainId,
      address: this.delegationAddress,
      nonce: accountNonce,
    });
    this.authCache.set(accountNonce, auth);
    return auth;
  }

  // -- relayer payload -------------------------------------------------------

  /**
   * Blitz-relayer `txParams` for a type-4 (EIP-7702) relay.
   *
   * Shape mirrors avantis-backend-monorepo blitz-relayer-app
   * `TxParamsDto` / `AuthorizationDto` (numeric chainId/nonce; v and yParity
   * both provided for ethers signature reconstruction).
   */
  async buildType4(
    calls: Call[],
    options: {
      gas: number | bigint;
      accountNonce?: number;
      execNonce?: bigint;
      includeAuthorization?: boolean;
      value?: bigint;
    },
  ): Promise<Type4TxParams> {
    const data = await this.encodeCallData(calls, options.execNonce);
    const authorizationList: Array<SignedAuthorization & { v: number }> = [];
    if (options.includeAuthorization ?? true) {
      const auth = await this.authorization(options.accountNonce ?? 0);
      authorizationList.push({ ...auth, v: auth.yParity + 27 });
    }
    return {
      to: this.signer.address,
      data,
      value: String(options.value ?? 0n),
      gasLimit: String(options.gas),
      chainId: this.chainId,
      transactionType: 4,
      authorizationList,
    };
  }
}

/** Expected EOA code once the EIP-7702 delegation is applied (0xef0100 ++ addr). */
export function delegationCode(delegationAddress: string): string {
  return `0xef0100${delegationAddress.toLowerCase().replace(/^0x/, "")}`;
}
