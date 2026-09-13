/**
 * Local intent builder parity: building an intent locally from a golden
 * vector's raw message must reproduce the exact on-chain digest, proving
 * schema + domain + value coercion without any tx-builder round-trip.
 */

import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { LocalIntentBuilder, NoncePool, scaleDecimal } from "../src/execution/localIntents.js";
import { REFERRAL_INTENTS } from "../src/signing/schema.js";
import VECTORS from "./vectors/vectors.json";

const DOMAIN = (VECTORS as any).domain as { chainId: number; verifyingContract: Address };
const vectors = (VECTORS as any).vectors as {
  kind: string;
  message: Record<string, unknown>;
  digest: string;
}[];

function builder(): LocalIntentBuilder {
  // The golden-vector suite hashes every kind (incl. referral) under one
  // domain, so point both contracts at it.
  return new LocalIntentBuilder(DOMAIN.chainId, DOMAIN.verifyingContract, {
    referral: DOMAIN.verifyingContract,
  });
}

describe("LocalIntentBuilder", () => {
  it.each(vectors.map((v) => [v.kind, v] as const))(
    "locally built digest matches vector: %s",
    (kind, vector) => {
      const payload = builder().build(kind, vector.message as Record<string, any>);
      expect(payload.digest.toLowerCase()).toBe(vector.digest.toLowerCase());
      expect(payload.primaryType).toBe(kind);
      expect(payload.signerRule).toBe(
        kind === "DelegateReq" ? "trader-only" : "trader-or-delegate",
      );
      // encodedIntent is present for every on-chain kind
      if (kind !== "CancelOffchainOrder") {
        expect(payload.encodedIntent.length).toBeGreaterThan(2);
      }
    },
  );

  it("covers referral kinds under the referral domain", () => {
    expect(REFERRAL_INTENTS.size).toBe(2);
  });

  it("high-level helpers build valid intents", () => {
    const b = builder();
    const trader = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
    const open = b.openTrade({
      trader,
      pairIndex: 0,
      isLong: true,
      collateralUsdc: 100,
      leverage: 10,
      openPrice: 65000.5,
      tp: 70000,
      slippagePercent: 1,
    });
    expect(open.intent).toBe("OpenTradeReq");
    expect(open.message._t.positionSizeUSDC).toBe("100000000");
    expect(open.message._t.openPrice).toBe("650005000000000");
    expect(open.message._t.tp).toBe("700000000000000");
    expect(open.message._slippageP).toBe("10000000000");

    const cancel = b.twapCancel({ trader, twapId: 7 });
    expect(cancel.intent).toBe("TwapCancelReq");
    expect(cancel.message.twapId).toBe("7");
  });
});

describe("scaleDecimal", () => {
  it("scales exactly through decimal strings", () => {
    expect(scaleDecimal("0.0003", 10)).toBe(3_000_000n);
    expect(scaleDecimal(0.0003, 10)).toBe(3_000_000n);
    expect(scaleDecimal(100, 6)).toBe(100_000_000n);
    expect(scaleDecimal("65000.5", 10)).toBe(650_005_000_000_000n);
    expect(scaleDecimal(1e-7, 10)).toBe(1_000n); // "1e-7" scientific notation
    expect(scaleDecimal(-2.5, 10)).toBe(-25_000_000_000n);
    expect(scaleDecimal("0", 10)).toBe(0n);
    expect(scaleDecimal(123n, 6)).toBe(123_000_000n);
  });

  it("truncates toward zero like Python int()", () => {
    expect(scaleDecimal("0.0000001234", 6)).toBe(0n);
    expect(scaleDecimal("1.9999999", 6)).toBe(1_999_999n);
  });
});

describe("NoncePool", () => {
  it("produces unique 256-bit nonces", () => {
    const pool = new NoncePool();
    const a = pool.next();
    const b = pool.next();
    expect(a).not.toBe(b);
    expect(a > 0n).toBe(true);
    expect(a < 2n ** 256n).toBe(true);
  });
});
