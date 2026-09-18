---
"veranta-sdk": patch
---

`fundTestnetWallet` checks the faucet whales' balances before impersonating them and throws `TestnetFaucetError` (exported) with the amounts involved when a whale cannot cover the request, instead of sending a transfer that reverts with a generic `TransactionRevertedError`.
