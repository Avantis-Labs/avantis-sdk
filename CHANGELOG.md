# veranta-sdk

## 0.3.0

### Minor Changes

- `compute.netPnl` and `compute.positionNetPnl` charge the close fee on the leveraged position by default, as the contract does. The previous behaviour, the web app's estimate that adds the gross PnL to the fee base, is available with `closeFeeBase: "notional_plus_pnl"`. Net PnL figures move by the gross PnL times the close fee rate.

### Patch Changes

- `compute.pairCloseMakerTakerFeeP` clamps the closed coin size to the closing side's open interest before blending the maker and taker rates, matching `PairStorageExtension.pairCloseFeeP` on chain.

## 0.2.1

### Patch Changes

- `new Veranta({ fetch })` accepts a custom fetch function that is used for every HTTP call the SDK makes: route requests through a proxy, add headers for a private gateway, or record requests in tests.
- `markets.spread()` sends `leverage10` when a leverage is given, so the risk engine can apply the pair's leverage-tiered spread cap instead of the flat cap.
- Testnet defaults move to the Veranta domain: RPC `https://devnet-rpc.veranta.xyz` (websocket `wss://devnet-wsrpc.veranta.xyz`) and explorer `https://devnet-explorer.veranta.xyz`. Explicit `rpcUrl` overrides keep working.

## 0.2.0

### Minor Changes

- 5158525: - New `veranta-sdk/kms` entry point (Node only, optional peer
  `@aws-sdk/client-kms`): `KmsSigner` / `kmsAccount` sign EIP-712 intents,
  EIP-1559 transactions and EIP-7702 authorizations with an AWS KMS key, the
  Python SDK's `KmsSigner` twin. `examples/22_kms_signer.ts` shows the flow.
  - Builder codes: refuse builder-fee orders on signers that cannot sign
    EIP-7702 authorizations (browser wallets without a session key) instead of
    silently relaying a fee-less wallet transaction; new `useApproveBuilderFees`
    and `useBuilderFeeAllowance` React hooks; builder-code unit suite
    (`tests/builderCodes.test.ts`) mirroring the Python SDK's; README /
    AGENTS.md / llms.txt builder-code documentation.
- ca93c7a: Initial release: isomorphic viem core with full Python SDK parity (trading,
  account, markets, info, referral, LP, compute, streams, MM fast path) and
  `veranta-sdk/react` hooks (provider, live prices, positions, trading
  mutations with SSE lifecycle, one-click-trading session keys,
  permit-gasless approvals).
- 5158525: Avantis is now Veranta. Package `avantis-sdk` -> `veranta-sdk` (entry points
  `veranta-sdk`, `veranta-sdk/react`, `veranta-sdk/kms`); `Avantis` ->
  `Veranta`, `AvantisSigner` -> `VerantaSigner`, `AvantisProvider` ->
  `VerantaProvider`, `useAvantis` -> `useVeranta`, `avantisKeys` ->
  `verantaKeys`, `AvantisError` -> `VerantaError`; env vars `AVANTIS_*` ->
  `VERANTA_*` (old names still read with a console warning); default service
  hosts `*.avantisfi.com` -> `*.veranta.xyz` (the testnet RPC and explorer stay on
  `avantisfi.com` for now); DelegateReq intents carry the
  Veranta Terms-of-Service text (contracts accept both). The EIP-712 domain name
  stays `AvantisTrading` (on-chain constant).

## 0.1.0

Initial release: full-parity TypeScript port of the Python
veranta-sdk.

- Isomorphic core (`veranta-sdk`): trade / account / markets / info /
  referral / lp namespaces, compute math, price + order streams, local
  intent builder (MM fast path).
- Signing: EIP-712 intents with a mandatory digest assert; 17 intent kinds
  proven by the shared golden-vector suite; EIP-7702 (Gelato ERC-7821)
  encoder byte-identical to @gelatocloud/gasless.
- Execution: batched-market SSE with tracking-id replay, blitz relayer,
  core price-triggers, twap-app, direct RPC, capability-aware wallet
  fallback for browser signers.
- React (`veranta-sdk/react`): VerantaProvider, live price hook (shared
  Lazer SSE running in a Web Worker by default, main-thread fallback),
  positions/history/allowance queries, trading mutations with lifecycle
  events, `useSessionKey` one-click trading, permit-gasless USDC
  approvals, builder-code hooks.
- Testnet: `fundTestnetWallet` dev faucet, auto-defaulted fork RPC,
  zero-setup quickstart (examples/00) and a live e2e suite
  (`pnpm test:e2e`) covering approve -> open -> TP -> close on staging.
