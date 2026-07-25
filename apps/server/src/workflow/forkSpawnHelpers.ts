/**
 * Pure helpers for fork spawn planning (engine path) — kept pure for focused tests.
 */

export const MAX_FORK_DEPTH = 3;

export const renderForkChildTitle = (
  template: string,
  vars: { readonly ticketTitle: string; readonly ticketId: string; readonly childKey: string },
): string => {
  const raw = template
    .replaceAll("{{ticket.title}}", vars.ticketTitle)
    .replaceAll("{{ticket.id}}", vars.ticketId)
    .replaceAll("{{child.key}}", vars.childKey)
    .slice(0, 200)
    .trim();
  return raw.length > 0 ? raw : `fork:${vars.childKey}`;
};

export const nextForkDepth = (parentDepth: number | undefined): number =>
  Math.max(1, (parentDepth ?? 0) + 1);

export const exceedsForkDepth = (depth: number): boolean => depth > MAX_FORK_DEPTH;
