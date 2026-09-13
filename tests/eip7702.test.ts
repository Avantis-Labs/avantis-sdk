/**
 * EIP-7702/Gelato encoder parity: reproduce the REAL @gelatocloud/gasless
 * `encodeCallData` output byte-for-byte, plus the EIP-7702 authorization.
 *
 * Reference payload generated with the actual Gelato SDK from
 * avantis-ui-v2's node_modules (shared verbatim with the Python SDK suite).
 */

import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type Call,
  GelatoDelegationEncoder,
  delegationCode,
  encodeNonce,
} from "../src/eip7702/account.js";
import { toSigner } from "../src/signing/signer.js";
import REF from "./vectors/eip7702_reference.json";

function encoder(): GelatoDelegationEncoder {
  return new GelatoDelegationEncoder(
    toSigner(REF.privateKey as Hex),
    REF.chainId,
    REF.authorization.address as Address,
  );
}

function calls(): Call[] {
  return REF.calls.map((c) => ({
    to: c.to as Address,
    data: c.data as Hex,
    value: BigInt(c.value),
  }));
}

describe("eip7702 encoder", () => {
  it("encodeCallData matches the Gelato SDK byte-for-byte", async () => {
    const data = await encoder().encodeCallData(calls(), BigInt(REF.nonce));
    expect(data.toLowerCase()).toBe(REF.encodeCallData.toLowerCase());
  });

  it("authorization matches viem reference", async () => {
    const auth = await encoder().authorization(REF.authorization.nonce);
    expect(auth.address).toBe(REF.authorization.address);
    expect(auth.r).toBe(REF.authorization.r);
    expect(auth.s).toBe(REF.authorization.s);
    expect(auth.yParity).toBe(REF.authorization.yParity);
  });

  it("buildType4 shape matches blitz TxParamsDto", async () => {
    const type4 = await encoder().buildType4(calls(), {
      gas: 1_000_000,
      accountNonce: 0,
      execNonce: BigInt(REF.nonce),
    });
    expect(type4.chainId).toBe(REF.chainId);
    expect(type4.to).toBe(REF.owner);
    expect(type4.gasLimit).toBe("1000000");
    expect(type4.transactionType).toBe(4);
    expect(type4.value).toBe("0");
    expect(type4.data.toLowerCase()).toBe(REF.encodeCallData.toLowerCase());
    expect(type4.authorizationList).toHaveLength(1);
    const auth = type4.authorizationList[0]!;
    expect(auth.chainId).toBe(REF.chainId);
    expect(auth.nonce).toBe(0);
    expect(auth.yParity).toBe(REF.authorization.yParity);
    expect(auth.v).toBe(auth.yParity + 27);
  });

  it("execute envelope carries no builder suffix", async () => {
    // Builder params live on the INNER trading calldata (appended by the
    // tx-builder as `code || rate || 0x9481c2bc`), never on the outer
    // execute() envelope: the encoder output must stay byte-identical to
    // the Gelato reference.
    const data = await encoder().encodeCallData(calls(), BigInt(REF.nonce));
    expect(data.toLowerCase()).toBe(REF.encodeCallData.toLowerCase());
  });

  it("encodeNonce scheme", () => {
    expect(encodeNonce(5n, 7n)).toBe((5n << 64n) | 7n);
    expect(BigInt(REF.nonce) >> 64n).toBe(1234567890123n);
  });

  it("delegationCode", () => {
    expect(delegationCode("0x5aF42746a8Af42d8a4708dF238C53F1F71abF0E0")).toBe(
      "0xef01005af42746a8af42d8a4708df238c53f1f71abf0e0",
    );
  });
});
