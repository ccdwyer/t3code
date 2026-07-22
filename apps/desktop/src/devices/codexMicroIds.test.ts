import { assert, describe, it } from "@effect/vitest";

import {
  CODEX_MICRO_PLACEHOLDER_PRODUCT_ID,
  CODEX_MICRO_PLACEHOLDER_VENDOR_ID,
  areCodexMicroUsbIdsPlaceholder,
  codexMicroDeviceMatches,
  parseCodexMicroUsbId,
  resolveCodexMicroUsbIds,
} from "./codexMicroIds.ts";

describe("codexMicroIds", () => {
  it("parses hex and decimal id strings", () => {
    assert.strictEqual(parseCodexMicroUsbId("0x1234"), 0x1234);
    assert.strictEqual(parseCodexMicroUsbId("0X1234"), 0x1234);
    assert.strictEqual(parseCodexMicroUsbId("4660"), 4660);
    assert.strictEqual(parseCodexMicroUsbId(" 0xabcd "), 0xabcd);
  });

  it("rejects blank, malformed, and out-of-range ids", () => {
    assert.strictEqual(parseCodexMicroUsbId(undefined), null);
    assert.strictEqual(parseCodexMicroUsbId(null), null);
    assert.strictEqual(parseCodexMicroUsbId(""), null);
    assert.strictEqual(parseCodexMicroUsbId("   "), null);
    assert.strictEqual(parseCodexMicroUsbId("nope"), null);
    assert.strictEqual(parseCodexMicroUsbId("0xzzzz"), null);
    assert.strictEqual(parseCodexMicroUsbId("0x10000"), null); // > 16-bit
    assert.strictEqual(parseCodexMicroUsbId("-5"), null);
  });

  it("falls back to the placeholder when env vars are unset or invalid", () => {
    const resolved = resolveCodexMicroUsbIds({});
    assert.strictEqual(resolved.vendorId, CODEX_MICRO_PLACEHOLDER_VENDOR_ID);
    assert.strictEqual(resolved.productId, CODEX_MICRO_PLACEHOLDER_PRODUCT_ID);
    assert.isTrue(areCodexMicroUsbIdsPlaceholder(resolved));

    const invalid = resolveCodexMicroUsbIds({
      T3_CODEX_MICRO_VID: "garbage",
      T3_CODEX_MICRO_PID: "0xZZ",
    });
    assert.isTrue(areCodexMicroUsbIdsPlaceholder(invalid));
  });

  it("honors env overrides in hex or decimal", () => {
    const resolved = resolveCodexMicroUsbIds({
      T3_CODEX_MICRO_VID: "0x1a2b",
      T3_CODEX_MICRO_PID: "43981",
    });
    assert.strictEqual(resolved.vendorId, 0x1a2b);
    assert.strictEqual(resolved.productId, 43981);
    assert.isFalse(areCodexMicroUsbIdsPlaceholder(resolved));
  });

  it("treats a partial override as still-placeholder so it never matches", () => {
    const resolved = resolveCodexMicroUsbIds({ T3_CODEX_MICRO_VID: "0x1234" });
    // productId fell back to 0x0000 → placeholder → must not match anything.
    assert.isTrue(areCodexMicroUsbIdsPlaceholder(resolved));
    assert.isFalse(codexMicroDeviceMatches(resolved, { vendorId: 0x1234, productId: 0x0000 }));
  });

  it("never matches while ids are the placeholder, matches once overridden", () => {
    const placeholder = resolveCodexMicroUsbIds({});
    assert.isFalse(codexMicroDeviceMatches(placeholder, { vendorId: 0x1234, productId: 0x5678 }));

    const real = resolveCodexMicroUsbIds({
      T3_CODEX_MICRO_VID: "0x1234",
      T3_CODEX_MICRO_PID: "0x5678",
    });
    assert.isTrue(codexMicroDeviceMatches(real, { vendorId: 0x1234, productId: 0x5678 }));
    assert.isFalse(codexMicroDeviceMatches(real, { vendorId: 0x1234, productId: 0x0001 }));
  });
});
