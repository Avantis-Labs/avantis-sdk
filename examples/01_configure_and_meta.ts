/**
 * Configure the client and read the /v2/meta bootstrap.
 *
 * Run: pnpm tsx examples/01_configure_and_meta.ts
 *
 * Env (all optional for reads):
 *   VERANTA_NETWORK=mainnet|testnet
 *   VERANTA_PRIVATE_KEY=0x...       delegate/API key or trader key
 *   VERANTA_TRADER_ADDRESS=0x...    delegate mode when != key's address
 */

import { Veranta } from "veranta-sdk";

const client = new Veranta(); // env-driven; or new Veranta({ network: "testnet", ... })

console.log("network:", client.config.network);
console.log("tx-builder:", client.config.txBuilderUrl);
console.log("batched-market:", client.config.batchedMarketUrl);

const meta = await client.meta();
console.log("chainId:", meta.chainId);
console.log("tradingRouter:", meta.addresses.tradingRouter);
console.log("delegationTemplate:", meta.addresses.delegationTemplate);
