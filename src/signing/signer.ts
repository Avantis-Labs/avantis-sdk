/**
 * Signer abstraction: one interface, multiple key backends.
 *
 * The signer does not know about traders or delegates: identity resolution
 * lives in the client config; the signer just produces secp256k1 signatures.
 *
 * Accepted sources (`toSigner`):
 * - a 0x-hex private key (backend / bots / session keys)
 * - a viem `LocalAccount` (`privateKeyToAccount`, mnemonic, KMS adapters)
 * - a viem `WalletClient` (browser wallets via wagmi)
 * - any custom object implementing {@link AvantisSigner}
 */

import type {
  Account,
  Address,
  Hex,
  LocalAccount,
  TransactionSerializable,
  WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError, SigningError } from "../errors.js";
import type { Eip712Field } from "../types.js";

export interface TypedDataPayload {
  domain: {
    name?: string;
    version?: string;
    chainId?: number | bigint;
    verifyingContract?: Address;
  };
  /** WITHOUT the EIP712Domain type (viem convention). */
  types: Record<string, Eip712Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** EIP-7702 set-code authorization, blitz-relayer DTO orientation. */
export interface SignedAuthorization {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

/** Minimal signer surface consumed by the SDK. */
export interface AvantisSigner {
  readonly address: Address;
  /** True when the signer can produce EIP-7702 authorizations (local keys). */
  readonly canSignAuthorization: boolean;
  /** True when the signer can broadcast its own transactions (browser wallet). */
  readonly canSendTransaction: boolean;
  signTypedData(payload: TypedDataPayload): Promise<Hex>;
  signAuthorization(auth: {
    chainId: number;
    address: Address;
    nonce: number;
  }): Promise<SignedAuthorization>;
  /** Sign a serializable transaction, returning the raw signed tx. */
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
  /** Send a transaction through the wallet (browser path). */
  sendTransaction(tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }): Promise<Hex>;
}

/** Anything `toSigner` can adapt. */
export type SignerSource = Hex | LocalAccount | WalletClient | AvantisSigner;

/** Normalize a 65-byte signature so v is 27/28 (some wallets return 0/1). */
export function normalizeSignature(signature: Hex): Hex {
  if (signature.length !== 132) return signature;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v === 0 || v === 1) {
    return `${signature.slice(0, 130)}${(v + 27).toString(16)}` as Hex;
  }
  return signature;
}

function toSignedAuthorization(
  auth: { chainId: number; address: Address; nonce: number },
  signed: { r: Hex; s: Hex; yParity?: number; v?: bigint | number },
): SignedAuthorization {
  const yParity = signed.yParity ?? (Number(signed.v ?? 27n) === 28 ? 1 : 0);
  return {
    address: auth.address,
    chainId: auth.chainId,
    nonce: auth.nonce,
    r: signed.r,
    s: signed.s,
    yParity,
  };
}

class AccountSigner implements AvantisSigner {
  readonly canSignAuthorization = true;
  readonly canSendTransaction = false;

  constructor(private readonly account: LocalAccount) {
    if (!account.signTypedData || !account.signTransaction) {
      throw new ConfigError("Account is missing signTypedData/signTransaction implementations");
    }
  }

  get address(): Address {
    return this.account.address;
  }

  async signTypedData(payload: TypedDataPayload): Promise<Hex> {
    const signature = await this.account.signTypedData!(payload as any);
    return normalizeSignature(signature);
  }

  async signAuthorization(auth: {
    chainId: number;
    address: Address;
    nonce: number;
  }): Promise<SignedAuthorization> {
    const signFn =
      (this.account as any).signAuthorization ??
      (this.account as any).experimental_signAuthorization;
    if (!signFn) {
      throw new SigningError(
        "This viem account does not support signAuthorization; upgrade viem to >= 2.28",
      );
    }
    const signed = await signFn.call(this.account, {
      address: auth.address,
      contractAddress: auth.address,
      chainId: auth.chainId,
      nonce: auth.nonce,
    });
    return toSignedAuthorization(auth, signed);
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    return await this.account.signTransaction!(tx as any);
  }

  async sendTransaction(): Promise<Hex> {
    throw new SigningError(
      "A bare account cannot broadcast transactions; use direct mode with rpcUrl or pass a WalletClient",
    );
  }
}

class WalletClientSigner implements AvantisSigner {
  constructor(private readonly client: WalletClient) {
    if (!client.account) {
      throw new ConfigError(
        "WalletClient has no account attached; create it with an account (wagmi's useWalletClient does this)",
      );
    }
  }

  private get account(): Account {
    return this.client.account!;
  }

  get address(): Address {
    return this.account.address;
  }

  get canSignAuthorization(): boolean {
    return this.account.type === "local";
  }

  readonly canSendTransaction = true;

  async signTypedData(payload: TypedDataPayload): Promise<Hex> {
    const signature = await this.client.signTypedData({
      account: this.account,
      ...payload,
    } as any);
    return normalizeSignature(signature);
  }

  async signAuthorization(auth: {
    chainId: number;
    address: Address;
    nonce: number;
  }): Promise<SignedAuthorization> {
    if (!this.canSignAuthorization) {
      throw new SigningError(
        "Browser wallets cannot sign EIP-7702 authorizations. Use a session key " +
          "(see account.registerDelegate / useSessionKey) or direct mode for this operation.",
      );
    }
    const signed = await (this.client as any).signAuthorization({
      account: this.account,
      address: auth.address,
      contractAddress: auth.address,
      chainId: auth.chainId,
      nonce: auth.nonce,
    });
    return toSignedAuthorization(auth, signed);
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    if (this.account.type === "local" && (this.account as LocalAccount).signTransaction) {
      return await (this.account as LocalAccount).signTransaction!(tx as any);
    }
    throw new SigningError(
      "WalletClient accounts cannot sign raw transactions; the SDK sends via the wallet instead",
    );
  }

  async sendTransaction(tx: {
    to: Address;
    data: Hex;
    value?: bigint;
    gas?: bigint;
  }): Promise<Hex> {
    return await this.client.sendTransaction({
      account: this.account,
      chain: this.client.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: tx.gas,
    } as any);
  }
}

function isHexKey(source: SignerSource): source is Hex {
  return typeof source === "string" && source.startsWith("0x") && source.length === 66;
}

function isAvantisSigner(source: SignerSource): source is AvantisSigner {
  return (
    typeof source === "object" &&
    source !== null &&
    "canSignAuthorization" in source &&
    typeof (source as AvantisSigner).signTypedData === "function"
  );
}

function isLocalAccount(source: SignerSource): source is LocalAccount {
  return (
    typeof source === "object" &&
    source !== null &&
    (source as Account).type === "local" &&
    typeof (source as LocalAccount).signTypedData === "function"
  );
}

function isWalletClient(source: SignerSource): source is WalletClient {
  return (
    typeof source === "object" &&
    source !== null &&
    "transport" in source &&
    typeof (source as WalletClient).signTypedData === "function"
  );
}

/** Adapt any {@link SignerSource} into the SDK's signer interface. */
export function toSigner(source: SignerSource): AvantisSigner {
  if (isHexKey(source)) return new AccountSigner(privateKeyToAccount(source));
  if (isAvantisSigner(source)) return source;
  if (isLocalAccount(source)) return new AccountSigner(source);
  if (isWalletClient(source)) return new WalletClientSigner(source);
  throw new ConfigError(
    "Unsupported signer: pass a 0x private key, a viem LocalAccount, a viem WalletClient, or an AvantisSigner implementation",
  );
}
