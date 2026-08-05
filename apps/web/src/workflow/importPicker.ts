import type { ImportableWorkItemView } from "@t3tools/contracts/workSource";

export interface FilterState {
  readonly search: string;
  readonly assignedToMe: boolean;
  readonly hideTasked: boolean;
}

type ViewerMap = Record<string, { id: string; aliases: ReadonlyArray<string> } | null>;

export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

const parseHttpUrl = (raw: string): URL | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
};

const normalizedHostPath = (url: URL): string => {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port === "" ? "" : `:${url.port}`;
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${port}${path}`;
};

/**
 * Normalize a work-item URL's provider-shaped part for identity parsing:
 * lowercase host (minus "www."), no hash, no query, no trailing slash.
 * Returns null when the string is not a parseable http(s) URL.
 */
export const normalizeWorkItemUrl = (raw: string): string | null => {
  const url = parseHttpUrl(raw);
  return url === null ? null : normalizedHostPath(url);
};

/**
 * Comparison key for the unknown-host fallback. Unlike identity parsing this
 * KEEPS the query string — for trackers that address items via query params
 * (`/view?id=5` vs `/view?id=6`), dropping it would collapse distinct items
 * into one match.
 */
export const workItemUrlComparisonKey = (raw: string): string | null => {
  const url = parseHttpUrl(raw);
  return url === null ? null : `${normalizedHostPath(url)}${url.search}`;
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
  // A trailing subpath after the number (…/pull/42/files, …/issues/42/timeline)
  // still names the same item — people paste from PR tabs.
  const github = /^github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/|$)/i.exec(normalized);
  if (github) {
    // GitHub owner/repo are case-insensitive; the issue number is not.
    return `github:${(github[1] ?? "").toLowerCase()}/${(github[2] ?? "").toLowerCase()}#${github[3]}`;
  }
  if (normalized.startsWith("app.asana.com/")) {
    // Asana permalinks come in several generations: /0/<project>/<gid>,
    // /0/<project>/<gid>/f, /1/<workspace>/project/<p>/task/<gid>, and
    // /1/<workspace>/inbox/.../item/<gid>. Prefer the segment right after an
    // explicit task/item marker (later segments may be comment or focus ids);
    // otherwise the task gid is the last long numeric segment.
    const segments = normalized.split("/").filter((s) => s !== "" && s !== "f");
    for (const marker of ["task", "item"]) {
      const at = segments.indexOf(marker);
      const candidate = at === -1 ? "" : (segments[at + 1] ?? "");
      if (/^\d{6,}$/.test(candidate)) {
        return `asana:${candidate}`;
      }
    }
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
  const pastedKey = workItemUrlComparisonKey(pasted);
  return pastedKey !== null && pastedKey === workItemUrlComparisonKey(rowUrl);
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
