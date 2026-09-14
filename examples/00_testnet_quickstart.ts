/**
 * ZERO-SETUP testnet quickstart: no faucet hunting, no keys to source.
 *
 * Generates a wallet, funds it from the testnet fork's dev faucet, and
 * trades — all in one script:
 *
 *     pnpm tsx examples/00_testnet_quickstart.ts
 *
 * (Re-running with VERANTA_PRIVATE_KEY set reuses your wallet instead.)
 */

import { Veranta, TESTNET_EXPLORER_URL, fundTestnetWallet } from "veranta-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// 1. A wallet. Fresh one by default — SAVE THE KEY if you want to keep it.
const privateKey =
  (process.env.VERANTA_PRIVATE_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const wallet = privateKeyToAccount(privateKey);
console.log("wallet:", wallet.address);
console.log("key:   ", privateKey, "(save this to reuse the wallet)");

// 2. Free testnet funds (dev faucet on the fork; mainnet is never touched).
const funded = await fundTestnetWallet(wallet.address);
console.log(`funded: ${Number(funded.ethWei) / 1e18} ETH, ${Number(funded.usdcRaw) / 1e6} USDC`);

// 3. Trade.
const client = new Veranta({ network: "testnet", signer: privateKey });

await client.account.approveUsdc(); // one-time; gasless via the relayer
console.log("USDC approved");

const receipt = await client.trade.marketOpen("ETH/USD", "long", {
  collateral: 100,
  leverage: 5,
  onEvent: (event) => console.log(`  ${event.type}`),
});
console.log(`opened: ${TESTNET_EXPLORER_URL}/tx/${receipt.txHash}`);

// 4. Inspect and close.
const data = await client.account.positions();
console.log("positions:", data.positions.length);
const position = data.positions[0];
if (position) {
  await client.trade.marketClose(position.pairIndex, position.index, {
    collateralToClose: Number(position.collateral) / 1e6,
  });
  console.log("closed. You just did a full round trip on Veranta testnet.");
}
