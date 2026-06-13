import type {
  BoardId,
  BoardSnapshot,
  EnvironmentApi,
  WorkflowDefinitionEncoded,
  WorkflowGetBoardVersionResult,
  WorkflowLintError,
} from "@t3tools/contracts";
import { LaneKey, WorkflowDefinition } from "@t3tools/contracts";
import { formatSchemaError } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { FlaskConicalIcon, HistoryIcon, SaveIcon, Undo2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  addLane,
  createWorkflowEditorModel,
  discardWorkflowChanges,
  formatVersionTime,
  lintErrorKey,
  loadRevertedDefinition,
  markWorkflowSavedIfUnchanged,
  normalizeSelection,
  setWorkflowLintErrors,
  type WorkflowEditorModel,
  type WorkflowEditorSelection,
} from "~/workflow/editorModel";

import { DryRunPanel } from "./DryRunPanel";
import { LaneForm } from "./LaneForm";
import { LaneList } from "./LaneList";
import { SourcesSection } from "./SourcesSection";
import { CanvasView } from "./canvas/CanvasView";
import { VersionHistoryPanel } from "./history/VersionHistoryPanel";

export type WorkflowLaneEncoded = WorkflowDefinitionEncoded["lanes"][number];
export type WorkflowStepEncoded = NonNullable<WorkflowLaneEncoded["pipeline"]>[number];
export type WorkflowEditorViewMode = "canvas" | "form";
export type WorkflowEditorSelectionMutation = (
  selection: WorkflowEditorSelection | null,
) => WorkflowEditorSelection | null;
export type WorkflowEditorMutation = (
  mutate: (model: WorkflowEditorModel) => WorkflowEditorModel,
  mutateSelection?: WorkflowEditorSelectionMutation,
) => void;

export interface WorkflowEditorProps {
  readonly api: EnvironmentApi;
  readonly boardId: BoardId;
  readonly onClose?: (() => void) | undefined;
  readonly onSaved?: ((snapshot: BoardSnapshot) => void) | undefined;
}

export const lintErrorMatchesLane = (lintError: WorkflowLintError, laneKey: string): boolean =>
  String(lintError.laneKey ?? "") === laneKey;

export const lintErrorMatchesStep = (
  lintError: WorkflowLintError,
  laneKey: string,
  stepKey: string,
): boolean =>
  lintErrorMatchesLane(lintError, laneKey) && String(lintError.stepKey ?? "") === stepKey;

export const lintErrorMatchesTransition = (
  lintError: WorkflowLintError,
  laneKey: string,
  transitionIndex: number,
): boolean =>
  lintErrorMatchesLane(lintError, laneKey) && lintError.transitionIndex === transitionIndex;

const decodeWorkflowDefinitionForSave = Schema.decodeUnknownExit(WorkflowDefinition);

export function WorkflowEditor({ api, boardId, onClose, onSaved }: WorkflowEditorProps) {
  const getBoardDefinition = api.workflow.getBoardDefinition;
  const mountedRef = useRef(false);
  const currentBoardIdRef = useRef(boardId);
  const [model, setModel] = useState<WorkflowEditorModel | null>(null);
  const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);
  const [viewMode, setViewMode] = useState<WorkflowEditorViewMode>("canvas");
  const [versionHash, setVersionHash] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{
    readonly message: string;
    readonly conflictVersionHash?: string;
  } | null>(null);
  const [clientValidationErrors, setClientValidationErrors] = useState<ReadonlyArray<string>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [pendingRevert, setPendingRevert] = useState<{
    readonly versionId: number;
    readonly createdAt: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  currentBoardIdRef.current = boardId;

  const isCurrentBoardRequest = useCallback(
    (requestBoardId: BoardId) => mountedRef.current && currentBoardIdRef.current === requestBoardId,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadBoardDefinition = useCallback(
    (isActive: () => boolean = () => true) => {
      setModel(null);
      setVersionHash(null);
      setLoadingError(null);
      setSaveError(null);
      setClientValidationErrors([]);
      setPendingRevert(null);
      setSelection(null);
      setSaving(false);

      void getBoardDefinition({ boardId })
        .then((result) => {
          if (!isActive()) {
            return;
          }
          setModel(createWorkflowEditorModel(result.definition));
          setVersionHash(result.versionHash);
          setSelection(getDefaultSelection(result.definition));
        })
        .catch((error: unknown) => {
          if (!isActive()) {
            return;
          }
          setLoadingError(error instanceof Error ? error.message : String(error));
        });
    },
    [boardId, getBoardDefinition],
  );

  useEffect(() => {
    let active = true;
    loadBoardDefinition(() => active);

    return () => {
      active = false;
    };
  }, [loadBoardDefinition]);

  const selectedLane = useMemo(() => {
    if (!model) {
      return null;
    }
    return (
      model.definition.lanes.find((lane) => String(lane.key) === selection?.laneKey) ??
      model.definition.lanes[0] ??
      null
    );
  }, [model, selection]);

  const mutateModel: WorkflowEditorMutation = (mutate, mutateSelection) => {
    setClientValidationErrors([]);
    setModel((current) => {
      if (!current) {
        return current;
      }
      const next = mutate(current);
      setSelection((currentSelection) =>
        normalizeSelection(
          next,
          mutateSelection ? mutateSelection(currentSelection) : currentSelection,
        ),
      );
      return next;
    });
  };

  const boardLintErrors =
    model?.lintErrors.filter((lintError) => lintError.laneKey === undefined) ?? [];

  const handleDiscard = () => {
    setSaveError(null);
    setClientValidationErrors([]);
    setPendingRevert(null);
    setModel((current) => {
      if (!current) {
        return current;
      }
      const next = discardWorkflowChanges(current);
      setSelection(getDefaultSelection(next.definition));
      return next;
    });
  };

  const handleRevertVersion = (version: WorkflowGetBoardVersionResult) => {
    const requestBoardId = boardId;
    if (!isCurrentBoardRequest(requestBoardId)) {
      return;
    }

    setSaveError(null);
    setClientValidationErrors([]);
    setModel((current) => {
      if (!isCurrentBoardRequest(requestBoardId)) {
        return current;
      }
      if (!current) {
        return current;
      }
      if (current.dirty) {
        setSaveError({ message: "Save or discard changes before reverting." });
        return current;
      }
      const next = loadRevertedDefinition(current, version.definition);
      setPendingRevert({ versionId: version.versionId, createdAt: version.createdAt });
      setHistoryOpen(false);
      setSelection(getDefaultSelection(next.definition));
      return next;
    });
  };

  const handleSave = async () => {
    if (!model || saving) {
      return;
    }

    setSaveError(null);
    const submittedDefinition = model.definition;
    const validationErrors = validateWorkflowDefinitionForSave(submittedDefinition);
    if (validationErrors.length > 0) {
      setClientValidationErrors(validationErrors);
      return;
    }

    setClientValidationErrors([]);
    const requestBoardId = boardId;
    const submittedSource = model.pendingSaveSource;
    setSaving(true);
    try {
      const result = await api.workflow.saveBoardDefinition({
        boardId: requestBoardId,
        definition: submittedDefinition,
        expectedVersionHash: versionHash ?? "",
        ...(submittedSource === undefined ? {} : { source: submittedSource }),
      });

      if (!isCurrentBoardRequest(requestBoardId)) {
        return;
      }

      if (!result.ok) {
        setClientValidationErrors([]);
        if ("lintErrors" in result) {
          setModel((current) =>
            current ? setWorkflowLintErrors(current, result.lintErrors) : current,
          );
          return;
        }
        if ("conflict" in result) {
          setSaveError({
            message: "This board changed elsewhere. Reload to review the latest version.",
            conflictVersionHash: result.currentVersionHash,
          });
          return;
        }
        return;
      }

      setModel((current) => {
        const next = current
          ? markWorkflowSavedIfUnchanged(current, submittedDefinition, result.definition)
          : createWorkflowEditorModel(result.definition);
        setSelection(
          (currentSelection) =>
            normalizeSelection(next, currentSelection) ?? getDefaultSelection(next.definition),
        );
        return next;
      });
      setVersionHash(result.versionHash);
      setSaveError(null);
      setPendingRevert(null);
      onSaved?.(result.snapshot);
    } catch (error: unknown) {
      if (!isCurrentBoardRequest(requestBoardId)) {
        return;
      }
      setSaveError({ message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (isCurrentBoardRequest(requestBoardId)) {
        setSaving(false);
      }
    }
  };

  if (loadingError) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-background" aria-label="Workflow editor">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Workflow editor</h2>
          {onClose ? (
            <Button size="icon-sm" variant="ghost" aria-label="Close editor" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </header>
        <div className="p-4 text-sm text-destructive">{loadingError}</div>
      </aside>
    );
  }

  if (!model) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-background" aria-label="Workflow editor">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Workflow editor</h2>
          {onClose ? (
            <Button size="icon-sm" variant="ghost" aria-label="Close editor" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </header>
        <div className="p-4 text-sm text-muted-foreground">Loading workflow...</div>
      </aside>
    );
  }

  const revertDisabledReason = model.dirty
    ? "Save or discard changes before reverting."
    : undefined;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-background" aria-label="Workflow editor">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {model.definition.name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {model.dirty ? (
              <span className="font-medium text-warning">Unsaved changes</span>
            ) : (
              <span>Saved</span>
            )}
            {versionHash ? <span>Version {versionHash}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div
            role="group"
            aria-label="Workflow editor view"
            className="flex rounded-lg border border-border bg-muted/30 p-0.5"
          >
            <Button
              size="sm"
              variant={viewMode === "canvas" ? "secondary" : "ghost"}
              aria-pressed={viewMode === "canvas"}
              onClick={() => setViewMode("canvas")}
            >
              Canvas
            </Button>
            <Button
              size="sm"
              variant={viewMode === "form" ? "secondary" : "ghost"}
              aria-pressed={viewMode === "form"}
              onClick={() => setViewMode("form")}
            >
              Form
            </Button>
          </div>
          <Button
            size="sm"
            variant={dryRunOpen ? "secondary" : "outline"}
            onClick={() => setDryRunOpen((open) => !open)}
          >
            <FlaskConicalIcon className="size-4" />
            Dry run
          </Button>
          <Button
            size="sm"
            variant={historyOpen ? "secondary" : "outline"}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <HistoryIcon className="size-4" />
            History
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!model.dirty || saving}
            onClick={handleDiscard}
          >
            <Undo2Icon className="size-4" />
            Discard
          </Button>
          <Button size="sm" disabled={!model.dirty || saving} onClick={() => void handleSave()}>
            <SaveIcon className="size-4" />
            {saving ? "Saving..." : "Save workflow"}
          </Button>
          {onClose ? (
            <Button size="icon-sm" variant="ghost" aria-label="Close editor" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>
      {pendingRevert ? (
        <div className="border-b border-border bg-warning/8 px-4 py-2 text-sm text-warning-foreground">
          Reverting to v{pendingRevert.versionId} ({formatVersionTime(pendingRevert.createdAt)}) -
          review and Save to apply.
        </div>
      ) : null}
      {dryRunOpen ? (
        <DryRunPanel
          definition={model.definition}
          onDryRun={(input) =>
            api.workflow.dryRunBoard({
              definition: model.definition,
              startLane: LaneKey.make(input.startLane),
              scenario: input.scenario,
            })
          }
          onClose={() => setDryRunOpen(false)}
        />
      ) : null}
      {historyOpen ? (
        <VersionHistoryPanel
          api={api}
          boardId={boardId}
          currentDefinition={model.definition}
          disabled={saving || model.dirty}
          revertDisabledReason={revertDisabledReason}
          onClose={() => setHistoryOpen(false)}
          onRevert={handleRevertVersion}
        />
      ) : null}
      {saveError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-destructive/8 px-4 py-2 text-sm text-destructive">
          <span>
            {saveError.message}
            {saveError.conflictVersionHash ? (
              <span className="sr-only"> Current version {saveError.conflictVersionHash}</span>
            ) : null}
          </span>
          {saveError.conflictVersionHash ? (
            <Button size="sm" variant="outline" onClick={() => loadBoardDefinition()}>
              Reload workflow
            </Button>
          ) : null}
        </div>
      ) : null}
      {clientValidationErrors.length > 0 ? (
        <div className="border-b border-border bg-warning/8 px-4 py-2">
          <ul className="space-y-1 text-sm text-warning-foreground">
            {clientValidationErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {boardLintErrors.length > 0 ? (
        <div className="border-b border-border bg-warning/8 px-4 py-2">
          <ul className="space-y-1 text-sm text-warning-foreground">
            {boardLintErrors.map((lintError) => (
              <li key={lintErrorKey(lintError)}>{lintError.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {viewMode === "form" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)] overflow-hidden max-md:grid-cols-1">
          <LaneList
            lanes={model.definition.lanes}
            lintErrors={model.lintErrors}
            selectedLaneKey={selectedLane ? String(selectedLane.key) : null}
            disabled={saving}
            onSelect={(laneKey) => setSelection({ kind: "lane", laneKey })}
            onAdd={() => {
              setModel((current) => {
                if (!current) {
                  return current;
                }
                const next = addLane(current);
                setSelection({
                  kind: "lane",
                  laneKey: String(next.definition.lanes.at(-1)?.key ?? ""),
                });
                return next;
              });
            }}
          />
          <div className="flex min-h-0 flex-col overflow-auto">
            {selectedLane ? (
              <LaneForm
                model={model}
                lane={selectedLane}
                lanes={model.definition.lanes}
                lintErrors={model.lintErrors}
                disabled={saving}
                onSelectLane={(laneKey) => setSelection({ kind: "lane", laneKey })}
                onMutate={mutateModel}
              />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">Add a lane to start editing.</div>
            )}
            <div className="px-4 pb-4">
              <SourcesSection
                definition={model.definition}
                lanes={model.definition.lanes}
                lintErrors={model.lintErrors}
                disabled={saving}
                onMutate={mutateModel}
                listWorkSourceConnections={api.workflow.listWorkSourceConnections}
              />
            </div>
          </div>
        </div>
      ) : (
        <CanvasView
          model={model}
          selection={selection}
          disabled={saving}
          onSelect={setSelection}
          onMutate={mutateModel}
        />
      )}
    </aside>
  );
}

function getDefaultSelection(
  definition: WorkflowDefinitionEncoded,
): WorkflowEditorSelection | null {
  const laneKey =
    definition.lanes.find((lane) => (lane.pipeline?.length ?? 0) > 0)?.key ??
    definition.lanes[0]?.key;
  return laneKey ? { kind: "lane", laneKey: String(laneKey) } : null;
}

function validateWorkflowDefinitionForSave(
  definition: WorkflowDefinitionEncoded,
): ReadonlyArray<string> {
  const result = decodeWorkflowDefinitionForSave(definition, { errors: "all" });
  if (Exit.isSuccess(result)) {
    return [];
  }

  const fieldErrors = collectWorkflowFieldValidationErrors(definition);
  return fieldErrors.length > 0
    ? fieldErrors
    : [`Workflow definition is invalid: ${formatSchemaError(result.cause)}`];
}

function collectWorkflowFieldValidationErrors(
  definition: WorkflowDefinitionEncoded,
): ReadonlyArray<string> {
  const errors: string[] = [];

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    if (isBlank(lane.name)) {
      errors.push(`Lane "${laneKey}" name is required.`);
    }
    if (lane.wipLimit !== undefined && !Number.isInteger(lane.wipLimit)) {
      errors.push(`Lane "${laneKey}" WIP limit must be a whole number.`);
    }

    for (const step of lane.pipeline ?? []) {
      const stepKey = String(step.key);
      if (step.type === "agent") {
        if (isBlank(step.agent.instance)) {
          errors.push(`Lane "${laneKey}" step "${stepKey}" agent instance is required.`);
        }
        if (isBlank(step.agent.model)) {
          errors.push(`Lane "${laneKey}" step "${stepKey}" agent model is required.`);
        }
        if (typeof step.instruction === "object" && isBlank(step.instruction.file)) {
          errors.push(`Lane "${laneKey}" step "${stepKey}" instruction file is required.`);
        }
      }
      if (step.type === "script" && isBlank(step.run)) {
        errors.push(`Lane "${laneKey}" step "${stepKey}" script command is required.`);
      }
    }
  }

  if (
    definition.settings?.maxConcurrentTickets !== undefined &&
    !Number.isInteger(definition.settings.maxConcurrentTickets)
  ) {
    errors.push("Max concurrent tickets must be a whole number.");
  }

  return errors;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
