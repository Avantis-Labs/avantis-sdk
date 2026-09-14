# Veranta TypeScript SDK (`veranta-sdk`) — Agent Rules

## About This SDK
Official TypeScript SDK for Veranta v2 — perpetuals on Base (8453).
viem-based, API-first (HyperLiquid-style): NO ABIs, NO ethers. Payloads come
from the tx-builder API; the SDK signs locally and submits via the Veranta
relayer (default, gasless) or the user's own RPC / wallet. Feature parity
with the Python `veranta-sdk`; examples/ mirror its 00–21 set, plus 22
(AWS KMS backend signer, the twin of the Python KmsSigner example).

Three entry points, one install:
- `veranta-sdk`        isomorphic core (Node >= 20, browsers, edge)
- `veranta-sdk/react`  wagmi v2 + TanStack Query v5 hooks
- `veranta-sdk/kms`    AWS KMS signer (Node only; optional peer
                       @aws-sdk/client-kms) — the Python KmsSigner twin

## Core Patterns

### Backend / bots (env-driven)
```ts
import { Veranta } from "veranta-sdk";
// env: VERANTA_PRIVATE_KEY (delegate/API key), VERANTA_TRADER_ADDRESS
const client = new Veranta();
await client.trade.marketOpen("ETH/USD", "long", { collateral: 100, leverage: 10 });
```

### Frontend (any wagmi wallet stack)
```tsx
<VerantaProvider network="mainnet">…</VerantaProvider>

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
- custom VerantaSigner implementation
- AWS KMS (backend only): `KmsSigner.create({ keyId })` or `kmsAccount()`
  from `veranta-sdk/kms` (src/kms/index.ts): address from the KMS public
  key, every digest signed via KMS `Sign`, low-s + parity recovery,
  EIP-7702 authorizations included. tests/kms.test.ts proves byte-equality
  with a viem private-key account; examples/22_kms_signer.ts is the flow.

### Execution routing (src/execution/engine.ts)
Service URLs derive from apiBaseUrl (prod-api/staging-api.veranta.xyz):
/core, /twap, /batched-market, /blitz, /data, /risk/v2.
- relayer mode + market open/close/increase (10 types) -> batched-market
  POST /market/execute-batched with a signed EIP-712 intent + an OPTIONAL
  pre-signed EIP-7702 type-4 tx (sent only when the signer can produce
  authorizations; intent-only is the MM fast path AND the browser-wallet
  path); lifecycle streamed back as SSE (incl. non-terminal AttemptFailed;
  Error payloads carry a machine `code`), replayable via
  GET /tracking-id/{id}/status (src/execution/batchedMarket.ts)
- relayer mode + builder params (config builderCode + builderFeePercent, or
  a per-order builderFeePercent) on those same market types -> calldata-only
  type-4 passthrough via blitz. The tx-builder appends the fee suffix
  `code || rate || 0x9481c2bc` to the INNER trading calldata and the
  authorization targets /v2/meta addresses.delegationTemplate (canonical
  fee-charging template; an explicit delegationAddress wins). No SSE
  lifecycle. Refused in direct mode and for signers that cannot sign
  EIP-7702 authorizations (a wallet fallback would place the order without
  charging the fee). Upside opens/increases force rate 0 (src/api/trade.ts
  builderParams / submitMarket / requireBuilderCapableSigner).
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
   optional peers used only by `veranta-sdk/react`; socket.io-client is an
   optional peer used only by PairDataStream; @aws-sdk/client-kms is an
   optional peer used only by `veranta-sdk/kms` (never import it from the
   core or react entries).
9. Builder-fee orders must never reach a route that skips the EIP-7702
   template (direct type-2, wallet tx, intent-only): the fee would silently
   not charge. tests/builderCodes.test.ts guards the params, the blitz
   routing, the canonical-template switch and both refusals; keep it green
   alongside the Python suite's tests/test_builder_codes.py.

## Testnet

`network: "testnet"` = internal Base fork (chainId 8453, same contract
addresses; staging service URLs; `rpcUrl` auto-defaults to the public fork
RPC). `fundTestnetWallet(address)` faucet-funds any wallet via the fork's
`dev_impersonateTransaction` (fork-only; refuses non-testnet RPCs). The
zero-setup path is examples/00_testnet_quickstart.ts; the live round-trip
suite is `pnpm test:e2e` (tests/e2e/testnet.e2e.test.ts, gated by
VERANTA_E2E=1 — it covers blitz 7702 approve, batched-market SSE
open/close, and price-triggers TP against staging).

## Live prices in UIs

`usePrice` fans one Lazer SSE stream out of a Web Worker by default
(react/priceWorker.ts spawns it from an inline Blob; in-worker EventSource
reconnects natively). Fallback to the main-thread stream is automatic;
`priceTransport="main"` on VerantaProvider forces it. Keep the worker
source self-contained (no imports) so it needs no bundler support.

## When Modifying
- Keep the core isomorphic: fetch/ReadableStream only, no Node-only APIs
  outside guarded fallbacks (streams/ws.ts). Node-only integrations get
  their own entry point (like `veranta-sdk/kms`).
- Strict TS; JSDoc on all public methods with runnable snippets.
- Add an example for new features; update CHANGELOG.md via `pnpm changeset`.
- Run: pnpm test && pnpm typecheck && pnpm lint && pnpm check:package
