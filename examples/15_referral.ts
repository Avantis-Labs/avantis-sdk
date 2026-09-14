/**
 * Referral: register a code (gasless), attach to one, read stats.
 * Referral actions are caller-scoped: trader key only.
 */

import { Veranta } from "veranta-sdk";

const client = new Veranta();

// Register your own code (gasless via RegisterCodeReq intent):
await client.referral.registerCodeGasless("MYCODE");
console.log("registered MYCODE");

// A trader attaches to someone's code:
// await client.referral.setCodeGasless("FRIENDCODE");

// Stats:
const trader = client.signer!.address;
console.log("stats:", JSON.stringify(await client.info.referralStats(trader)).slice(0, 300));

// Claim accumulated rebates (as the referrer):
// await client.account.claimRebate();
