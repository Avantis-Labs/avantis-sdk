---
"veranta-sdk": patch
---

Base Denim (mainnet 2026-11-05 18:00 UTC: a block every 200 ms, no Flashblocks):

- `waitForReceipt` on the RPC client polls every 250 ms by default (was 1 s); the third argument `pollMs` still overrides it. `useSessionKey().enable()` polls the new delegation every 500 ms (was 2 s).
- The `ExecutionConfirmedInFlashblock` order event is deprecated: Flashblocks are gone, so it is never emitted again. `OrderEventStream` still forwards it should one ever arrive; wait for `OrderFilled` or `OrderCanceled`.
- Docs: the `pending` block tag still works but no longer means preconfirmed (nonce reads are unchanged). A position's whole-second `Trade.timestamp` can now be shared by a close and a reopen of the same slot inside one second, so re-request intents bound to it (`closeTrade`, `closeTradeCoin`, `partialTpSl`) after any same-second change.
