/** Deposit/withdraw margin and increase position size. */

import { Avantis } from "avantis-sdk";

const client = new Avantis();

const data = await client.account.positions();
const position = data.positions[0];
if (!position) throw new Error("open a position first (examples/05)");

// Add 25 USDC collateral (executes against a fresh oracle price):
await client.trade.updateMargin(position.pairIndex, position.index, "deposit", 25);
console.log("margin deposited");

// Increase the position by 50 USDC at 5x:
await client.trade.increasePosition(position.pairIndex, position.index, {
  collateral: 50,
  leverage: 5,
});
console.log("position increased");

// Withdraw 10 USDC back out:
await client.trade.updateMargin(position.pairIndex, position.index, "withdraw", 10);
console.log("margin withdrawn");
