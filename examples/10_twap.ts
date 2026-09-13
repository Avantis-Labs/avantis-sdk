/**
 * TWAP orders: collateral spread over run-time slices (twap-app API; the
 * signed intent is submitted synchronously, no relayer involved).
 * Not available on Upside pairs.
 */

import { Avantis } from "avantis-sdk";

const client = new Avantis();

const receipt = await client.trade.twapOpen("ETH/USD", "long", {
  collateral: 100,
  runTimeSeconds: 600, // spread over 10 minutes
  leverage: 5,
  maxLeverage: 10,
});
console.log("twapId:", receipt.orderId, "tx:", receipt.txHash);

// Standing TWAPs with their per-slice trades:
const twaps = await client.account.twaps();
console.log("twaps:", JSON.stringify(twaps).slice(0, 300));

// Cancel by twapId:
if (receipt.orderId !== undefined) {
  await client.trade.twapCancel(receipt.orderId);
  console.log("canceled");
}
