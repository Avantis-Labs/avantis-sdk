/**
 * EIP-712 intent signing with a mandatory digest correctness gate.
 *
 * The tx-builder API returns `types` without the `EIP712Domain` type
 * (viem/MetaMask convention) and all uint/int values as decimal strings.
 * This module converts values to bigint, computes the digest locally with
 * viem's `hashTypedData`, and asserts it equals the API-provided `digest`
 * BEFORE signing. A mismatch is a hard error (encoding drift) and the
 * intent must never be submitted.
 */

import type { Address, Hex } from "viem";
import { hashTypedData } from "viem";
import { DigestMismatchError } from "../errors.js";
import type { Eip712Field, IntentPayload, SignedIntent } from "../types.js";
import type { AvantisSigner, TypedDataPayload } from "./signer.js";

const INT_TYPES = new Set(["uint256", "int256", "uint8", "uint192", "uint64"]);

/** Convert the API's decimal-string values to bigint, recursively, driven by types. */
export function toBigIntMessage(
  types: Record<string, Eip712Field[]>,
  typeName: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  const fields = new Map((types[typeName] ?? []).map((f) => [f.name, f.type]));
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(message)) {
    const type = fields.get(name);
    if (type === undefined) continue; // unknown extras never get hashed
    if (INT_TYPES.has(type)) {
      out[name] = BigInt(value as string | number | bigint);
    } else if (type in types) {
      // nested struct (Trade, UpdatePositionSize)
      out[name] = toBigIntMessage(types, type, value as Record<string, unknown>);
    } else {
      // address, bool, string, bytes32
      out[name] = value;
    }
  }
  return out;
}

/** Build the viem typed-data payload (bigint message + normalized domain). */
export function toTypedDataPayload(payload: IntentPayload): TypedDataPayload {
  return {
    domain: {
      name: payload.domain.name,
      version: payload.domain.version,
      chainId: Number(payload.domain.chainId),
      verifyingContract: payload.domain.verifyingContract,
    },
    types: payload.types,
    primaryType: payload.primaryType,
    message: toBigIntMessage(payload.types, payload.primaryType, payload.message),
  };
}

/** Compute the EIP-712 digest for an intent payload locally. */
export function intentDigest(payload: IntentPayload): Hex {
  return hashTypedData(toTypedDataPayload(payload) as any);
}

/**
 * Verify the API digest against the locally computed one.
 *
 * @throws DigestMismatchError when they differ — never submit after this.
 */
export function assertIntentDigest(payload: IntentPayload): Hex {
  const local = intentDigest(payload);
  if (local.toLowerCase() !== payload.digest.toLowerCase()) {
    throw new DigestMismatchError(
      `EIP-712 digest mismatch for ${payload.intent}: local ${local} != api ${payload.digest}. ` +
        "Do NOT submit; investigate encoding drift.",
    );
  }
  return local;
}

/**
 * Sign an intent payload, verifying the digest first.
 *
 * @throws DigestMismatchError if the locally computed EIP-712 hash differs
 * from the API's `digest` field.
 */
export async function signIntent(
  payload: IntentPayload,
  signer: AvantisSigner,
): Promise<SignedIntent> {
  assertIntentDigest(payload);
  const signature = await signer.signTypedData(toTypedDataPayload(payload));
  return { payload, signature, signer: signer.address as Address };
}
