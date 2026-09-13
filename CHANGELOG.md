# avantis-sdk

## 0.1.0

Initial release: full-parity TypeScript port of the Python
avantis-trader-sdk.

- Isomorphic core (`avantis-sdk`): trade / account / markets / info /
  referral / lp namespaces, compute math, price + order streams, local
  intent builder (MM fast path).
- Signing: EIP-712 intents with a mandatory digest assert; 17 intent kinds
  proven by the shared golden-vector suite; EIP-7702 (Gelato ERC-7821)
  encoder byte-identical to @gelatocloud/gasless.
- Execution: batched-market SSE with tracking-id replay, blitz relayer,
  core price-triggers, twap-app, direct RPC, capability-aware wallet
  fallback for browser signers.
- React (`avantis-sdk/react`): AvantisProvider, live price hook (shared
  Lazer SSE), positions/history/allowance queries, trading mutations with
  lifecycle events, `useSessionKey` one-click trading, permit-gasless USDC
  approvals, builder-code hooks.
