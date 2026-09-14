# veranta-sdk examples

Node scripts (run from the repo root; they import `veranta-sdk` via tsconfig paths):

```bash
export VERANTA_PRIVATE_KEY=0x...      # delegate/API key (or trader key)
export VERANTA_TRADER_ADDRESS=0x...   # your wallet (delegate mode)
export VERANTA_NETWORK=testnet        # use testnet while experimenting

pnpm tsx examples/01_configure_and_meta.ts
pnpm tsx examples/05_open_market_trade.ts
```

| # | file | shows |
|---|------|-------|
| 00 | 00_testnet_quickstart.ts | ZERO-SETUP testnet: faucet-fund a fresh wallet and trade |
| 01 | 01_configure_and_meta.ts | config resolution + /v2/meta bootstrap |
| 02 | 02_markets_info.ts | pair catalog, leverage envelopes, fees |
| 03 | 03_prices_and_spread.ts | live price + risk-engine v2 spread |
| 04 | 04_positions_and_pnl.ts | positions + compute.positionNetPnl |
| 05 | 05_open_market_trade.ts | gasless market open + SSE lifecycle |
| 06 | 06_open_and_close.ts | open, inspect, close |
| 07 | 07_limit_orders.ts | limit/stop-limit place, edit, cancel |
| 08 | 08_tp_sl_and_partial.ts | global TP/SL + partial trigger CRUD |
| 09 | 09_margin_and_increase.ts | margin deposit/withdraw + size increase |
| 10 | 10_twap.ts | TWAP open/list/cancel |
| 11 | 11_delegate_onboarding.ts | register a delegate/API key gaslessly |
| 12 | 12_direct_mode_rpc.ts | direct mode (own RPC, EIP-1559) |
| 13 | 13_mm_fast_path.ts | local intents, zero HTTP on the hot path |
| 14 | 14_lp_vault.ts | LP deposit/withdraw + APY |
| 15 | 15_referral.ts | referral codes (gasless) + stats |
| 16 | 16_portfolio_history.ts | history + portfolio analytics |
| 17 | 17_streams.ts | Lazer SSE prices + Pusher order events |
| 18 | 18_custom_signers.ts | viem accounts, custom VerantaSigner |
| 19 | 19_upside_pairs.ts | Upside (PnL) markets |
| 20 | 20_builder_code.ts | builder codes: register, allow, attach |
| 21 | 21_testnet_mm_open.ts | end-to-end testnet smoke |
| 22 | 22_kms_signer.ts | `KmsSigner` from veranta-sdk/kms (backend only): approvals + MM fast path |

## Next.js app (`next-app/`)

The canonical frontend template: wagmi connect, one-click trading
(session key), USDC approve (permit-gasless), live prices, open/close,
positions, order lifecycle log.

```bash
cd examples/next-app
npm install
npm run dev
```
