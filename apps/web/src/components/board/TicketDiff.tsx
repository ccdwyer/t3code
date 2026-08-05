import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import type { EnvironmentApi, TicketDiff as TicketDiffData, TicketId } from "@t3tools/contracts";
import { isTicketNoWorktreeMessage } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { getRenderablePatch, resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { getTicketDiff } from "~/workflow/boardRpc";

type TicketDiffLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly diff: TicketDiffData }
  | {
      readonly status: "error";
      readonly message: string;
      /** hasStartedWork AT FETCH TIME — classification must use the value the
       *  error was fetched under, or the render between the prop flipping and
       *  the refetch would flash a cached pre-run error as worktree loss. */
      readonly hasStartedWorkAtFetch: boolean;
    };

/**
 * How a diff-load error should render. The no-worktree fragment alone is not
 * enough to call the state benign: a ticket that already ran steps and THEN
 * lost its worktree ref is a real (if quiet) loss, not a fresh ticket.
 */
export type TicketDiffErrorKind = "pre-run" | "worktree-missing" | "failure";

export const classifyTicketDiffError = (
  message: string,
  hasStartedWork: boolean,
): TicketDiffErrorKind => {
  if (!isTicketNoWorktreeMessage(message)) {
    return "failure";
  }
  return hasStartedWork ? "worktree-missing" : "pre-run";
};

export function TicketDiff({
  api,
  ticketId,
  hasStartedWork = false,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: TicketId;
  /** True once the ticket has any step run — flips the no-worktree copy from
   *  "no changes yet" to an honest "worktree no longer attached". */
  readonly hasStartedWork?: boolean | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const [loadState, setLoadState] = useState<TicketDiffLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });

    void getTicketDiff(api, ticketId).then(
      (diff) => {
        if (!cancelled) {
          setLoadState({ status: "loaded", diff });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: errorMessage(error),
            hasStartedWorkAtFetch: hasStartedWork,
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
    // hasStartedWork is a real dependency: when the first step starts while
    // the drawer is open, the cached pre-run "no worktree" error would
    // otherwise be reclassified as worktree loss instead of refetching the
    // diff that now exists.
  }, [api, ticketId, hasStartedWork]);

  if (loadState.status === "loading") {
    return (
      <section className="shrink-0 rounded-md border border-border/70 bg-card/35 p-3 text-sm text-muted-foreground">
        Loading diff...
      </section>
    );
  }

  if (loadState.status === "error") {
    const kind = classifyTicketDiffError(loadState.message, loadState.hasStartedWorkAtFetch);
    // A ticket that hasn't run a step yet has no worktree — that's the normal
    // starting state, not a failure, so render a quiet empty card for it.
    if (kind === "pre-run") {
      return (
        <section
          className="shrink-0 rounded-md border border-border/70 bg-card/35 p-3 text-sm text-muted-foreground"
          data-testid="ticket-diff-no-worktree"
        >
          No changes yet — a worktree is created when the ticket&apos;s first step runs.
        </section>
      );
    }
    // Work happened but the worktree ref is gone (GC'd, moved, projection
    // drift): say so honestly — neither a false "no changes yet" nor a red
    // alarm for what may be routine post-land cleanup.
    if (kind === "worktree-missing") {
      return (
        <section
          className="shrink-0 rounded-md border border-warning/40 bg-warning/8 p-3 text-sm text-warning-foreground"
          data-testid="ticket-diff-worktree-missing"
        >
          This ticket&apos;s worktree is no longer attached — the accumulated diff is unavailable.
        </section>
      );
    }
    return (
      <section className="shrink-0 rounded-md border border-destructive/35 bg-destructive/6 p-3 text-sm text-destructive-foreground">
        {loadState.message}
      </section>
    );
  }

  return <TicketDiffContent diff={loadState.diff} resolvedTheme={resolvedTheme} />;
}

export function TicketDiffContent({
  diff,
  resolvedTheme,
}: {
  readonly diff: TicketDiffData;
  readonly resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = useMemo(
    () => getRenderablePatch(diff.patch, `workflow-ticket:${diff.ticketId}:${resolvedTheme}`),
    [diff.patch, diff.ticketId, resolvedTheme],
  );

  const fileDiffByPath = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    if (renderablePatch === null || renderablePatch.kind !== "files") {
      return map;
    }
    for (const fileDiff of renderablePatch.files) {
      map.set(resolveFileDiffPath(fileDiff), fileDiff);
    }
    return map;
  }, [renderablePatch]);

  const fileCountLabel =
    diff.files.length === 0
      ? "no files"
      : `${diff.files.length} file${diff.files.length === 1 ? "" : "s"}`;

  return (
    // `shrink-0` so a parent flex column scrolls this card rather than crushing
    // it under pinned lane controls. Each changed file is a `<details>` row —
    // collapsed by default — so the board stays calm until the user expands one.
    <section
      className="flex shrink-0 flex-col gap-2 rounded-md border border-border/70 bg-card/35 p-3"
      data-testid="ticket-accumulated-diff"
    >
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Accumulated diff</h3>
          <span className="text-xs text-muted-foreground" data-testid="ticket-diff-file-count">
            {fileCountLabel}
          </span>
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">Base {diff.baseRef}</p>
      </header>
      {diff.truncated ? <p className="text-xs text-warning-foreground">Patch truncated.</p> : null}
      {diff.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No changed files.</p>
      ) : (
        <ul className="space-y-1" data-testid="ticket-diff-file-list">
          {diff.files.map((file) => {
            const fileDiff = fileDiffByPath.get(file.path);
            return (
              <li key={file.path}>
                {/* No `open` attr → collapsed by default. */}
                <details
                  className="rounded-md border border-border/60 bg-background/70"
                  data-testid={`ticket-diff-file-${file.path}`}
                >
                  <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs select-none">
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                    </span>
                  </summary>
                  <div className="border-t border-border/60 p-2">
                    {fileDiff !== undefined ? (
                      <div className="diff-render-surface max-h-80 overflow-auto rounded-md border border-border/70 bg-background/70 p-2">
                        <FileDiff
                          fileDiff={fileDiff}
                          options={{
                            // The row is the expand control; show hunks when open.
                            collapsed: false,
                            diffStyle: "unified",
                            theme: resolveDiffThemeName(resolvedTheme),
                          }}
                        />
                        <span className="sr-only">{resolveFileDiffPath(fileDiff)}</span>
                      </div>
                    ) : renderablePatch?.kind === "raw" ? (
                      <p className="text-xs text-muted-foreground">
                        Per-file hunks unavailable — expand &quot;Full patch&quot; below.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No patch hunks for this file.</p>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {renderablePatch?.kind === "raw" ? (
        <details
          className="rounded-md border border-border/60 bg-background/70"
          data-testid="ticket-diff-raw-patch"
        >
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-foreground select-none">
            Full patch
          </summary>
          <pre className="max-h-80 overflow-auto border-t border-border/60 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
            {renderablePatch.text}
          </pre>
        </details>
      ) : null}
      {renderablePatch === null && diff.files.length > 0 ? (
        <p className="text-xs text-muted-foreground">No patch available.</p>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load ticket diff.";
}
