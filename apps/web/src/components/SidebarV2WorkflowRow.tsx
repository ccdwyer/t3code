import type { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AlertTriangleIcon, RefreshCwIcon, SquareKanbanIcon, Trash2Icon } from "lucide-react";
import { memo, useCallback, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import type {
  WorkflowSidebarBoardRow,
  WorkflowSidebarProjectErrorRow,
} from "../workflow/useWorkflowSidebarEntries";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SidebarV2WorkflowBoardRowProps {
  readonly row: WorkflowSidebarBoardRow;
  readonly isActive: boolean;
  readonly onActivate: (input: {
    readonly environmentId: EnvironmentId;
    readonly boardId: BoardId;
  }) => void;
  /**
   * Delete the board. Called only after the user confirms in the dialog.
   * Resolves on success; reject to keep the dialog open with the error path
   * handled by the caller (toast).
   */
  readonly onDelete: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly boardId: BoardId;
    readonly name: string;
  }) => Promise<void>;
}

export interface SidebarV2WorkflowProjectErrorRowProps {
  readonly row: WorkflowSidebarProjectErrorRow;
  readonly onRetry: (projectId: ProjectId) => void;
}

/**
 * Slim workflow board row for Sidebar v2. Navigate on click; hover-reveal
 * delete with a confirmation dialog (mirrors v1 SidebarBoardRow).
 */
export const SidebarV2WorkflowBoardRow = memo(function SidebarV2WorkflowBoardRow(
  props: SidebarV2WorkflowBoardRowProps,
) {
  const { row, isActive, onActivate, onDelete } = props;
  const hasEntryError = row.entryError !== null && row.entryError.length > 0;
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

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

  const openDeleteConfirmation = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await onDelete({
        environmentId: row.environmentId,
        projectId: row.projectId,
        boardId: row.boardId,
        name: row.name,
      });
      setDeleteConfirmOpen(false);
    } catch {
      // Caller toasts; keep the dialog open so the user can retry or cancel.
    } finally {
      setIsDeleting(false);
    }
  }, [onDelete, row.boardId, row.environmentId, row.name, row.projectId]);

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
          "group/v2-workflow-row relative flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 pr-1 text-left outline-none select-none",
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
                  className="inline-flex size-5 shrink-0 items-center justify-center text-destructive"
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
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-testid={`sidebar-v2-workflow-attention-${row.boardId}`}
                  aria-label={row.attentionPill.label}
                  className={cn(
                    "size-3 shrink-0 rounded-full border-2 border-dashed",
                    row.attentionPill.className,
                  )}
                />
              }
            />
            <TooltipPopup side="right">{row.attentionPill.label}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid={`sidebar-v2-workflow-delete-${row.boardId}`}
                aria-label={`Delete workflow ${row.name}`}
                className={cn(
                  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40",
                  // Hover/focus reveal on pointer devices; always available on touch.
                  "opacity-0 pointer-events-none group-hover/v2-workflow-row:pointer-events-auto group-hover/v2-workflow-row:opacity-100 group-focus-within/v2-workflow-row:pointer-events-auto group-focus-within/v2-workflow-row:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100",
                )}
                onClick={openDeleteConfirmation}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="right">Delete workflow</TooltipPopup>
        </Tooltip>
      </div>
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow &ldquo;{row.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the board file, its tickets, and version history for{" "}
              {row.projectTitle}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isDeleting} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isDeleting}
              data-testid={`sidebar-v2-workflow-delete-confirm-${row.boardId}`}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? "Deleting…" : "Delete workflow"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
