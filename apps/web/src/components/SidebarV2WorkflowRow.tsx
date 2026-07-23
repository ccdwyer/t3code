import type { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AlertTriangleIcon, RefreshCwIcon, SquareKanbanIcon } from "lucide-react";
import { memo, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import type {
  WorkflowSidebarBoardRow,
  WorkflowSidebarProjectErrorRow,
} from "../workflow/useWorkflowSidebarEntries";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SidebarV2WorkflowBoardRowProps {
  readonly row: WorkflowSidebarBoardRow;
  readonly isActive: boolean;
  readonly onActivate: (input: {
    readonly environmentId: EnvironmentId;
    readonly boardId: BoardId;
  }) => void;
}

export interface SidebarV2WorkflowProjectErrorRowProps {
  readonly row: WorkflowSidebarProjectErrorRow;
  readonly onRetry: (projectId: ProjectId) => void;
}

/**
 * Slim workflow board row for Sidebar v2. Read-navigate only (no rename/delete
 * in v1). entryError boards are destructive + non-navigable.
 */
export const SidebarV2WorkflowBoardRow = memo(function SidebarV2WorkflowBoardRow(
  props: SidebarV2WorkflowBoardRowProps,
) {
  const { row, isActive, onActivate } = props;
  const hasEntryError = row.entryError !== null && row.entryError.length > 0;

  const activate = useCallback(() => {
    if (hasEntryError) return;
    onActivate({ environmentId: row.environmentId, boardId: row.boardId });
  }, [hasEntryError, onActivate, row.boardId, row.environmentId]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    },
    [activate],
  );

  return (
    <li className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]">
      <div
        role={hasEntryError ? "group" : "button"}
        tabIndex={hasEntryError ? -1 : 0}
        data-testid={`sidebar-v2-workflow-row-${row.boardId}`}
        data-active={isActive ? "true" : "false"}
        data-entry-error={hasEntryError ? "true" : "false"}
        aria-disabled={hasEntryError ? true : undefined}
        className={cn(
          "group/v2-workflow-row relative flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none",
          hasEntryError
            ? "cursor-default text-destructive"
            : isActive
              ? "cursor-pointer bg-sidebar-row-active text-sidebar-foreground dark:inset-ring-1 dark:inset-ring-white/5"
              : "cursor-pointer bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={hasEntryError ? undefined : activate}
        onKeyDown={hasEntryError ? undefined : handleKeyDown}
      >
        <SquareKanbanIcon
          className={cn(
            "size-4 shrink-0",
            hasEntryError
              ? "text-destructive"
              : "text-sidebar-muted-foreground/80 group-hover/v2-workflow-row:text-sidebar-foreground",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span
            className={cn(
              "truncate text-sm font-medium",
              hasEntryError
                ? "text-destructive"
                : isActive
                  ? "text-foreground"
                  : "text-sidebar-foreground/90",
            )}
          >
            {row.name}
          </span>
          <span
            className={cn(
              "truncate text-[11px]",
              hasEntryError ? "text-destructive/80" : "text-sidebar-muted-foreground/70",
            )}
          >
            {row.projectTitle}
          </span>
        </span>
        {hasEntryError ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label="This board's file failed to load"
                  className="ml-auto inline-flex size-5 shrink-0 items-center justify-center text-destructive"
                >
                  <AlertTriangleIcon className="size-3.5" />
                </span>
              }
            />
            <TooltipPopup side="right" className="max-w-72 whitespace-normal leading-tight">
              This board's file failed to load
              {row.entryError ? `: ${row.entryError}` : ""}
            </TooltipPopup>
          </Tooltip>
        ) : row.attentionPill ? (
          <span
            data-testid={`sidebar-v2-workflow-attention-${row.boardId}`}
            className={cn(
              "ml-auto shrink-0 text-[11px] font-medium tabular-nums",
              row.attentionPill.className,
            )}
          >
            {row.attentionPill.label}
          </span>
        ) : null}
      </div>
    </li>
  );
});

/**
 * Project-level query failure row — subdued, retryable. Distinct from a board
 * entryError (decode failure on a discovered board file).
 */
export const SidebarV2WorkflowProjectErrorRow = memo(function SidebarV2WorkflowProjectErrorRow(
  props: SidebarV2WorkflowProjectErrorRowProps,
) {
  const { row, onRetry } = props;
  const handleRetry = useCallback(() => {
    onRetry(row.projectId);
  }, [onRetry, row.projectId]);

  return (
    <li className="list-none">
      <div
        data-testid={`sidebar-v2-workflow-project-error-${row.projectId}`}
        className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sidebar-muted-foreground"
      >
        <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-xs">
          Couldn't load boards for {row.projectTitle}
        </span>
        <button
          type="button"
          data-testid={`sidebar-v2-workflow-project-retry-${row.projectId}`}
          aria-label={`Retry loading boards for ${row.projectTitle}`}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
          onClick={handleRetry}
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>
    </li>
  );
});
