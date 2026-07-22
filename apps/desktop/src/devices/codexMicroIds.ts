/**
 * Codex Micro USB identification.
 *
 * ⚠️ PLACEHOLDER IDs — the real USB VID/PID for the Codex Micro pad have NOT
 * been captured yet. D1 (hardware protocol capture) is a human gate that has
 * not run. Until it does, {@link CODEX_MICRO_PLACEHOLDER_VENDOR_ID} /
 * {@link CODEX_MICRO_PLACEHOLDER_PRODUCT_ID} are deliberately `0x0000` — an
 * invalid USB vendor id — so enumeration NEVER matches a real device and the
 * whole smart-feature path stays inert. Capture work needs no rebuild: set the
 * `T3_CODEX_MICRO_VID` / `T3_CODEX_MICRO_PID` environment variables (hex like
 * `0x1234` or decimal) to point the enumerator at the real device.
 */

export const CODEX_MICRO_PLACEHOLDER_VENDOR_ID = 0x0000;
export const CODEX_MICRO_PLACEHOLDER_PRODUCT_ID = 0x0000;

export const CODEX_MICRO_VENDOR_ID_ENV_VAR = "T3_CODEX_MICRO_VID";
export const CODEX_MICRO_PRODUCT_ID_ENV_VAR = "T3_CODEX_MICRO_PID";

export interface CodexMicroUsbIds {
  readonly vendorId: number;
  readonly productId: number;
}

/**
 * Parse a single USB id from an env-var string. Accepts `0x`-prefixed hex or a
 * plain decimal string. Returns `null` for anything that is missing, blank, or
 * not a valid 16-bit unsigned integer so callers can fall back to the
 * placeholder rather than pointing at a bogus device.
 */
export function parseCodexMicroUsbId(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  let value: number;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    value = Number.parseInt(trimmed.slice(2), 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    value = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }

  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    return null;
  }
  return value;
}

/**
 * Resolve the VID/PID the enumerator should match, honoring env overrides and
 * falling back to the (non-matching) placeholders when unset or invalid.
 */
export function resolveCodexMicroUsbIds(
  env: Record<string, string | undefined> = process.env,
): CodexMicroUsbIds {
  return {
    vendorId:
      parseCodexMicroUsbId(env[CODEX_MICRO_VENDOR_ID_ENV_VAR]) ?? CODEX_MICRO_PLACEHOLDER_VENDOR_ID,
    productId:
      parseCodexMicroUsbId(env[CODEX_MICRO_PRODUCT_ID_ENV_VAR]) ??
      CODEX_MICRO_PLACEHOLDER_PRODUCT_ID,
  };
}

/**
 * Whether the resolved ids are still the placeholder. Treated as placeholder if
 * EITHER id is `0x0000`: a real Codex Micro has a non-zero vendor AND product
 * id, and `0x0000` is not a legal USB vendor id, so a partial override (only
 * VID set) must still no-op rather than match every `productId === 0` device.
 */
export function areCodexMicroUsbIdsPlaceholder(ids: CodexMicroUsbIds): boolean {
  return (
    ids.vendorId === CODEX_MICRO_PLACEHOLDER_VENDOR_ID ||
    ids.productId === CODEX_MICRO_PLACEHOLDER_PRODUCT_ID
  );
}

/**
 * Does an enumerated device match the Codex Micro? Always `false` while the ids
 * are the placeholder, so enumeration can run harmlessly with no real device
 * capture in place.
 */
export function codexMicroDeviceMatches(
  ids: CodexMicroUsbIds,
  device: { readonly vendorId: number; readonly productId: number },
): boolean {
  if (areCodexMicroUsbIdsPlaceholder(ids)) {
    return false;
  }
  return device.vendorId === ids.vendorId && device.productId === ids.productId;
}
