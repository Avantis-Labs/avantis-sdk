/**
 * Delegate (API key) onboarding, fully from the SDK.
 *
 * The trader key signs ONE DelegateReq intent (with the ToS text); the
 * fresh delegate key relays setDelegateWithSig gaslessly. Afterwards the
 * delegate key trades on the trader's behalf — the trader key is never
 * needed again (until revoke).
 *
 * Env: TRADER_PRIVATE_KEY (used transiently for the one signature).
 */

import { Veranta, toSigner } from "veranta-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const traderKey = process.env.TRADER_PRIVATE_KEY as `0x${string}`;
if (!traderKey) throw new Error("set TRADER_PRIVATE_KEY");
const trader = privateKeyToAccount(traderKey);

// 1. Fresh delegate key (this is your API key — store it safely).
const delegateKey = generatePrivateKey();
const delegate = privateKeyToAccount(delegateKey);
console.log("delegate address:", delegate.address);

// 2. Register: delegate key relays; trader key signs the intent.
const client = new Veranta({ signer: delegateKey, trader: trader.address });
const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600; // 90 days, ABSOLUTE seconds
await client.account.registerDelegate(delegate.address, expiry, toSigner(traderKey));

// 3. Verify + trade with the delegate key only.
await client.account.verifyDelegation();
console.log("delegation:", await client.account.delegationStatus());

// From now on:
//   VERANTA_PRIVATE_KEY=<delegateKey> VERANTA_TRADER_ADDRESS=<trader> node bot.js
// Revoke later with the trader key:
//   new Veranta({ signer: traderKey }).account.revokeDelegate(delegate.address)
