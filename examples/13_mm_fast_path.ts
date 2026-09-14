/**
 * Market-maker fast path: build intents locally (zero HTTP on the hot
 * path), sign, and POST straight to the batched-market API.
 *
 * One /v2/meta call bootstraps the domain; after that each order is one
 * signature + one HTTP request. The digest gate still runs locally, so a
 * schema drift fails loudly instead of reverting on-chain.
 */

import { AggregatorOrderType, Veranta, signIntent } from "veranta-sdk";

const client = new Veranta();
const signer = client.signer!;
const builder = await client.localIntents(); // bootstraps from /v2/meta

const price = await client.markets.price("ETH/USD"); // or your own feed
const pairIndex = await client.markets.pairIndex("ETH/USD");

const intent = builder.openTrade({
  trader: client.config.trader ?? signer.address,
  pairIndex,
  isLong: true,
  collateralUsdc: 100,
  leverage: 10,
  openPrice: price,
  slippagePercent: 1,
});

const signed = await signIntent(intent, signer); // digest-asserted

// Intent-only execution (no EIP-7702 leg): the MM fast path.
const outcome = await client.engine.batchedMarket.execute(AggregatorOrderType.MARKET_OPEN, {
  userIntent: intent.encodedIntent,
  userSignature: signed.signature,
});
console.log("tracking:", outcome.trackingId, "tx:", outcome.txHash);
