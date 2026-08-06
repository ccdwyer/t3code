/**
 * Pure serving rules for ticket-artifact assets — spec
 * docs/superpowers/specs/2026-08-05-ticket-artifacts-design.md §Serving.
 * The Range decision table and header set are pinned; keep this module
 * IO-free so the table is unit-testable in isolation.
 */

export type RangeDecision =
  | { readonly kind: "full" } // 200, whole body (ignore-class or no header)
  | {
      readonly kind: "partial";
      readonly start: number;
      readonly end: number;
      /** True for start-/-suffix forms: the SERVER chose the end, so it may
       *  legally serve a shorter window; explicit start-end is client-bounded
       *  and served exactly (spec range table). */
      readonly openEnded: boolean;
    } // 206
  | { readonly kind: "unsatisfiable" }; // 416 + Content-Range: bytes */<size>

/**
 * Pinned precedence:
 * - no header → full
 * - ignore-class (malformed syntax, unknown units, multi-range) → full 200 —
 *   including against a zero-length file (Content-Length: 0)
 * - valid single `bytes` range (start-end / start- / -suffix): clamp end to
 *   size-1; suffix > size → 206 covering 0..size-1; unsatisfiable
 *   (start ≥ size, -0, end < start, any valid range on an empty file) → 416
 * - If-Range is the CALLER's concern: it is ignored entirely (documented).
 */
export const decideRange = (header: string | undefined, size: number): RangeDecision => {
  if (header === undefined) return { kind: "full" };
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (match === null) return { kind: "full" }; // unknown units / malformed → ignore
  const spec = (match[1] ?? "").trim();
  if (spec.includes(",")) return { kind: "full" }; // multi-range → ignore

  const suffix = /^-(\d+)$/.exec(spec);
  if (suffix !== null) {
    const count = Number(suffix[1]);
    if (count === 0 || size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - count);
    return { kind: "partial", start, end: size - 1, openEnded: true };
  }
  const bounded = /^(\d+)-(\d*)$/.exec(spec);
  if (bounded === null) return { kind: "full" }; // malformed → ignore
  const start = Number(bounded[1]);
  const endRaw = bounded[2] ?? "";
  if (size === 0 || start >= size) return { kind: "unsatisfiable" };
  if (endRaw === "") return { kind: "partial", start, end: size - 1, openEnded: true };
  const end = Number(endRaw);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: Math.min(end, size - 1), openEnded: false };
};

/** Non-ASCII → "_", strip quotes/backslashes/controls, never empty. */
const asciiFallback = (basename: string): string => {
  const cleaned = [...basename]
    .map((point) => {
      const code = point.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return "";
      if (code > 0x7e) return "_";
      if (point === '"' || point === "\\") return "";
      return point;
    })
    .join("");
  return cleaned.length === 0 ? "artifact" : cleaned;
};

/** RFC 8187 attr-char percent encoding for filename*. */
const rfc8187Encode = (value: string): string => {
  const attrChar = /[A-Za-z0-9!#$&+\-.^_`|~]/;
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += attrChar.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

/**
 * Both parameters derive from the BASENAME of the display name — no separator
 * can survive into either form (spec §Content-Disposition).
 */
export const contentDispositionInline = (displayName: string): string => {
  const basename = displayName.slice(displayName.lastIndexOf("/") + 1);
  return `inline; filename="${asciiFallback(basename)}"; filename*=UTF-8''${rfc8187Encode(basename)}`;
};

/**
 * Pinned header set — applied to 200, 206, 416, and HEAD responses alike.
 *
 * The sandbox CSP applies to ACTIVE CONTENT, classified from the response mime
 * by `activeContentFor` (see `workflow/artifactRules.ts`) rather than from the
 * artifact kind — an SVG is `kind: "image"`, so kind-based gating would leave
 * it unsandboxed:
 * - html → `sandbox allow-scripts` (opaque origin, scripts permitted)
 * - svg  → `sandbox` (opaque origin, scripts BLOCKED — an image needs none)
 * `allow-same-origin` is FORBIDDEN forever for both.
 */
export const artifactHeaders = (input: {
  readonly mime: string;
  readonly displayName: string;
  readonly activeContent: "html" | "svg" | null;
}): Record<string, string> => ({
  "Content-Type": input.mime,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
  "Content-Disposition": contentDispositionInline(input.displayName),
  ...(input.activeContent === "html"
    ? { "Content-Security-Policy": "sandbox allow-scripts" }
    : input.activeContent === "svg"
      ? { "Content-Security-Policy": "sandbox" }
      : {}),
});
