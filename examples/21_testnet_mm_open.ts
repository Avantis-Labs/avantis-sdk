/**
 * End-to-end testnet smoke: MM fast path on the staging stack.
 *
 * Env:
 *   VERANTA_NETWORK=testnet
 *   VERANTA_PRIVATE_KEY=0x...      delegate key registered on testnet
 *   VERANTA_TRADER_ADDRESS=0x...   trader wallet
 */

import { AggregatorOrderType, Veranta, signIntent } from "veranta-sdk";

const client = new Veranta({ network: "testnet" });
await client.account.verifyDelegation();

const pairIndex = await client.markets.pairIndex("ETH/USD");
const price = await client.markets.price(pairIndex);
console.log("testnet ETH/USD:", price);

const builder = await client.localIntents();
const intent = builder.openTrade({
  trader: client.config.trader!,
  pairIndex,
  isLong: true,
  collateralUsdc: 10,
  leverage: 2,
  openPrice: price,
  slippagePercent: 2,
});
const signed = await signIntent(intent, client.signer!);

const outcome = await client.engine.batchedMarket.execute(
  AggregatorOrderType.MARKET_OPEN,
  { userIntent: intent.encodedIntent, userSignature: signed.signature },
  undefined,
  {
    onEvent: (event) => console.log(`  [${event.seq}] ${event.type}`),
  },
);
console.log("filled:", outcome.txHash, "orderId:", outcome.orderId);
