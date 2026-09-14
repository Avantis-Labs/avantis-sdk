/**
 * AWS KMS signer (backend only): the private key never leaves KMS.
 *
 * Twin of the Python SDK's examples/21_kms_testnet_mm_open.py. The KMS key
 * IS the trader EOA (no delegate): `KmsSigner` from `veranta-sdk/kms` signs
 * EIP-712 intents, EIP-7702 authorizations (blitz relays such as the USDC
 * approve below, limit orders, builder-fee orders) and EIP-1559 transactions
 * (direct mode) through KMS `Sign` calls. Flow: allowance check -> MM
 * fast-path open (intent-only) -> positions.
 *
 * Requires the optional peer `@aws-sdk/client-kms` and a KMS key with
 * KeySpec ECC_SECG_P256K1 / KeyUsage SIGN_VERIFY. Standard AWS credential
 * resolution applies (AWS_PROFILE, AWS_REGION, IAM role, ...); pass a
 * configured `client` to `KmsSigner.create` for custom endpoints.
 *
 * Env:
 *   VERANTA_KMS_KEY_ID=alias/...     KMS key id, alias or ARN
 *   AWS_REGION=us-east-1
 */

import {
  AggregatorOrderType,
  Veranta,
  type BatchedMarketEvent,
  RelayError,
  positionCollateral,
  positionLeverage,
  positionOpenPrice,
  positionSide,
} from "veranta-sdk";
import { KmsSigner } from "veranta-sdk/kms";

const PAIR = "BTC/USD";
const COLLATERAL_USDC = 300; // collateral, not notional
const LEVERAGE = 20;
const SLIPPAGE_PERCENT = 5;

const signer = await KmsSigner.create({
  keyId: process.env.VERANTA_KMS_KEY_ID ?? "alias/testnet/mm-avantis",
  region: process.env.AWS_REGION ?? "us-east-1",
});

// No `trader`: the KMS wallet is the trader. The testnet profile defaults
// rpcUrl, which a trader that signs for itself needs to read the EIP-7702
// authorization nonce for blitz relays (the approve below).
const client = new Veranta({ signer, network: "testnet" });
const trader = client.trade.trader;
console.log("KMS trader:", trader);

const pair = await client.markets.pair(PAIR);
const minLeverage = pair.leverages?.minLeverage ?? 0;
const maxLeverage = pair.leverages?.maxLeverage ?? Number.POSITIVE_INFINITY;
if (LEVERAGE < minLeverage || LEVERAGE > maxLeverage) {
  throw new Error(`leverage ${LEVERAGE} outside ${minLeverage}-${maxLeverage} on ${PAIR}`);
}
const notional = COLLATERAL_USDC * LEVERAGE;
if (notional < (pair.minLevPosUSDC ?? 0)) {
  throw new Error(`notional ${notional} below minLevPosUSDC ${pair.minLevPosUSDC} on ${PAIR}`);
}

// One-time: USDC allowance to TradingStorage. The approve relays as a type-4
// through blitz; its EIP-7702 authorization is signed by the KMS key.
let allowance = await client.account.allowance();
console.log(`USDC balance=${allowance.balanceUsdc} allowance=${allowance.allowanceUsdc}`);
if (Number(allowance.allowanceUsdc ?? 0) < COLLATERAL_USDC) {
  console.log("approving unlimited USDC to TradingStorage...");
  const approve = await client.account.approveUsdc();
  console.log("approve:", approve.route, approve.txHash);
  allowance = await client.account.allowance();
}
if (Number(allowance.balanceUsdc ?? 0) < COLLATERAL_USDC) {
  throw new Error(`insufficient USDC on ${trader}: need >= ${COLLATERAL_USDC} (plus the open fee)`);
}

// MM fast path: local intent, one KMS signature, intent-only submission
// (no EIP-7702 leg; the batched-market API executes the signed intent).
const price = await client.markets.price(PAIR);
console.log(
  `${PAIR} index=${pair.index} live=${price} collateral=${COLLATERAL_USDC} ` +
    `leverage=${LEVERAGE}x slippage=${SLIPPAGE_PERCENT}%`,
);
const builder = await client.localIntents();
const intent = builder.openTrade({
  trader,
  pairIndex: pair.index,
  isLong: true,
  collateralUsdc: COLLATERAL_USDC,
  leverage: LEVERAGE,
  openPrice: price,
  slippagePercent: SLIPPAGE_PERCENT,
});

const journey = (event: BatchedMarketEvent) => {
  const code = (event.data as { code?: string } | undefined)?.code;
  console.log(`  [${event.seq}] ${event.type}${code ? ` code=${code}` : ""}`);
};

console.log("submitting intent-only (MM fast path)");
try {
  const receipt = await client.engine.submitIntentBatch(intent, AggregatorOrderType.MARKET_OPEN, {
    onEvent: journey,
  });
  console.log("route", receipt.route);
  console.log("tx", receipt.txHash);
  console.log("trackingId", receipt.trackingId);
  console.log("orderId", receipt.orderId);
} catch (error) {
  if (error instanceof RelayError) console.error("order failed:", error.message);
  throw error;
}

const { positions } = await client.account.positions();
console.log("open positions:", positions.length);
for (const position of positions) {
  console.log(
    `  pair=${position.pairIndex} idx=${position.index} ${positionSide(position)} ` +
      `collat=${positionCollateral(position)} lev=${positionLeverage(position)} ` +
      `px=${positionOpenPrice(position)}`,
  );
}
