import type { WorkflowTicketArtifactKind } from "@t3tools/contracts";

/**
 * Pure rules for the durable ticket-artifact store — spec
 * docs/superpowers/specs/2026-08-05-ticket-artifacts-design.md (v2.5).
 * Everything here is deterministic and IO-free; the store and finalizer
 * consume these so the pinned behaviors have exactly one implementation.
 */

// ─── Units and caps (spec §Units; MiB = 1024 KiB) ────────────────────────────

export const KIB = 1024;
export const MIB = 1024 * KIB;

export const ARTIFACT_FILE_CAPS: Record<WorkflowTicketArtifactKind, number> = {
  markdown: 1 * MIB,
  html: 1 * MIB,
  text: 1 * MIB,
  image: 10 * MIB,
  video: 100 * MIB,
};

export const ARTIFACT_COUNT_CAP_PER_TICKET = 100;
export const ARTIFACT_BYTES_CAP_PER_TICKET = 250 * MIB;

export const ARTIFACT_INLINE_FILE_CAP_BYTES = 64 * KIB;
export const ARTIFACT_INLINE_LIST_BUDGET_BYTES = 512 * KIB;
export const ARTIFACT_READ_CAP_BYTES = 1 * MIB;

export const ARTIFACT_SIDECAR_READ_CAP_BYTES = 8 * KIB;
export const ARTIFACT_CAPTION_MAX_CHARS = 2000;

export const ARTIFACT_NAME_MAX_SEGMENTS = 16;
export const ARTIFACT_NAME_MAX_SCALARS = 512;

// ─── Kind / mime table (spec §Kind/mime; extensions case-insensitive) ────────

interface KindEntry {
  readonly kind: WorkflowTicketArtifactKind;
  readonly mime: string;
}

const KIND_BY_EXTENSION: ReadonlyMap<string, KindEntry> = new Map([
  [".md", { kind: "markdown", mime: "text/markdown; charset=utf-8" }],
  [".markdown", { kind: "markdown", mime: "text/markdown; charset=utf-8" }],
  [".html", { kind: "html", mime: "text/html; charset=utf-8" }],
  [".htm", { kind: "html", mime: "text/html; charset=utf-8" }],
  [".png", { kind: "image", mime: "image/png" }],
  [".svg", { kind: "image", mime: "image/svg+xml" }],
  [".jpg", { kind: "image", mime: "image/jpeg" }],
  [".jpeg", { kind: "image", mime: "image/jpeg" }],
  [".webp", { kind: "image", mime: "image/webp" }],
  [".gif", { kind: "image", mime: "image/gif" }],
  [".mp4", { kind: "video", mime: "video/mp4" }],
  [".webm", { kind: "video", mime: "video/webm" }],
  [".txt", { kind: "text", mime: "text/plain; charset=utf-8" }],
  [".log", { kind: "text", mime: "text/plain; charset=utf-8" }],
  [".diff", { kind: "text", mime: "text/plain; charset=utf-8" }],
  [".patch", { kind: "text", mime: "text/plain; charset=utf-8" }],
  [".json", { kind: "text", mime: "application/json" }],
]);

/** Allowed-extension listing for skip reasons, so agents can self-correct. */
export const ARTIFACT_ALLOWED_EXTENSIONS = [...KIND_BY_EXTENSION.keys()].join(" ");

const extensionOf = (name: string): string => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

/** Unknown extension → null (spec: SKIP with a reason naming allowed exts). */
export const detectArtifactKind = (name: string): KindEntry | null =>
  KIND_BY_EXTENSION.get(extensionOf(name)) ?? null;

/** Kinds whose bytes are UTF-8 decodable for inline/read paths. */
export const isTextLikeKind = (kind: WorkflowTicketArtifactKind): boolean =>
  kind === "markdown" || kind === "text";

/**
 * Active-content class of a served artifact, keyed on MIME alone — the DB row
 * (durable) or the signed claim (scratch) is authoritative, and extensions are
 * never consulted at serve time.
 *
 * SVG is active content: served as `image/svg+xml` at top level, an embedded
 * `<script>` would execute in this origin. Keying on mime rather than kind is
 * what makes that unmissable — an SVG is `kind: "image"`, so a kind-keyed test
 * would silently leave it unsandboxed.
 */
export const activeContentFor = (mime: string): "html" | "svg" | null => {
  // Match the media TYPE exactly, allowing only a parameter tail, so a
  // hypothetical `text/html-ish` cannot inherit the HTML sandbox policy.
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (type === "text/html") return "html";
  if (type === "image/svg+xml") return "svg";
  return null;
};

// ─── Name validation + normalization (spec §Name rules) ──────────────────────

export type ArtifactNameResult =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a scan-relative name and produce the NFC display/DB form. All file
 * IO must keep using the RAW name (macOS NFD); only the normalized form is
 * stored and compared.
 */
export const validateArtifactName = (raw: string): ArtifactNameResult => {
  if (raw.length === 0) return { ok: false, reason: "empty name" };
  if (raw.includes("\u0000")) return { ok: false, reason: "name contains NUL" };
  if (raw.includes("\\")) return { ok: false, reason: "name contains a backslash" };
  if (raw.startsWith("/")) return { ok: false, reason: "absolute names are not allowed" };
  const segments = raw.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "empty path segment" };
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "dot path segments are not allowed" };
  }
  if (segments.length > ARTIFACT_NAME_MAX_SEGMENTS) {
    return {
      ok: false,
      reason: `more than ${String(ARTIFACT_NAME_MAX_SEGMENTS)} path segments`,
    };
  }
  const normalized = raw.normalize("NFC");
  if ([...normalized].length > ARTIFACT_NAME_MAX_SCALARS) {
    return {
      ok: false,
      reason: `name longer than ${String(ARTIFACT_NAME_MAX_SCALARS)} characters`,
    };
  }
  return { ok: true, normalized };
};

/**
 * THE canonical comparator (spec: unsigned UTF-8 byte order — equals SQLite
 * BINARY on NFC text). Used for scan order, collision winners, skip-note
 * order, and list order preservation.
 */
export const compareRawNames = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * Among raw names whose normalized forms collide, the smallest raw name under
 * the canonical comparator wins; the rest are skipped with reasons.
 */
export const collisionWinner = (rawNames: ReadonlyArray<string>): string =>
  [...rawNames].sort(compareRawNames)[0] ?? "";

// ─── Sidecars (spec §Sidecars) ───────────────────────────────────────────────

const SIDECAR_SUFFIX = ".caption.md";

/** Case-insensitive suffix match; sidecar names are RESERVED (never artifacts). */
export const isSidecarName = (name: string): boolean =>
  name.length > SIDECAR_SUFFIX.length && name.toLowerCase().endsWith(SIDECAR_SUFFIX);

/** `report.md.caption.md` → `report.md`; null when not a sidecar. */
export const sidecarBaseName = (name: string): string | null =>
  isSidecarName(name) ? name.slice(0, name.length - SIDECAR_SUFFIX.length) : null;

export const sidecarNameFor = (base: string): string => `${base}${SIDECAR_SUFFIX}`;

const ELLIPSIS = "…";

/**
 * Trim + truncate a caption to ARTIFACT_CAPTION_MAX_CHARS INCLUDING the
 * appended ellipsis, cutting on a code-point boundary. Input is expected to
 * already be U+FFFD-replacement-decoded by the caller.
 */
export const normalizeCaption = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const points = [...trimmed];
  if (points.length <= ARTIFACT_CAPTION_MAX_CHARS) return trimmed;
  return points.slice(0, ARTIFACT_CAPTION_MAX_CHARS - ELLIPSIS.length).join("") + ELLIPSIS;
};

// ─── Identifier gates (spec §Storage model) ──────────────────────────────────

const TICKET_DIR_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** TicketId as a disk-path component — refused unless strictly safe. */
export const isValidTicketDirKey = (ticketId: string): boolean =>
  TICKET_DIR_KEY_PATTERN.test(ticketId);

/** blobId / artifactId before ANY disk operation. */
export const isCanonicalUuid = (id: string): boolean => CANONICAL_UUID_PATTERN.test(id);

// ─── Misc pinned conversions ─────────────────────────────────────────────────

/** The one mtime conversion, used on both sides of the short-circuit compare. */
export const toSourceMtimeMs = (mtimeMs: number): number => Math.floor(mtimeMs);

/** UTF-8 decode with U+FFFD replacement (spec §Text decoding). */
export const decodeUtf8Replacing = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** Byte length of the RETURNED decoded string (budget basis). */
export const decodedByteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Truncate a decoded string to at most `maxBytes` of UTF-8 on a code-point
 * boundary. Returns the slice and whether anything was cut.
 */
export const truncateDecodedToBytes = (
  text: string,
  maxBytes: number,
): { readonly slice: string; readonly truncated: boolean } => {
  if (decodedByteLength(text) <= maxBytes) return { slice: text, truncated: false };
  let bytes = 0;
  let out = "";
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes) break;
    bytes += pointBytes;
    out += point;
  }
  return { slice: out, truncated: true };
};
