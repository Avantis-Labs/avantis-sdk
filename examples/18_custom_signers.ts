/**
 * Custom signers: anything viem-shaped plugs in.
 *
 * - 0x private key (simplest)
 * - viem LocalAccount (mnemonic, hardware, KMS adapters)
 * - viem WalletClient (browser wallets — see avantis-sdk/react)
 * - your own AvantisSigner implementation (HSM, remote signer, ...)
 */

import { Avantis, type AvantisSigner } from "avantis-sdk";
import { mnemonicToAccount } from "viem/accounts";

// viem account (a KMS-backed viem account works identically, e.g. from
// "@aws-kms-signer/viem"-style adapters that expose signTypedData):
const account = mnemonicToAccount("test test test test test test test test test test test junk");
const client = new Avantis({ signer: account, network: "testnet" });
console.log("signer:", client.signer!.address);

// Or fully custom — implement the 4-method interface:
const custom: AvantisSigner = {
  address: account.address,
  canSignAuthorization: true,
  canSendTransaction: false,
  signTypedData: (payload) => account.signTypedData(payload as any),
  signAuthorization: async ({ chainId, address, nonce }) => {
    const auth = await account.signAuthorization!({ contractAddress: address, chainId, nonce });
    return { address, chainId, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 };
  },
  signTransaction: (tx) => account.signTransaction(tx as any),
  sendTransaction: () => {
    throw new Error("not supported");
  },
};
const client2 = new Avantis({ signer: custom, network: "testnet" });
console.log("custom signer:", client2.signer!.address);
