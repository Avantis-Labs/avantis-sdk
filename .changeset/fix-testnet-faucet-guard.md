---
"veranta-sdk": patch
---

`fundTestnetWallet` accepts the default `devnet-rpc.veranta.xyz` RPC again. The testnet-only guard still matched `testnet` in the URL after the default moved to the `devnet-*` host in 0.2.1, so the faucet, `examples/00_testnet_quickstart.ts` and `pnpm test:e2e` failed with `ConfigError` before sending anything.
