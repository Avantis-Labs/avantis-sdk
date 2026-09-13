/**
 * Direct mode: sign EIP-1559 transactions yourself and broadcast via your
 * own RPC (no relayer). You pay gas in ETH.
 *
 * Env: AVANTIS_PRIVATE_KEY (trader key), AVANTIS_RPC_URL (any Base RPC).
 */

import { Avantis } from "avantis-sdk";

const client = new Avantis({
  execution: "direct",
  rpcUrl: process.env.AVANTIS_RPC_URL ?? "https://mainnet.base.org",
});

// Approvals and trades all become normal transactions from your EOA:
await client.account.approveUsdc(1_000);
const receipt = await client.trade.marketOpen("ETH/USD", "long", {
  collateral: 100,
  leverage: 10,
});
console.log("route:", receipt.route, "tx:", receipt.txHash);
