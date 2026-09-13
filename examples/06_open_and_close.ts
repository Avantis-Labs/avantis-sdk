/** Open, inspect, and close a position (full close = full collateral). */

import { Avantis, positionCollateral } from "avantis-sdk";

const client = new Avantis();

await client.trade.marketOpen("ETH/USD", "long", { collateral: 50, leverage: 5 });
await new Promise((resolve) => setTimeout(resolve, 3_000));

const ethIndex = await client.markets.pairIndex("ETH/USD");
const data = await client.account.positions();
const position = data.positions.find((p) => p.pairIndex === ethIndex);
if (!position) throw new Error("position not found yet; check account.positions()");

console.log("opened:", position.pairIndex, position.index, positionCollateral(position), "USDC");

// Partial close: pass part of the collateral. Full close: all of it.
const receipt = await client.trade.marketClose(position.pairIndex, position.index, {
  collateralToClose: positionCollateral(position),
});
console.log("closed, tx:", receipt.txHash);
