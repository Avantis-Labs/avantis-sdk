/** Open positions with live net-PnL math (compute module = UI parity). */

import {
  Avantis,
  compute,
  positionCollateral,
  positionLeverage,
  positionOpenPrice,
  positionSide,
} from "avantis-sdk";

const client = new Avantis();

const data = await client.account.positions();
console.log(`positions: ${data.positions.length}, limit orders: ${data.limitOrders.length}`);

const pairs = await client.markets.pairs();
for (const position of data.positions) {
  const info = pairs.get(position.pairIndex);
  if (!info) continue;
  const price = await client.markets.price(position.pairIndex);
  const pnl = compute.positionNetPnl(position, info, price);
  console.log(
    `#${position.pairIndex}/${position.index}`,
    positionSide(position),
    `${positionCollateral(position)} USDC x${positionLeverage(position)}`,
    `open ${positionOpenPrice(position)} now ${price}`,
    `net PnL ${pnl.net.toFixed(2)} USDC (gross ${pnl.gross.toFixed(2)})`,
  );
}
