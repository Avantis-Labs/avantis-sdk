/**
 * Custom signers: anything viem-shaped plugs in.
 *
 * - 0x private key (simplest)
 * - viem LocalAccount (mnemonic, hardware, KMS adapters)
 * - viem WalletClient (browser wallets — see veranta-sdk/react)
 * - your own VerantaSigner implementation (HSM, remote signer, ...)
 */

import { Veranta, type VerantaSigner } from "veranta-sdk";
import { mnemonicToAccount } from "viem/accounts";

// viem account (for AWS KMS use `kmsAccount` / `KmsSigner` from
// "veranta-sdk/kms" — see examples/22_kms_signer.ts):
const account = mnemonicToAccount("test test test test test test test test test test test junk");
const client = new Veranta({ signer: account, network: "testnet" });
console.log("signer:", client.signer!.address);

// Or fully custom — implement the 4-method interface:
const custom: VerantaSigner = {
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
const client2 = new Veranta({ signer: custom, network: "testnet" });
console.log("custom signer:", client2.signer!.address);
