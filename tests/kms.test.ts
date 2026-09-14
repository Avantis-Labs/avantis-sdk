/**
 * `veranta-sdk/kms`: the KMS-backed account/signer must reproduce, byte for
 * byte, what a viem private-key account signs for the same key. A fake KMS
 * client answers GetPublicKey with a real DER SubjectPublicKeyInfo and Sign
 * with DER-encoded (r, s) from the local key, returning the HIGH-s form on
 * every other call to exercise the low-s normalisation + parity recovery.
 */

import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { type Hex, hexToBigInt, hexToBytes, parseEther, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { Veranta } from "../src/client.js";
import { SigningError } from "../src/errors.js";
import { KmsSigner, derSignatureToRs, kmsAccount, spkiToPublicKey } from "../src/kms/index.js";
import { toSigner } from "../src/signing/signer.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ref = privateKeyToAccount(KEY);

// DER SubjectPublicKeyInfo for id-ecPublicKey + secp256k1 around an arbitrary-length point.
const SPKI_ALGORITHM = "301006072a8648ce3d020106052b8104000a";
function spki(point: Hex): Uint8Array {
  const pointBytes = hexToBytes(point);
  const bitString = [0x03, pointBytes.length + 1, 0x00, ...pointBytes];
  const algorithm = [...hexToBytes(`0x${SPKI_ALGORITHM}`)];
  return new Uint8Array([0x30, algorithm.length + bitString.length, ...algorithm, ...bitString]);
}

function derInt(value: bigint): number[] {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = [...hexToBytes(`0x${hex}`)];
  if (bytes[0]! & 0x80) bytes = [0, ...bytes];
  return [0x02, bytes.length, ...bytes];
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = [...derInt(r), ...derInt(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** Fake KMS client backed by the local key. */
function fakeKms(options: { highS?: "never" | "odd-calls" | "always"; publicKey?: Hex } = {}) {
  const state = { publicKeyCalls: 0, signCalls: 0 };
  const client = {
    async send(command: unknown) {
      if (command instanceof GetPublicKeyCommand) {
        state.publicKeyCalls += 1;
        return { PublicKey: spki(options.publicKey ?? ref.publicKey) };
      }
      if (command instanceof SignCommand) {
        const call = state.signCalls++;
        const hash = toHex(command.input.Message as Uint8Array);
        const sig = await sign({ hash, privateKey: KEY, to: "object" });
        let s = hexToBigInt(sig.s);
        const flip =
          options.highS === "always" || (options.highS === "odd-calls" && call % 2 === 1);
        if (flip) s = N - s;
        return { Signature: derSignature(hexToBigInt(sig.r), s) };
      }
      throw new Error("unexpected KMS command");
    },
  };
  return { client, state };
}

const TYPED = {
  domain: {
    name: "AvantisTrading",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x44914408af82bC9983bbb330e3578E1105e11d4e",
  },
  types: { Ping: [{ name: "x", type: "uint256" }] },
  primaryType: "Ping",
  message: { x: 1n },
} as const;

describe("kmsAccount", () => {
  it("derives the address from the DER public key with one GetPublicKey call", async () => {
    const { client, state } = fakeKms();
    const account = await kmsAccount({ keyId: "alias/test", client });
    expect(account.address).toBe(ref.address);
    expect(account.type).toBe("local");
    expect(account.source).toBe("kms");
    expect(account.publicKey).toBe(ref.publicKey);
    expect(state.publicKeyCalls).toBe(1);
    expect(state.signCalls).toBe(0);
  });

  it("signs typed data, messages, EIP-1559 txs and EIP-7702 authorizations exactly like viem", async () => {
    const { client, state } = fakeKms({ highS: "odd-calls" });
    const account = await kmsAccount({ keyId: "alias/test", client });

    for (let i = 0; i < 2; i++) {
      // Both parities of the fake: low-s passthrough and high-s normalisation.
      expect(await account.signTypedData(TYPED)).toBe(await ref.signTypedData(TYPED));
    }
    expect(await account.signMessage({ message: "hello" })).toBe(
      await ref.signMessage({ message: "hello" }),
    );

    const tx = {
      chainId: 8453,
      to: ref.address,
      value: parseEther("0.001"),
      nonce: 1,
      gas: 21000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
      type: "eip1559",
    } as const;
    expect(await account.signTransaction(tx)).toBe(await ref.signTransaction(tx));

    const auth = {
      address: "0x92F8ab16f6322a11d9f629baF081094c22A3a362",
      chainId: 8453,
      nonce: 7,
    } as const;
    const mine = await account.signAuthorization!(auth);
    const theirs = await ref.signAuthorization(auth);
    expect(mine.r).toBe(theirs.r);
    expect(mine.s).toBe(theirs.s);
    expect(mine.yParity).toBe(theirs.yParity);
    expect(mine.address).toBe(auth.address);

    const hash: Hex = `0x${"ab".repeat(32)}`;
    expect(await account.sign!({ hash })).toBe(await ref.sign!({ hash }));
    expect(state.signCalls).toBe(6);
  });

  it("always yields low-s signatures even when KMS returns the high-s form", async () => {
    const { client } = fakeKms({ highS: "always" });
    const account = await kmsAccount({ keyId: "alias/test", client });
    const signature = await account.signTypedData(TYPED);
    expect(signature).toBe(await ref.signTypedData(TYPED));
    const s = hexToBigInt(`0x${signature.slice(66, 130)}`);
    expect(s <= N / 2n).toBe(true);
  });

  it("rejects keys that are not uncompressed secp256k1 points", async () => {
    const compressed: Hex = `0x02${ref.publicKey.slice(4, 68)}`;
    const { client } = fakeKms({ publicKey: compressed });
    await expect(kmsAccount({ keyId: "alias/test", client })).rejects.toThrow(/ECC_SECG_P256K1/);
  });

  it("refuses a signature that does not recover to the key's address", async () => {
    const { client } = fakeKms();
    const account = await kmsAccount({ keyId: "alias/test", client });
    const tampered = {
      async send(command: unknown) {
        const out = await client.send(command);
        if (command instanceof SignCommand) {
          const der = out.Signature as Uint8Array;
          const last = der.length - 1;
          der[last] = (der[last] ?? 0) ^ 0x01; // flip one bit of s
        }
        return out;
      },
    };
    const broken = await kmsAccount({ keyId: "alias/test", client: tampered });
    await expect(broken.signMessage({ message: "x" })).rejects.toBeInstanceOf(SigningError);
    await expect(broken.signMessage({ message: "x" })).rejects.toThrow(/does not recover/);
    expect(account.address).toBe(ref.address);
  });
});

describe("KmsSigner", () => {
  it("is an EIP-7702-capable VerantaSigner the client accepts as-is", async () => {
    const { client } = fakeKms({ highS: "odd-calls" });
    const signer = await KmsSigner.create({ keyId: "alias/test", client });

    expect(signer.address).toBe(ref.address);
    expect(signer.keyId).toBe("alias/test");
    expect(signer.canSignAuthorization).toBe(true);
    expect(signer.canSendTransaction).toBe(false);
    expect(toSigner(signer)).toBe(signer);

    const veranta = new Veranta({ signer, network: "testnet" });
    expect(veranta.signer).toBe(signer);
    expect(veranta.signer!.address).toBe(ref.address);

    const payload = {
      domain: TYPED.domain,
      types: { Ping: [{ name: "x", type: "uint256" }] },
      primaryType: "Ping",
      message: { x: 1n },
    };
    expect(await signer.signTypedData(payload)).toBe(await ref.signTypedData(TYPED));
    const auth = await signer.signAuthorization({
      chainId: 8453,
      address: "0x92F8ab16f6322a11d9f629baF081094c22A3a362",
      nonce: 0,
    });
    const theirs = await ref.signAuthorization({
      address: "0x92F8ab16f6322a11d9f629baF081094c22A3a362",
      chainId: 8453,
      nonce: 0,
    });
    expect(auth).toEqual({
      address: "0x92F8ab16f6322a11d9f629baF081094c22A3a362",
      chainId: 8453,
      nonce: 0,
      r: theirs.r,
      s: theirs.s,
      yParity: theirs.yParity,
    });
    await expect(signer.sendTransaction({ to: ref.address, data: "0x" })).rejects.toBeInstanceOf(
      SigningError,
    );
  });
});

describe("DER helpers", () => {
  it("parses SubjectPublicKeyInfo and ECDSA-Sig-Value (short and long-form lengths)", () => {
    const der = spki(ref.publicKey);
    expect(der.length).toBe(88); // the canonical 88-byte secp256k1 SPKI
    expect(toHex(der.slice(0, 23))).toBe("0x3056301006072a8648ce3d020106052b8104000a034200");
    expect(spkiToPublicKey(der)).toBe(ref.publicKey);

    const r = 0x7fn;
    const highS = N - 5n;
    const parsed = derSignatureToRs(derSignature(r, highS));
    expect(parsed.r).toBe(r);
    expect(parsed.s).toBe(5n); // normalised to low-s

    // Long-form length prefix (0x81 nn) around the same body.
    const body = [...derInt(r), ...derInt(5n)];
    const longForm = new Uint8Array([0x30, 0x81, body.length, ...body]);
    expect(derSignatureToRs(longForm)).toEqual({ r, s: 5n });

    expect(() => derSignatureToRs(new Uint8Array([0x02, 0x01, 0x01]))).toThrow(SigningError);
    expect(() => spkiToPublicKey(new Uint8Array([0x30, 0x00]))).toThrow(SigningError);
  });
});
