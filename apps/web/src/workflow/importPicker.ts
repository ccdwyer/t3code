import type { ImportableWorkItemView } from "@t3tools/contracts/workSource";

export interface FilterState {
  readonly search: string;
  readonly assignedToMe: boolean;
  readonly hideTasked: boolean;
}

type ViewerMap = Record<string, { id: string; aliases: ReadonlyArray<string> } | null>;

export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

/**
 * Normalize a work-item URL for comparison: lowercase host, drop "www.",
 * query, hash, and any trailing slash. Returns null when the string is not a
 * parseable http(s) URL.
 */
export const normalizeWorkItemUrl = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
};

/**
 * Reduce a work-item URL to a provider-shaped identity so URL *variants* still
 * match the row the provider emitted (e.g. a GitHub /pull/N link vs the
 * /issues/N html_url, an Asana project-scoped permalink vs a task link, query
 * params, trailing slashes). Falls back to null when the URL matches no known
 * provider shape — callers then compare normalized URLs directly.
 */
export const workItemUrlIdentity = (raw: string): string | null => {
  const normalized = normalizeWorkItemUrl(raw);
  if (normalized === null) {
    return null;
  }
  const github = /^github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)$/i.exec(normalized);
  if (github) {
    // GitHub owner/repo are case-insensitive; the issue number is not.
    return `github:${(github[1] ?? "").toLowerCase()}/${(github[2] ?? "").toLowerCase()}#${github[3]}`;
  }
  if (normalized.startsWith("app.asana.com/")) {
    // Asana permalinks come in several generations: /0/<project>/<gid>,
    // /0/<project>/<gid>/f, /1/<workspace>/project/<p>/task/<gid>, and
    // /1/<workspace>/inbox/.../item/<gid>. The task gid is the last long
    // numeric segment (ignoring the trailing "/f" focus marker).
    const segments = normalized.split("/").filter((s) => s !== "" && s !== "f");
    for (let i = segments.length - 1; i >= 1; i -= 1) {
      const segment = segments[i] ?? "";
      if (/^\d{6,}$/.test(segment)) {
        return `asana:${segment}`;
      }
    }
    return null;
  }
  const jira = /^([^/]+)\/browse\/([a-z][a-z0-9_]*-\d+)$/i.exec(normalized);
  if (jira) {
    return `jira:${jira[1]}/${(jira[2] ?? "").toUpperCase()}`;
  }
  return null;
};

/** True when the pasted URL refers to the same work item as the row's URL. */
export const urlMatchesRow = (pasted: string, rowUrl: string): boolean => {
  const pastedIdentity = workItemUrlIdentity(pasted);
  if (pastedIdentity !== null) {
    return pastedIdentity === workItemUrlIdentity(rowUrl);
  }
  const pastedNormalized = normalizeWorkItemUrl(pasted);
  return pastedNormalized !== null && pastedNormalized === normalizeWorkItemUrl(rowUrl);
};

export const selectionKey = (r: Pick<ImportableWorkItemView, "sourceId" | "externalId">): string =>
  `${r.sourceId}:${r.externalId}`;

export const defaultChecked = (r: ImportableWorkItemView): boolean =>
  r.mappedTicketId === null && r.lifecycle === "open";

export const applyPickerFilters = (
  rows: ReadonlyArray<ImportableWorkItemView>,
  f: FilterState,
  viewer: ViewerMap,
): ReadonlyArray<ImportableWorkItemView> => {
  const raw = f.search.trim();
  const url = isUrl(raw) ? raw : null;
  const q = url ? null : raw.toLowerCase();
  return rows.filter((r) => {
    if (f.hideTasked && r.mappedTicketId !== null) return false;
    if (f.assignedToMe) {
      const v = viewer[r.sourceId];
      if (v === null || v === undefined) return false;
      if (!r.assignees.some((a) => v.aliases.includes(a))) return false;
    }
    if (url !== null) return urlMatchesRow(url, r.url);
    if (q !== null && q.length > 0 && !`${r.title} ${r.displayRef}`.toLowerCase().includes(q))
      return false;
    return true;
  });
};

// keys: `${sourceId}:${externalId}` -> { [sourceId]: externalId[] }
// Uses indexOf(":") (first colon) to split, so externalIds containing colons still work
// (sourceId is a UUID with no colon).
export const groupSelectedBySource = (keys: ReadonlySet<string>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const idx = key.indexOf(":");
    if (idx === -1) continue;
    const sourceId = key.slice(0, idx);
    const externalId = key.slice(idx + 1);
    (out[sourceId] ??= []).push(externalId);
  }
  return out;
};
