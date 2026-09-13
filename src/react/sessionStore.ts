/**
 * Session-key (1CT) storage: a local delegate key per (network, trader),
 * persisted in localStorage like the Avantis UI's one-click-trading store.
 *
 * The key never leaves the browser; it is registered on-chain as a trading
 * delegate (`setDelegateWithSig`) and can only trade — it cannot withdraw
 * or transfer funds, and the trader can revoke it at any time.
 */

import { useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AvantisSigner } from "../signing/signer.js";
import { toSigner } from "../signing/signer.js";

export interface SessionKeyRecord {
  privateKey: Hex;
  address: Address;
  trader: Address;
  /** Absolute unix seconds. */
  expiry: number;
  /** False until the on-chain registration is confirmed. */
  registered: boolean;
}

const listeners = new Set<() => void>();
let revision = 0;

function storageKey(network: string, trader: Address): string {
  return `avantis-sdk.session.${network}.${trader.toLowerCase()}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readSessionKey(network: string, trader: Address): SessionKeyRecord | null {
  const raw = storage()?.getItem(storageKey(network, trader));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SessionKeyRecord;
    if (!record.privateKey || !record.registered) return null;
    if (record.expiry && record.expiry * 1000 < Date.now()) return null; // expired
    return record;
  } catch {
    return null;
  }
}

/** Raw record incl. pending (unregistered) keys — for the enable flow. */
export function readSessionKeyRaw(network: string, trader: Address): SessionKeyRecord | null {
  const raw = storage()?.getItem(storageKey(network, trader));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionKeyRecord;
  } catch {
    return null;
  }
}

export function writeSessionKey(network: string, record: SessionKeyRecord): void {
  storage()?.setItem(storageKey(network, record.trader), JSON.stringify(record));
  notify();
}

export function clearSessionKey(network: string, trader: Address): void {
  storage()?.removeItem(storageKey(network, trader));
  notify();
}

export function sessionSignerFromRecord(record: SessionKeyRecord): AvantisSigner {
  return sessionSignerFromKey(record.privateKey);
}

export function sessionSignerFromKey(privateKey: Hex): AvantisSigner {
  return toSigner(privateKeyToAccount(privateKey));
}

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders consumers whenever any session key changes. */
export function useSessionKeyRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
}
