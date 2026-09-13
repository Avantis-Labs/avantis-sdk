# avantis-sdk

Official TypeScript SDK for [Avantis](https://avantisfi.com) v2 — perpetuals
on Base. viem-based and API-first: no ABIs, no ethers; the SDK fetches
payloads from the Avantis tx-builder, signs locally (with a digest
correctness gate), and executes gaslessly through the Avantis relayer — or
through your own RPC/wallet.

One package, two entry points:

| import | for |
|---|---|
| `avantis-sdk` | Node backends, bots, edge — the full trading client |
| `avantis-sdk/react` | React apps — wagmi + TanStack Query hooks, session keys, live prices |

Full feature parity with the Python [`avantis-trader-sdk`](https://github.com/Avantis-Labs/avantis_trader_sdk):
market/limit/TWAP orders, TP/SL (global + partial), margin, positions,
portfolio history, LP vault, referrals, builder codes, price streams, and a
market-maker fast path.

## Install

```bash
npm i avantis-sdk viem
# for React hooks:
npm i wagmi @tanstack/react-query
```

## Backend quickstart (10 lines)

```ts
import { Avantis } from "avantis-sdk";

// env: AVANTIS_PRIVATE_KEY=0x… (API key), AVANTIS_TRADER_ADDRESS=0x… (your wallet)
const client = new Avantis();

const receipt = await client.trade.marketOpen("ETH/USD", "long", {
  collateral: 100, // USDC
  leverage: 10,
  takeProfit: 4200,
});
console.log(receipt.txHash);
```

Gasless by default: no RPC, no ETH. Get an API (delegate) key at
[delegate.avantisfi.com](https://delegate.avantisfi.com) or with
`examples/11_delegate_onboarding.ts`.

## React quickstart

```tsx
import { AvantisProvider, useMarketOpen, usePrice, usePositions, useSessionKey } from "avantis-sdk/react";

// inside <WagmiProvider> + <QueryClientProvider>:
<AvantisProvider network="mainnet">{children}</AvantisProvider>;

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

## The pieces

- **Namespaces** — `client.trade`, `client.account`, `client.markets`,
  `client.info`, `client.referral`, `client.lp`; pure math in the `compute`
  export (PnL, liquidation, validation — UI parity).
- **Signers** — a `0x` private key, any viem `LocalAccount`, a browser
  `WalletClient`, or your own `AvantisSigner` (KMS/HSM).
- **Execution** — signed EIP-712 intents to the batched-market API with a
  streamed order lifecycle; gasless EIP-7702 (Gelato) relays for everything
  else; automatic wallet-transaction fallback for browser wallets; `direct`
  mode for your own RPC.
- **Session keys (1CT)** — `useSessionKey()` registers a local delegate key
  (one wallet signature) so orders sign silently afterwards. Keys can only
  trade; they cannot move funds; revoke anytime.
- **Market-maker fast path** — `client.localIntents()` builds intents with
  zero HTTP on the hot path; see `examples/13_mm_fast_path.ts`.
- **Correctness** — every intent is digest-asserted before signing; the
  golden-vector suite proves all 17 intent kinds against the on-chain
  hashing library, and the EIP-7702 encoder is byte-identical to
  `@gelatocloud/gasless`.

## Configuration

Constructor options > env vars > network profile (`mainnet` default,
`testnet` staging stack). Env: `AVANTIS_PRIVATE_KEY`,
`AVANTIS_TRADER_ADDRESS`, `AVANTIS_NETWORK`, `AVANTIS_EXECUTION`,
`AVANTIS_RPC_URL`, `AVANTIS_BUILDER_CODE`, `AVANTIS_BUILDER_FEE_PERCENT`,
plus per-service URL overrides. See `src/config.ts`.

## Builder codes

Attribute order flow and earn per-order fees:

```ts
const client = new Avantis({ builderCode: "MYAPP", builderFeePercent: 0.05 });
```

Register a code and set caps with `client.account.registerBuilderCode` —
see `examples/20_builder_code.ts`.

## Examples

21 runnable scripts in [`examples/`](./examples) mirroring the Python SDK's
set, plus the Next.js trading panel. Agents: read [`AGENTS.md`](./AGENTS.md)
first — it carries the invariants and routing rules.

## Development

```bash
pnpm install
pnpm test            # 64 tests incl. golden-vector + EIP-7702 byte parity
pnpm typecheck && pnpm lint
pnpm check:package   # publint + arethetypeswrong
```

Releases go through changesets: `pnpm changeset`, merge, CI publishes.

MIT
