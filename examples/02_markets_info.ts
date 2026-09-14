/** Pair catalog: symbols, leverage envelopes, fees, OI. */

import { Veranta, isUpside, pairSymbol } from "veranta-sdk";

const client = new Veranta();

const pairs = await client.markets.pairs();
console.log(`listed pairs: ${pairs.size}`);

for (const info of [...pairs.values()].slice(0, 10)) {
  const lev = info.leverages ?? {};
  console.log(
    `${String(info.index).padStart(3)} ${pairSymbol(info).padEnd(18)}`,
    `lev ${lev.minLeverage}-${lev.maxLeverage}x`,
    `openFee ${info.openFeeP}%`,
    isUpside(info) ? "[UPSIDE]" : "",
  );
}

const eth = await client.markets.pair("ETH/USD");
console.log("ETH/USD index:", eth.index, "maxGainP:", eth.values?.maxGainP);
