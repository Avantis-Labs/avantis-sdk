/** History + portfolio analytics (info namespace, human units). */

import { Veranta } from "veranta-sdk";

const client = new Veranta();
const trader = (process.env.VERANTA_TRADER_ADDRESS ?? client.signer?.address) as `0x${string}`;

const trades = await client.info.tradeHistory(trader, 0, 5);
console.log("recent fills:", JSON.stringify(trades).slice(0, 300));

console.log("pnl:", JSON.stringify(await client.info.portfolioPnl(trader)).slice(0, 200));
console.log("volume:", JSON.stringify(await client.info.portfolioVolume(trader)).slice(0, 200));
console.log("win rate:", JSON.stringify(await client.info.winRate(trader)).slice(0, 200));
console.log("fees:", JSON.stringify(await client.info.totalFees(trader)).slice(0, 200));
