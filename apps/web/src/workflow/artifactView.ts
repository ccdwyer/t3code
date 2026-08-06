import type {
  WorkflowTicketArtifactKind,
  WorkflowTicketArtifactView,
  WorkflowTicketArtifactsResult,
  WorkflowTicketScratchKind,
} from "@t3tools/contracts";

/**
 * Pure view-model helpers for the rebuilt TicketArtifacts panel
 * (spec: 2026-08-05-ticket-artifacts-design, plan task B2).
 *
 * Everything here is renderer-agnostic logic the component leans on:
 * which viewer a kind gets, whether a row needs an on-demand
 * `readTicketArtifact` fetch when expanded, and byte formatting. The
 * component owns all React state; these helpers stay node-testable.
 */

/** Which viewer widget an artifact row expands into. */
export type ArtifactRenderer =
  | "markdown" // rendered ChatMarkdown with a Raw toggle
  | "text" // collapsed <pre>
  | "html-link" // "Open in browser" anchor, never inlined
  | "image" // lazy bounded thumbnail + caption
  | "video"; // <video controls preload="metadata"> + caption

export const rendererForKind = (kind: WorkflowTicketArtifactKind): ArtifactRenderer => {
  switch (kind) {
    case "markdown":
      return "markdown";
    case "text":
      return "text";
    case "html":
      return "html-link";
    case "image":
      return "image";
    case "video":
      return "video";
  }
};

/**
 * Which viewer widget a SCRATCH row expands into (spec
 * 2026-08-06-scratch-artifact-viewer §E). Deliberately a separate union from
 * `ArtifactRenderer`: scratch adds `binary`, and widening the durable one
 * would silently lose exhaustiveness on the durable kind.
 */
export type ScratchRenderer = ArtifactRenderer | "binary";

export const scratchRendererForKind = (kind: WorkflowTicketScratchKind): ScratchRenderer => {
  switch (kind) {
    case "markdown":
      return "markdown";
    case "text":
      return "text";
    case "html":
      return "html-link";
    case "image":
      return "image";
    case "video":
      return "video";
    case "binary":
      return "binary";
  }
};

/** True when the row's viewer cannot draw anything without a signed `url`. */
export const scratchNeedsUrl = (kind: WorkflowTicketScratchKind): boolean => {
  const renderer = scratchRendererForKind(kind);
  return renderer === "html-link" || renderer === "image" || renderer === "video";
};

/**
 * True when the row gets a `<details>` body at all. `html-link` renders its
 * anchor inline (matching the durable row) and `binary` has nothing to show.
 */
export const scratchIsExpandable = (kind: WorkflowTicketScratchKind): boolean => {
  const renderer = scratchRendererForKind(kind);
  return renderer !== "html-link" && renderer !== "binary";
};

/**
 * How a row's textual content should be sourced when the row expands.
 * The three server flags are orthogonal; precedence here is:
 * unavailable ▸ non-text kind ▸ omitted/truncated (fetch) ▸ inline.
 */
export type ArtifactContentState =
  | { readonly status: "unavailable" }
  /** Non-text kinds (html/image/video) never carry inline content. */
  | { readonly status: "none" }
  /** Complete decoded content arrived inline with the list. */
  | { readonly status: "inline"; readonly content: string }
  /**
   * Expand must call `readTicketArtifact`. `preview` is the truncated
   * slice (when the server sent one) to show while the fetch runs.
   */
  | { readonly status: "needs-fetch"; readonly preview: string | undefined };

export const contentStateFor = (view: WorkflowTicketArtifactView): ArtifactContentState => {
  if (view.contentUnavailable === true) {
    return { status: "unavailable" };
  }
  const renderer = rendererForKind(view.kind);
  if (renderer !== "markdown" && renderer !== "text") {
    return { status: "none" };
  }
  if (view.contentOmitted === true || view.contentTruncated === true) {
    return { status: "needs-fetch", preview: view.content };
  }
  if (view.content !== undefined) {
    return { status: "inline", content: view.content };
  }
  // No content and no flags — defensive: treat as fetch-on-expand rather
  // than rendering an empty document.
  return { status: "needs-fetch", preview: undefined };
};

/** True when expanding the row must issue a `readTicketArtifact` call. */
export const needsFetchOnExpand = (view: WorkflowTicketArtifactView): boolean =>
  contentStateFor(view).status === "needs-fetch";

/**
 * The server returns rows in canonical (BINARY-collated name) order and
 * the client must preserve it. This helper is the single place the list
 * passes through — it deliberately returns the array untouched so no
 * call site is tempted to re-sort.
 */
export const artifactsInServerOrder = (
  result: WorkflowTicketArtifactsResult,
): ReadonlyArray<WorkflowTicketArtifactView> => result.artifacts;

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Spec units: KiB = 1024 B, MiB = 1024 KiB. One decimal under 10 units. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < KIB) return `${String(Math.round(bytes))} B`;
  const format = (value: number, unit: string): string => {
    const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
    return `${String(rounded)} ${unit}`;
  };
  if (bytes < MIB) return format(bytes / KIB, "KiB");
  if (bytes < GIB) return format(bytes / MIB, "MiB");
  return format(bytes / GIB, "GiB");
};
