/**
 * AWS KMS signing (backend only): `veranta-sdk/kms`.
 *
 * Twin of the Python SDK's `KmsSigner` (`pip install veranta-sdk[kms]`).
 * The secp256k1 private key never leaves KMS: the address is derived from
 * the KMS public key and every digest the SDK signs (EIP-712 intents,
 * EIP-1559 transactions in direct mode, EIP-7702 authorizations for blitz
 * relays) goes through a KMS `Sign` call.
 *
 *     import { Veranta } from "veranta-sdk";
 *     import { KmsSigner } from "veranta-sdk/kms";
 *
 *     const signer = await KmsSigner.create({ keyId: "alias/mm-veranta" });
 *     const client = new Veranta({ signer }); // the KMS key is the trader
 *
 * Requires the optional peer `@aws-sdk/client-kms` and a KMS key with
 * KeySpec ECC_SECG_P256K1 / KeyUsage SIGN_VERIFY. Credentials and region
 * resolve the standard AWS way (env, shared profile, role); pass a
 * configured `client` for anything custom (endpoint, retries, credentials
 * provider). Node only: never import this entry from browser code.
 */

import {
  GetPublicKeyCommand,
  type GetPublicKeyCommandOutput,
  KMSClient,
  SignCommand,
  type SignCommandOutput,
} from "@aws-sdk/client-kms";
import {
  type Address,
  type Hex,
  type Signature,
  type TransactionSerializable,
  bytesToBigInt,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
} from "viem";
import { type LocalAccount, publicKeyToAddress, toAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";
import { ConfigError, SigningError } from "../errors.js";
import {
  type SignedAuthorization,
  type TypedDataPayload,
  type VerantaSigner,
  toSigner,
} from "../signing/signer.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** Anything with the AWS SDK v3 `send(command)` shape (a `KMSClient`, or a test double). */
export interface KmsClientLike {
  send(command: any): Promise<any>;
}

export interface KmsSignerOptions {
  /** KMS key id, alias (`alias/...`) or ARN. KeySpec ECC_SECG_P256K1, KeyUsage SIGN_VERIFY. */
  keyId: string;
  /**
   * Pre-configured KMS client (credentials, endpoint, retries). Defaults to
   * `new KMSClient({ region })`.
   */
  client?: KmsClientLike;
  /** Region for the default client; else AWS_REGION / AWS_DEFAULT_REGION / us-east-1. */
  region?: string;
}

// ---------------------------------------------------------------------------
// DER helpers
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** First content byte. */
  start: number;
  /** One past the last content byte. */
  end: number;
}

/** Read one DER tag-length-value header (short and long-form lengths). */
function readTlv(buf: Uint8Array, at: number): Tlv {
  const tag = buf[at];
  const first = buf[at + 1];
  if (tag === undefined || first === undefined) throw new SigningError("KMS DER: truncated");
  let length = first;
  let headerSize = 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = buf[at + 2 + i];
      if (byte === undefined) throw new SigningError("KMS DER: truncated length");
      length = length * 256 + byte;
    }
    headerSize = 2 + count;
  }
  const start = at + headerSize;
  const end = start + length;
  if (end > buf.length) throw new SigningError("KMS DER: length exceeds buffer");
  return { tag, start, end };
}

/**
 * DER SubjectPublicKeyInfo (KMS `GetPublicKey`) -> uncompressed secp256k1
 * public key (`0x04 || X || Y`, 65 bytes).
 */
export function spkiToPublicKey(der: Uint8Array): Hex {
  const spki = readTlv(der, 0);
  if (spki.tag !== 0x30) throw new SigningError("KMS public key: expected a DER SEQUENCE");
  const algorithm = readTlv(der, spki.start);
  if (algorithm.tag !== 0x30)
    throw new SigningError("KMS public key: expected an AlgorithmIdentifier");
  const subjectPublicKey = readTlv(der, algorithm.end);
  if (subjectPublicKey.tag !== 0x03)
    throw new SigningError("KMS public key: expected a BIT STRING");
  // The first BIT STRING octet counts unused bits (0 for a byte-aligned point).
  const point = der.slice(subjectPublicKey.start + 1, subjectPublicKey.end);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new SigningError(
      "KMS public key is not an uncompressed secp256k1 point; the key's KeySpec must be ECC_SECG_P256K1",
    );
  }
  return toHex(point);
}

/**
 * DER ECDSA-Sig-Value (KMS `Sign`, `SEQUENCE { r INTEGER, s INTEGER }`) ->
 * `{ r, s }` with `s` normalised to the low half of the curve order, as
 * Ethereum requires (KMS may return either half).
 */
export function derSignatureToRs(der: Uint8Array): { r: bigint; s: bigint } {
  const sequence = readTlv(der, 0);
  if (sequence.tag !== 0x30) throw new SigningError("KMS signature: expected a DER SEQUENCE");
  const rTlv = readTlv(der, sequence.start);
  if (rTlv.tag !== 0x02) throw new SigningError("KMS signature: expected INTEGER r");
  const sTlv = readTlv(der, rTlv.end);
  if (sTlv.tag !== 0x02) throw new SigningError("KMS signature: expected INTEGER s");
  const r = bytesToBigInt(der.slice(rTlv.start, rTlv.end));
  let s = bytesToBigInt(der.slice(sTlv.start, sTlv.end));
  if (s > SECP256K1_HALF_N) s = SECP256K1_N - s;
  return { r, s };
}

// ---------------------------------------------------------------------------
// viem account + VerantaSigner
// ---------------------------------------------------------------------------

function defaultClient(region?: string): KmsClientLike {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return new KMSClient({
    region: region ?? env?.AWS_REGION ?? env?.AWS_DEFAULT_REGION ?? "us-east-1",
  });
}

/**
 * Wrap a KMS secp256k1 key as a viem `LocalAccount`.
 *
 * Usable anywhere viem accepts a local account (wallet clients, `toSigner`,
 * `new Veranta({ signer })`). One `GetPublicKey` call resolves the address;
 * every signature is one `Sign` call (`MessageType: DIGEST`). KMS does not
 * return the recovery id, so both parities are tried and the one that
 * recovers to the key's address is kept.
 */
export async function kmsAccount(options: KmsSignerOptions): Promise<LocalAccount> {
  const { keyId } = options;
  if (!keyId) throw new ConfigError("kmsAccount requires a KMS keyId (key id, alias/... or ARN)");
  const client = options.client ?? defaultClient(options.region);

  const pub = (await client.send(
    new GetPublicKeyCommand({ KeyId: keyId }),
  )) as GetPublicKeyCommandOutput;
  if (!pub.PublicKey) throw new SigningError(`KMS key ${keyId} returned no public key`);
  const publicKey = spkiToPublicKey(pub.PublicKey);
  const address = publicKeyToAddress(publicKey);

  const signHash = async (hash: Hex): Promise<Signature> => {
    const out = (await client.send(
      new SignCommand({
        KeyId: keyId,
        Message: hexToBytes(hash),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    )) as SignCommandOutput;
    if (!out.Signature) throw new SigningError("KMS Sign returned no signature");
    const { r, s } = derSignatureToRs(out.Signature);
    for (const yParity of [0, 1] as const) {
      const signature: Signature = {
        r: numberToHex(r, { size: 32 }),
        s: numberToHex(s, { size: 32 }),
        v: BigInt(27 + yParity),
        yParity,
      };
      const recovered = await recoverAddress({ hash, signature });
      if (recovered.toLowerCase() === address.toLowerCase()) return signature;
    }
    throw new SigningError("KMS signature does not recover to the key's address");
  };

  const account = toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(await signHash(hash));
    },
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signHash(hashTypedData(typedData as any)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const signature = await signHash(keccak256(await serializer(transaction as any)));
      return await serializer(transaction as any, signature);
    },
    // EIP-7702: keccak256(0x05 || rlp([chainId, address, nonce])). Needed
    // whenever the KMS key relays a type-4 for itself (approvals, limit
    // orders, builder-fee orders); the intent-only MM path never calls it.
    async signAuthorization(authorization) {
      const target = (authorization.address ?? authorization.contractAddress) as Address;
      const { chainId, nonce } = authorization;
      const signature = await signHash(hashAuthorization({ address: target, chainId, nonce }));
      return { address: target, chainId, nonce, ...signature };
    },
  });
  return { ...account, publicKey, source: "kms" };
}

/**
 * AWS KMS-backed {@link VerantaSigner}: the Python `KmsSigner` twin.
 *
 *     const signer = await KmsSigner.create({ keyId: "alias/mm-veranta", region: "us-east-1" });
 *     const client = new Veranta({ signer });
 *
 * Can sign EIP-7702 authorizations (so blitz passthroughs and builder-fee
 * orders work) and cannot broadcast on its own (use the relayer, or direct
 * mode with `rpcUrl`). `account` exposes the underlying viem account.
 */
export class KmsSigner implements VerantaSigner {
  readonly canSignAuthorization = true;
  readonly canSendTransaction = false;
  private readonly inner: VerantaSigner;

  private constructor(
    readonly keyId: string,
    readonly account: LocalAccount,
  ) {
    this.inner = toSigner(account);
  }

  /** Resolve the key's address from KMS (one `GetPublicKey` call) and build the signer. */
  static async create(options: KmsSignerOptions): Promise<KmsSigner> {
    return new KmsSigner(options.keyId, await kmsAccount(options));
  }

  get address(): Address {
    return this.account.address;
  }

  signTypedData(payload: TypedDataPayload): Promise<Hex> {
    return this.inner.signTypedData(payload);
  }

  signAuthorization(auth: {
    chainId: number;
    address: Address;
    nonce: number;
  }): Promise<SignedAuthorization> {
    return this.inner.signAuthorization(auth);
  }

  signTransaction(tx: TransactionSerializable): Promise<Hex> {
    return this.inner.signTransaction(tx);
  }

  sendTransaction(tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }): Promise<Hex> {
    return this.inner.sendTransaction(tx);
  }
}
