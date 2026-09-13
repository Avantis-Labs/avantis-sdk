/**
 * LP: deposit/withdraw USDC in the ERC-4626 tranche (avUSDC).
 * LP actions are caller-scoped: trader key only (no delegate mode).
 */

import { Avantis } from "avantis-sdk";

const client = new Avantis();

const state = await client.lp.state();
console.log("vault state:", JSON.stringify(state).slice(0, 300));

// USDC must be approved to the TRANCHE (not TradingStorage):
const meta = await client.meta();
const tranche = meta.addresses.tranche ?? meta.addresses.juniorTranche;
if (tranche) {
  await client.account.approveUsdc(1_000, { spender: tranche as `0x${string}` });
}

await client.lp.deposit(100);
console.log("deposited 100 USDC");

await client.lp.withdraw(50);
console.log("withdrew 50 USDC");

// APY history:
console.log("returns:", JSON.stringify(await client.info.vaultReturns()).slice(0, 200));
