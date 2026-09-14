import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json (scripts/sync-version.mjs runs on build)", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
