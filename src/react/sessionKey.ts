/**
 * One-click trading (1CT) session keys: the delegate-onboarding flow from
 * the Veranta UI / delegate UI as a single hook.
 *
 * `enable()` generates a fresh local key, has the TRADER wallet sign one
 * EIP-712 `DelegateReq` (with the ToS text), relays `setDelegateWithSig`
 * gaslessly through blitz (the session key signs the EIP-7702 leg), then
 * polls until the delegation is active. From then on the provider signs
 * every intent with the session key, no wallet popups per order.
 *
 * The key lives in localStorage, scoped to (network, trader). It can only
 * trade on the trader's behalf; it cannot withdraw or transfer funds.
 * `revoke()` removes the on-chain delegation (a trader-wallet transaction)
 * and clears the stored key.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, useWalletClient } from "wagmi";
import { Veranta } from "../client.js";
import { ConfigError } from "../errors.js";
import { toSigner } from "../signing/signer.js";
import { verantaKeys } from "./keys.js";
import { useVerantaContext } from "./provider.js";
import {
  type SessionKeyRecord,
  clearSessionKey,
  readSessionKeyRaw,
  writeSessionKey,
} from "./sessionStore.js";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export type SessionKeyStatus = "none" | "pending" | "active" | "expired";

export interface UseSessionKeyResult {
  /** The session key's address (delegate), if one exists. */
  sessionAddress?: Address;
  status: SessionKeyStatus;
  /** True when trading goes through the session key (no popups). */
  isActive: boolean;
  /** Absolute unix seconds when the delegation expires. */
  expiry?: number;
  enable: (options?: { ttlSeconds?: number }) => void;
  enableAsync: (options?: { ttlSeconds?: number }) => Promise<SessionKeyRecord>;
  isEnabling: boolean;
  enableError: Error | null;
  revoke: () => void;
  isRevoking: boolean;
  /** Forget the stored key WITHOUT revoking on-chain. */
  clear: () => void;
}

export function useSessionKey(): UseSessionKeyResult {
  const { config, readClient } = useVerantaContext();
  const network = readClient.config.network;
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();

  // Storage revision changes re-render the provider tree, so a plain read
  // here stays fresh without memoization.
  const record = address ? readSessionKeyRaw(network, address) : null;

  // Verify on-chain state for stored keys (registration can be revoked
  // elsewhere, e.g. the Veranta UI).
  const statusQuery = useQuery({
    queryKey: verantaKeys.delegation(address, record?.address),
    queryFn: async () => {
      const probe = new Veranta({ ...config, trader: address });
      return await probe.txb.delegation(address!, record!.address);
    },
    enabled: !!address && !!record?.registered,
    refetchInterval: 30_000,
  });

  const status: SessionKeyStatus = (() => {
    if (!record) return "none";
    if (!record.registered) return "pending";
    if (record.expiry && record.expiry * 1000 < Date.now()) return "expired";
    if (statusQuery.data && statusQuery.data.canSignIntents === false) return "expired";
    return "active";
  })();

  const enableMutation = useMutation({
    mutationFn: async (options: { ttlSeconds?: number } = {}): Promise<SessionKeyRecord> => {
      if (!address) throw new ConfigError("Connect a wallet before enabling one-click trading");
      if (!walletClient) throw new ConfigError("Wallet client not ready yet");

      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const expiry = Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS);

      const pending: SessionKeyRecord = {
        privateKey: privateKey as Hex,
        address: account.address,
        trader: address,
        expiry,
        registered: false,
      };
      writeSessionKey(network, pending);

      // The SESSION key relays setDelegateWithSig (it signs the EIP-7702
      // leg; submission is permissionless), the TRADER wallet signs the
      // DelegateReq intent.
      const sessionClient = new Veranta({ ...config, signer: account, trader: address });
      try {
        await sessionClient.account.registerDelegate(
          account.address,
          expiry,
          toSigner(walletClient),
        );
        // Poll until the delegation is live (indexing the relay takes a
        // couple of blocks).
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const delegation = await sessionClient.txb.delegation(address, account.address);
          if (delegation?.canSignIntents) {
            const active = { ...pending, registered: true };
            writeSessionKey(network, active);
            void queryClient.invalidateQueries({ queryKey: verantaKeys.all });
            return active;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new ConfigError(
          "Delegation transaction relayed but not visible yet; retry enable() in a moment",
        );
      } catch (error) {
        clearSessionKey(network, address);
        throw error;
      }
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async () => {
      if (!address || !record) return;
      if (!walletClient) throw new ConfigError("Wallet client not ready yet");
      // removeDelegate is msg.sender-scoped: it must be a trader-wallet
      // transaction (the engine falls back to a wallet tx automatically).
      const walletVeranta = new Veranta({ ...config, signer: walletClient });
      await walletVeranta.account.revokeDelegate(record.address);
      clearSessionKey(network, address);
      void queryClient.invalidateQueries({ queryKey: verantaKeys.all });
    },
  });

  return {
    sessionAddress: record?.address,
    status,
    isActive: status === "active",
    expiry: record?.expiry,
    enable: (options) => enableMutation.mutate(options ?? {}),
    enableAsync: (options) => enableMutation.mutateAsync(options ?? {}),
    isEnabling: enableMutation.isPending,
    enableError: (enableMutation.error as Error) ?? null,
    revoke: () => revokeMutation.mutate(),
    isRevoking: revokeMutation.isPending,
    clear: () => {
      if (address) clearSessionKey(network, address);
    },
  };
}
