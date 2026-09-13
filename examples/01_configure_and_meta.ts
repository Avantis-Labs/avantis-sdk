/**
 * Configure the client and read the /v2/meta bootstrap.
 *
 * Run: pnpm tsx examples/01_configure_and_meta.ts
 *
 * Env (all optional for reads):
 *   AVANTIS_NETWORK=mainnet|testnet
 *   AVANTIS_PRIVATE_KEY=0x...       delegate/API key or trader key
 *   AVANTIS_TRADER_ADDRESS=0x...    delegate mode when != key's address
 */

import { Avantis } from "avantis-sdk";

const client = new Avantis(); // env-driven; or new Avantis({ network: "testnet", ... })

console.log("network:", client.config.network);
console.log("tx-builder:", client.config.txBuilderUrl);
console.log("batched-market:", client.config.batchedMarketUrl);

const meta = await client.meta();
console.log("chainId:", meta.chainId);
console.log("tradingRouter:", meta.addresses.tradingRouter);
console.log("delegationTemplate:", meta.addresses.delegationTemplate);
