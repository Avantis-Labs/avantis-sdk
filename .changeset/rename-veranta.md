---
"veranta-sdk": minor
---

Avantis is now Veranta. Package `avantis-sdk` -> `veranta-sdk` (entry points
`veranta-sdk`, `veranta-sdk/react`, `veranta-sdk/kms`); `Avantis` ->
`Veranta`, `AvantisSigner` -> `VerantaSigner`, `AvantisProvider` ->
`VerantaProvider`, `useAvantis` -> `useVeranta`, `avantisKeys` ->
`verantaKeys`, `AvantisError` -> `VerantaError`; env vars `AVANTIS_*` ->
`VERANTA_*` (old names still read with a console warning); default service
hosts `*.avantisfi.com` -> `*.veranta.xyz` (the testnet RPC and explorer stay on
`avantisfi.com` for now); DelegateReq intents carry the
Veranta Terms-of-Service text (contracts accept both). The EIP-712 domain name
stays `AvantisTrading` (on-chain constant).
