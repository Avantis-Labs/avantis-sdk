/** Limit / stop-limit orders: place, edit, cancel. Escrows USDC on placement. */

import { Veranta, limitOrderPrice } from "veranta-sdk";

const client = new Veranta();

const price = await client.markets.price("ETH/USD");
console.log("market:", price);

// Limit-buy 5% below market (stop: true would make it a stop-limit).
await client.trade.limitOpen("ETH/USD", "long", {
  collateral: 50,
  leverage: 5,
  price: price * 0.95,
});

const data = await client.account.positions();
const order = data.limitOrders.at(-1);
if (!order) throw new Error("no limit order found");
console.log("placed at:", limitOrderPrice(order), "index:", order.index);

// Move it to 3% below market.
await client.trade.updateLimitOrder(order.pairIndex, order.index, { price: price * 0.97 });

// And cancel (refunds the escrowed collateral).
await client.trade.cancelLimitOrder(order.pairIndex, order.index);
console.log("canceled");
