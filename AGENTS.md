# Avantis TypeScript SDK (`avantis-sdk`) — Agent Rules

## About This SDK
Official TypeScript SDK for Avantis v2 — perpetuals on Base (8453).
viem-based, API-first (HyperLiquid-style): NO ABIs, NO ethers. Payloads come
from the tx-builder API; the SDK signs locally and submits via the Avantis
relayer (default, gasless) or the user's own RPC / wallet. Feature parity
with the Python `avantis-trader-sdk`; examples/ mirror its 01–21 set.

Two entry points, one install:
- `avantis-sdk`        isomorphic core (Node >= 20, browsers, edge)
- `avantis-sdk/react`  wagmi v2 + TanStack Query v5 hooks

## Core Patterns

### Backend / bots (env-driven)
```ts
import { Avantis } from "avantis-sdk";
// env: AVANTIS_PRIVATE_KEY (delegate/API key), AVANTIS_TRADER_ADDRESS
const client = new Avantis();
await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10 });
```

### Frontend (any wagmi wallet stack)
```tsx
<AvantisProvider network="mainnet">…</AvantisProvider>

const open = useMarketOpen();
open.mutate({ pair: "ETH/USD", side: "long", collateral: 100, leverage: 10 });
```
`useSessionKey()` = one-click trading: generates a local delegate key,
trader signs one DelegateReq, everything after signs silently.

### Namespaces (same surface as the Python SDK)
- client.trade    — opens/closes/limits/margin/increase/tpsl/twap/rfq
- client.account  — positions, allowance, delegation, approvals, claims, builder codes
- client.markets  — pair catalog, prices, dynamic spread, candles
- client.info     — history, portfolio, referral stats, vault APY
- client.referral / client.lp — actions (caller-scoped; trader key only)
- compute (export) — pure UI-parity math (PnL, liq, validation)

### Signers (`toSigner` accepts any of)
- 0x private key (backend, session keys)
- viem LocalAccount (mnemonic/KMS adapters)
- viem WalletClient (browser wallets; wagmi's useWalletClient)
- custom AvantisSigner implementation

### Execution routing (src/execution/engine.ts)
Service URLs derive from apiBaseUrl (prod-api/staging-api.avantisfi.com):
/core, /twap, /batched-market, /blitz, /data, /risk/v2.
- relayer mode + market open/close/increase (10 types) -> batched-market
  POST /market/execute-batched with a signed EIP-712 intent + an OPTIONAL
  pre-signed EIP-7702 type-4 tx (sent only when the signer can produce
  authorizations; intent-only is the MM fast path AND the browser-wallet
  path); lifecycle streamed back as SSE (incl. non-terminal AttemptFailed;
  Error payloads carry a machine `code`), replayable via
  GET /tracking-id/{id}/status (src/execution/batchedMarket.ts)
- global TP/SL (UpdateTpSlReq) -> signed intent PUT to the core API
  /price-triggers/global-{tp|sl}-{trader}-{pair}-{index}; same path in
  relayer AND direct mode (no public contract entry point)
- relayer mode + everything else -> type-4 passthrough via blitz
  (src/eip7702/account.ts); browser wallets that cannot sign EIP-7702
  authorizations fall back to a wallet transaction (route "wallet")
- TWAP open/close/cancel -> signed intents POSTed to the twap-app API
- direct mode -> EIP-1559 via rpcUrl (local accounts) or the wallet

## Critical Invariants (do not break)

1. Every signed intent MUST pass the digest assert (src/signing/intents.ts).
   Golden vectors in tests/vectors/vectors.json prove all 17 intent kinds —
   tests/goldenVectors.test.ts and tests/localIntents.test.ts must stay
   green. The vectors are shared verbatim with the Python SDK.
2. EIP-7702 encoding (src/eip7702/account.ts) is byte-for-byte compatible
   with @gelatocloud/gasless — tests/eip7702.test.ts guards this.
3. src/signing/schema.ts mirrors contracts SignatureHelpers.sol verbatim —
   never "normalize" field names (`_t`, `_deadline` vs `trader`, `nonce`).
4. deadline/deadlineMs = MILLISECONDS; delegate expiry = SECONDS
   (EIP-2612 permit deadline = SECONDS).
5. Human units at the API boundary (100 = 100 USDC); send numbers as
   strings (cleanParams does this); use scaleDecimal for exact raw scaling.
6. Referral/approve/claims/LP are msg.sender-scoped: blocked in delegate
   mode (delegatable: false guard in src/api/base.ts).
7. TP/SL update is intent-only in v2; both global and partial TP/SL go
   through core API /price-triggers (ids are `entityId`; partial updates
   mint a NEW entityId, global ids are deterministic and stable).
8. Zero runtime dependencies beyond viem (peer). react/wagmi/query are
   optional peers used only by `avantis-sdk/react`; socket.io-client is an
   optional peer used only by PairDataStream.

## When Modifying
- Keep the core isomorphic: fetch/ReadableStream only, no Node-only APIs
  outside guarded fallbacks (streams/ws.ts).
- Strict TS; JSDoc on all public methods with runnable snippets.
- Add an example for new features; update CHANGELOG.md via `pnpm changeset`.
- Run: pnpm test && pnpm typecheck && pnpm lint && pnpm check:package
