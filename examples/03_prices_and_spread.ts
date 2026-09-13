/** Live price (feed-v3) and risk-engine v2 spread quote. */

import { Avantis } from "avantis-sdk";

const client = new Avantis();

const price = await client.markets.price("ETH/USD");
console.log("ETH/USD price:", price);

const quote = await client.markets.spread("ETH/USD", {
  isLong: true,
  collateral: 100,
  leverage: 10,
});
console.log("spread %:", quote.spreadPct);
console.log("mechanism:", quote.spreadMechanism, "byPass:", quote.byPass);
