/**
 * Logic for rendering closed ```html fences in assistant markdown as sandboxed
 * interactive embeds. The fence content is never sanitized: it only ever runs
 * inside an opaque-origin sandboxed iframe (`allow-scripts` without
 * `allow-same-origin`), so it cannot reach the app's DOM, cookies, or storage.
 */

export const HTML_EMBED_MESSAGE_TYPE = "t3code:html-embed-height";

/**
 * No `allow-same-origin`: srcdoc would otherwise inherit the app origin and the
 * embedded script could remove its own sandbox. Popups may escape the sandbox —
 * equivalent in capability to the bot-authored links chat already renders, and
 * on desktop the window-open handler routes them to the system browser.
 */
export const HTML_EMBED_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

export const HTML_EMBED_MIN_HEIGHT = 120;
export const HTML_EMBED_MAX_HEIGHT = 480;

const FENCE_MARKER_REGEX = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE_REGEX = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Whether the fenced code block spanning [startOffset, endOffset) of `source`
 * has a closing fence. While a message streams, the last fence may still be
 * open (micromark extends the node to end-of-input); we only mount the embed
 * once the fence is closed so the iframe never sees partial HTML.
 */
export function isFenceClosedAt(
  source: string,
  startOffset: number | undefined,
  endOffset: number | undefined,
  isStreaming: boolean,
): boolean {
  if (!isStreaming) return true;
  if (startOffset === undefined || endOffset === undefined) return false;
  const lines = source.slice(startOffset, endOffset).split("\n");
  const openingMarker = lines[0]?.match(FENCE_MARKER_REGEX)?.[1];
  if (!openingMarker) return false;
  for (let index = lines.length - 1; index > 0; index--) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const closingMarker = line.match(CLOSING_FENCE_REGEX)?.[1];
    return (
      closingMarker !== undefined &&
      closingMarker[0] === openingMarker[0] &&
      closingMarker.length >= openingMarker.length
    );
  }
  return false;
}

// Appended (never prepended — content before <!doctype html> would trigger
// quirks mode); the HTML parser hoists trailing content into <body>.
const HTML_EMBED_RESIZE_SCRIPT =
  "<script>(function(){var post=function(){parent.postMessage({type:" +
  JSON.stringify(HTML_EMBED_MESSAGE_TYPE) +
  ',height:document.documentElement.scrollHeight},"*")};' +
  "new ResizeObserver(post).observe(document.documentElement);" +
  'addEventListener("load",post);post()})()</' +
  "script>";

export function buildHtmlEmbedSrcDoc(html: string): string {
  return `${html}\n${HTML_EMBED_RESIZE_SCRIPT}`;
}

const HTML_EMBED_FILE_ATTR_REGEX = /(?:^|\s)(?:file|src)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const HTML_EMBED_FILE_TOKEN_REGEX = /^[\w@][\w@./-]*\.html?$/i;

/**
 * Pulls a workspace file reference out of an ```html fence info string, e.g.
 * ```html file=docs/plan.html (also file="..." / src=... / a bare *.html
 * token). Only consulted when the fence body is empty — a fence with content
 * always renders its own content.
 */
export function extractHtmlEmbedFileRef(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = HTML_EMBED_FILE_ATTR_REGEX.exec(meta);
  const candidate =
    attrMatch?.[1] ??
    attrMatch?.[2] ??
    attrMatch?.[3] ??
    meta.split(/\s+/).find((token) => HTML_EMBED_FILE_TOKEN_REGEX.test(token));
  if (!candidate) return null;
  const normalized = candidate.replace(/^\.\//, "");
  return normalized.length > 0 ? normalized : null;
}

export interface HtmlEmbedHeightMessage {
  readonly type: typeof HTML_EMBED_MESSAGE_TYPE;
  readonly height: number;
}

export function isHtmlEmbedHeightMessage(data: unknown): data is HtmlEmbedHeightMessage {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as { type?: unknown; height?: unknown };
  return (
    candidate.type === HTML_EMBED_MESSAGE_TYPE &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
  );
}

/**
 * The embed's origin is opaque, so `event.origin` is "null" for every embed —
 * identity of the source window is the only trustworthy check.
 */
export function isMessageFromEmbed(
  eventSource: MessageEventSource | null,
  contentWindow: Window | null | undefined,
): boolean {
  return contentWindow != null && eventSource === contentWindow;
}
