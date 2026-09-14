---
"veranta-sdk": minor
---

- New `veranta-sdk/kms` entry point (Node only, optional peer
  `@aws-sdk/client-kms`): `KmsSigner` / `kmsAccount` sign EIP-712 intents,
  EIP-1559 transactions and EIP-7702 authorizations with an AWS KMS key, the
  Python SDK's `KmsSigner` twin. `examples/22_kms_signer.ts` shows the flow.
- Builder codes: refuse builder-fee orders on signers that cannot sign
  EIP-7702 authorizations (browser wallets without a session key) instead of
  silently relaying a fee-less wallet transaction; new `useApproveBuilderFees`
  and `useBuilderFeeAllowance` React hooks; builder-code unit suite
  (`tests/builderCodes.test.ts`) mirroring the Python SDK's; README /
  AGENTS.md / llms.txt builder-code documentation.
