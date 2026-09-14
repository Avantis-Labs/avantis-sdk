# veranta-sdk

Official TypeScript SDK for [Veranta](https://veranta.xyz) v2, perpetuals
on Base. viem-based and API-first: no ABIs, no ethers; the SDK fetches
payloads from the Veranta tx-builder, signs locally (with a digest
correctness gate), and executes gaslessly through the Veranta relayer, or
through your own RPC/wallet.

One package, three entry points:

| import | for |
|---|---|
| `veranta-sdk` | Node backends, bots, edge, the full trading client |
| `veranta-sdk/react` | React apps, wagmi + TanStack Query hooks, session keys, live prices |
| `veranta-sdk/kms` | Node backends signing with an AWS KMS key (`KmsSigner`); the key never leaves KMS |

Full feature parity with the Python [`veranta-sdk`](https://github.com/Avantis-Labs/avantis_trader_sdk):
market/limit/TWAP orders, TP/SL (global + partial), margin, positions,
portfolio history, LP vault, referrals, builder codes, price streams, and a
market-maker fast path.

## Install

```bash
npm i veranta-sdk viem
# for React hooks:
npm i wagmi @tanstack/react-query
# for the AWS KMS signer (veranta-sdk/kms):
npm i @aws-sdk/client-kms
```

## Backend quickstart (10 lines)

```ts
import { Veranta } from "veranta-sdk";

// env: VERANTA_PRIVATE_KEY=0x… (API key), VERANTA_TRADER_ADDRESS=0x… (your wallet)
const client = new Veranta();

const receipt = await client.trade.marketOpen("ETH/USD", "long", {
  collateral: 100, // USDC
  leverage: 10,
  takeProfit: 4200,
});
console.log(receipt.txHash);
```

Gasless by default: no RPC, no ETH. Get an API (delegate) key at
[delegate.veranta.xyz](https://delegate.veranta.xyz) or with
`examples/11_delegate_onboarding.ts`.

## Try it on testnet in 60 seconds

The Veranta testnet is a fork of Base (same chainId 8453, same contracts)
with a built-in dev faucet, no keys to source, no faucet sites:

```ts
import { Veranta, fundTestnetWallet } from "veranta-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
await fundTestnetWallet(privateKeyToAccount(key).address); // 0.05 ETH + 1,000 USDC

const client = new Veranta({ network: "testnet", signer: key });
await client.account.approveUsdc(); // gasless
await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 5 });
```

Or just run the script: `pnpm tsx examples/00_testnet_quickstart.ts`.
`network: "testnet"` rebinds every service URL to the staging stack and
defaults `rpcUrl` to the fork RPC; for browser apps point your wagmi
transport at `TESTNET_RPC_URL` (imported from `veranta-sdk`) so on-chain
reads hit the fork too. The faucet only exists on the fork, mainnet is
never touched.

## React quickstart

```tsx
import { VerantaProvider, useMarketOpen, usePrice, usePositions, useSessionKey } from "veranta-sdk/react";

// inside <WagmiProvider> + <QueryClientProvider>:
<VerantaProvider network="mainnet">{children}</VerantaProvider>;

function Trade() {
  const price = usePrice("ETH/USD");            // live via SSE
  const positions = usePositions();             // auto-invalidated after fills
  const session = useSessionKey();              // one-click trading (no popups)
  const open = useMarketOpen({ onEvent: (e) => console.log(e.type) });

  return (
    <button onClick={() => open.mutate({ pair: "ETH/USD", side: "long", collateral: 100, leverage: 10 })}>
      Long ETH @ {price?.price}
    </button>
  );
}
```

Works with every wagmi-compatible wallet layer (RainbowKit, ConnectKit,
Privy, Reown AppKit, plain injected). A complete trading panel lives in
[`examples/next-app`](./examples/next-app).

`usePrice` streams over one shared SSE connection that runs **inside a Web
Worker by default** (same pattern as the production Veranta UI): tick
parsing and fan-out stay off the main thread, so charts and forms keep
rendering smoothly under heavy price traffic. No bundler config needed (the
worker spawns from an inline Blob); it falls back to a main-thread stream
under SSR or strict CSPs, and `priceTransport="main"` on the provider
forces the fallback.

## The pieces

- **Namespaces**: `client.trade`, `client.account`, `client.markets`,
  `client.info`, `client.referral`, `client.lp`; pure math in the `compute`
  export (PnL, liquidation, validation, UI parity).
- **Signers**: a `0x` private key, any viem `LocalAccount`, a browser
  `WalletClient`, an AWS KMS key via `KmsSigner` / `kmsAccount` from
  `veranta-sdk/kms` (the Python `KmsSigner` twin; see
  `examples/22_kms_signer.ts`), or your own `VerantaSigner` (HSM, remote
  signer).
- **Execution**: signed EIP-712 intents to the batched-market API with a
  streamed order lifecycle; gasless EIP-7702 (Gelato) relays for everything
  else; automatic wallet-transaction fallback for browser wallets; `direct`
  mode for your own RPC.
- **Session keys (1CT)**: `useSessionKey()` registers a local delegate key
  (one wallet signature) so orders sign silently afterwards. Keys can only
  trade; they cannot move funds; revoke anytime.
- **Market-maker fast path**: `client.localIntents()` builds intents with
  zero HTTP on the hot path; see `examples/13_mm_fast_path.ts`.
- **Correctness**: every intent is digest-asserted before signing; the
  golden-vector suite proves all 17 intent kinds against the on-chain
  hashing library, and the EIP-7702 encoder is byte-identical to
  `@gelatocloud/gasless`.

## Configuration

Constructor options > env vars > network profile (`mainnet` default,
`testnet` staging stack). Env: `VERANTA_PRIVATE_KEY`,
`VERANTA_TRADER_ADDRESS`, `VERANTA_NETWORK`, `VERANTA_EXECUTION`,
`VERANTA_RPC_URL`, `VERANTA_BUILDER_CODE`, `VERANTA_BUILDER_FEE_PERCENT`,
plus per-service URL overrides. Pre-rename `AVANTIS_*` names are still read
when the `VERANTA_*` one is unset (with a console warning). See `src/config.ts`.

## Builder codes

A builder code attributes order flow to your integration and charges a
**per-order fee**: a percent of the order's notional (collateral x
leverage) that you choose per order, up to the three public caps your code
registers (open/increase, close, PnL-pair close). Fees are pulled from the
trader's USDC allowance **to the BuilderCode registry** and paid to your fee
collector. Never through your own wallet, never through the user's delegate
key.

```ts
// 1. Owner, once (trader wallet, caller-scoped): register the code + caps.
await owner.account.registerBuilderCode("MYAPP", {
  feeCollector: "0x...",
  maxOpenFeePercent: 0.1, // % of notional per open / increase
  maxCloseFeePercent: 0.05,
  maxPnlCloseFeePercent: 0.05,
});

// 2. Each trader, once (trader wallet): the SECOND USDC approval.
await trader.account.approveUsdc(); // collateral -> TradingStorage
await trader.account.approveBuilderFees(); // fees -> BuilderCode registry

// 3. Your app (delegate / session key): attach the code + a default rate.
const client = new Veranta({ builderCode: "MYAPP", builderFeePercent: 0.05 });
await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10 });
// 1,000 notional -> 0.5 USDC to your collector at 0.05%; per-order override:
await client.trade.marketClose("ETH/USD", 0, { collateralToClose: 100, builderFeePercent: 0.02 });
```

How builder orders route:

- Fee-eligible actions are market opens, closes and increases (plus the
  coin-sized variants). Limit/stop placements, TWAP, RFQ, TP/SL and margin
  never charge, and `limitOpen` takes no builder parameter.
- Builder orders relay through the blitz passthrough (receipt route
  `relayer-passthrough`) so the fee-charging EIP-7702 template always
  executes. They settle normally but have **no SSE lifecycle**: `onEvent`
  does not fire; confirm fills with `account.positions()`.
- The EIP-7702 authorization targets the canonical template served by
  `/v2/meta` (`addresses.delegationTemplate`); an explicit
  `delegationAddress` still wins. Registry and template addresses are never
  hard-coded in the SDK.
- Builder fees need a signer that can sign EIP-7702 authorizations (a
  private key or a session key). Direct mode and browser wallets without a
  session key are **refused** with a `ConfigError` instead of silently
  placing a fee-less order.
- Upside (PnL) pairs never pay open/increase fees: the SDK sends an explicit
  zero rate there; closes keep your rate under the PnL-close cap.
- Lookup: `client.account.builderCode("MYAPP")` returns `registered`,
  `owner`, `feeCollector`, the three `max*FeePercent` caps and the
  governance `globalCapPercent`. Trader-side: `account.builderFeeAllowance()`
  (allowances decrement as fees are charged).
- React: `useRegisterBuilderCode`, `useModifyBuilderCode`,
  `useBuilderCodeInfo`, `useApproveBuilderFees`, `useBuilderFeeAllowance`;
  the trading mutations accept `builderFeePercent`.

Full owner + trader + app walkthrough: `examples/20_builder_code.ts`.

## Examples

Runnable scripts `00`-`22` in [`examples/`](./examples) mirroring the Python
SDK's set (22 = AWS KMS backend signer), plus the Next.js trading panel. Agents: read [`AGENTS.md`](./AGENTS.md)
first, it carries the invariants and routing rules.

## Development

```bash
pnpm install
pnpm test            # unit tests incl. golden-vector + EIP-7702 byte parity
pnpm test:e2e        # live testnet round trip (fund -> approve -> open -> TP -> close)
pnpm typecheck && pnpm lint
pnpm check:package   # publint + arethetypeswrong
```

Releases go through changesets: `pnpm changeset`, merge, CI publishes.

MIT
