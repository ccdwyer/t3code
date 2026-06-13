import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import type { WorkSourceConnectionView } from "@t3tools/contracts/workSource";
import type { WorkflowDefinitionEncoded, WorkflowLintError } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { lintErrorKey } from "~/workflow/editorModel";
import type { WorkflowEditorMutation, WorkflowLaneEncoded } from "./WorkflowEditor";

// ─── types ───────────────────────────────────────────────────────────────────

type SourceEncoded = NonNullable<WorkflowDefinitionEncoded["sources"]>[number];

type GithubSelectorDraft = {
  owner: string;
  repo: string;
  labels: string;
  assignee: string;
  state: "all" | "open";
};

type AsanaSelectorDraft = {
  projectGid: string;
  // sectionGid and tagGid are not yet implemented server-side; kept out of v1
  includeCompleted: boolean;
};

type SelectorDraft =
  | { provider: "github"; github: GithubSelectorDraft }
  | { provider: "asana"; asana: AsanaSelectorDraft };

interface SourceDraft {
  id: string;
  provider: "github" | "asana";
  connectionRef: string;
  destinationLane: string;
  closedLane: string;
  enabled: boolean;
  syncIntervalSec: string;
  selector: SelectorDraft;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function defaultGithubSelector(): GithubSelectorDraft {
  return { owner: "", repo: "", labels: "", assignee: "", state: "all" };
}

function defaultAsanaSelector(): AsanaSelectorDraft {
  return { projectGid: "", includeCompleted: true };
}

function encodeSelector(draft: SelectorDraft): unknown {
  if (draft.provider === "github") {
    const d = draft.github;
    return {
      owner: d.owner,
      repo: d.repo,
      ...(d.labels.trim() ? { labels: d.labels.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(d.assignee.trim() ? { assignee: d.assignee.trim() } : {}),
      state: d.state,
    };
  }
  const d = draft.asana;
  // sectionGid / tagGid are future enhancements; not included to pass server lint
  return {
    projectGid: d.projectGid,
    includeCompleted: d.includeCompleted,
  };
}

function decodeSelectorDraft(source: SourceEncoded): SelectorDraft {
  const raw = source.selector as Record<string, unknown> | null | undefined;
  if (source.provider === "github") {
    const labelsRaw = Array.isArray(raw?.["labels"]) ? (raw["labels"] as string[]).join(", ") : "";
    return {
      provider: "github",
      github: {
        owner: typeof raw?.["owner"] === "string" ? raw["owner"] : "",
        repo: typeof raw?.["repo"] === "string" ? raw["repo"] : "",
        labels: labelsRaw,
        assignee: typeof raw?.["assignee"] === "string" ? raw["assignee"] : "",
        state: raw?.["state"] === "open" ? "open" : "all",
      },
    };
  }
  return {
    provider: "asana",
    asana: {
      projectGid: typeof raw?.["projectGid"] === "string" ? raw["projectGid"] : "",
      includeCompleted:
        typeof raw?.["includeCompleted"] === "boolean" ? raw["includeCompleted"] : true,
    },
  };
}

function draftToSource(draft: SourceDraft): SourceEncoded {
  return {
    id: draft.id as never,
    provider: draft.provider,
    connectionRef: draft.connectionRef as never,
    selector: encodeSelector(draft.selector),
    destinationLane: draft.destinationLane as never,
    closedLane: draft.closedLane as never,
    enabled: draft.enabled,
    ...(draft.syncIntervalSec.trim()
      ? { syncIntervalSec: Number.parseInt(draft.syncIntervalSec, 10) }
      : {}),
  };
}

function sourceToDraft(source: SourceEncoded): SourceDraft {
  return {
    id: String(source.id),
    provider: source.provider as "github" | "asana",
    connectionRef: String(source.connectionRef),
    destinationLane: String(source.destinationLane),
    closedLane: String(source.closedLane),
    enabled: source.enabled,
    syncIntervalSec: source.syncIntervalSec !== undefined ? String(source.syncIntervalSec) : "",
    selector: decodeSelectorDraft(source),
  };
}

function newSourceDraft(lanes: ReadonlyArray<WorkflowLaneEncoded>): SourceDraft {
  const firstKey = String(lanes[0]?.key ?? "");
  return {
    id: `source-${Date.now()}`,
    provider: "github",
    connectionRef: "",
    destinationLane: firstKey,
    closedLane: firstKey,
    enabled: true,
    syncIntervalSec: "",
    selector: { provider: "github", github: defaultGithubSelector() },
  };
}

// ─── component ───────────────────────────────────────────────────────────────

export interface SourcesSectionProps {
  readonly definition: WorkflowDefinitionEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
  readonly listWorkSourceConnections: (input: Record<string, never>) => Promise<ReadonlyArray<WorkSourceConnectionView>>;
}

export function SourcesSection({
  definition,
  lanes,
  lintErrors,
  disabled = false,
  onMutate,
  listWorkSourceConnections,
}: SourcesSectionProps) {
  const [connections, setConnections] = useState<ReadonlyArray<WorkSourceConnectionView> | null>(
    null,
  );
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState<SourceDraft | null>(null);

  useEffect(() => {
    let active = true;
    setConnections(null);
    setConnectionsError(null);
    listWorkSourceConnections({})
      .then((result) => {
        if (active) setConnections(result);
      })
      .catch((error: unknown) => {
        if (active)
          setConnectionsError(error instanceof Error ? error.message : "Failed to load connections.");
      });
    return () => {
      active = false;
    };
  }, [listWorkSourceConnections]);

  const sources = definition.sources ?? [];

  // Lint errors that mention a source (no laneKey)
  const sourceLintErrors = lintErrors.filter(
    (e) => e.laneKey === undefined && e.stepKey === undefined,
  );

  const handleAdd = () => {
    const draft = newSourceDraft(lanes);
    setDraftSource(draft);
    setEditingSourceId(draft.id);
  };

  const handleEdit = (source: SourceEncoded) => {
    setDraftSource(sourceToDraft(source));
    setEditingSourceId(String(source.id));
  };

  const handleSaveDraft = () => {
    if (!draftSource) return;
    const sourceId = draftSource.id;
    const encoded = draftToSource(draftSource);
    onMutate((model) => {
      const current = model.definition.sources ?? [];
      const existingIndex = current.findIndex((s) => String(s.id) === sourceId);
      const next =
        existingIndex === -1
          ? [...current, encoded]
          : current.map((s, i) => (i === existingIndex ? encoded : s));
      return {
        ...model,
        definition: { ...model.definition, sources: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
    setEditingSourceId(null);
    setDraftSource(null);
  };

  const handleCancelDraft = () => {
    setEditingSourceId(null);
    setDraftSource(null);
  };

  const handleRemove = (sourceId: string) => {
    onMutate((model) => {
      const next = (model.definition.sources ?? []).filter((s) => String(s.id) !== sourceId);
      return {
        ...model,
        definition: { ...model.definition, sources: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
    if (editingSourceId === sourceId) {
      setEditingSourceId(null);
      setDraftSource(null);
    }
  };

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Work Sources</h4>
          <p className="text-xs text-muted-foreground">
            External issue trackers that create tickets automatically.
          </p>
        </div>
        <Button size="xs" variant="outline" disabled={disabled} onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add source
        </Button>
      </div>

      {sourceLintErrors.length > 0 ? (
        <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
          {sourceLintErrors.map((e) => (
            <li key={lintErrorKey(e)}>{e.message}</li>
          ))}
        </ul>
      ) : null}

      {connectionsError ? (
        <p className="text-xs text-destructive">{connectionsError}</p>
      ) : connections === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Loading connections…
        </p>
      ) : null}

      {sources.length === 0 && editingSourceId === null ? (
        <p className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
          No sources configured. Tickets will only be created manually.
        </p>
      ) : (
        <ol className="space-y-3">
          {sources.map((source) => {
            const sourceId = String(source.id);
            const isEditing = editingSourceId === sourceId;
            return (
              <li
                key={sourceId}
                className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3"
              >
                {isEditing && draftSource ? (
                  <SourceForm
                    draft={draftSource}
                    lanes={lanes}
                    connections={connections ?? []}
                    disabled={disabled}
                    onChange={setDraftSource}
                    onSave={handleSaveDraft}
                    onCancel={handleCancelDraft}
                    onRemove={() => handleRemove(sourceId)}
                    isNew={false}
                  />
                ) : (
                  <SourceRow
                    source={source}
                    connections={connections ?? []}
                    disabled={disabled}
                    onEdit={() => handleEdit(source)}
                    onRemove={() => handleRemove(sourceId)}
                  />
                )}
              </li>
            );
          })}
          {editingSourceId !== null &&
          !sources.some((s) => String(s.id) === editingSourceId) &&
          draftSource ? (
            <li className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3">
              <SourceForm
                draft={draftSource}
                lanes={lanes}
                connections={connections ?? []}
                disabled={disabled}
                onChange={setDraftSource}
                onSave={handleSaveDraft}
                onCancel={handleCancelDraft}
                onRemove={null}
                isNew
              />
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

// ─── SourceRow ────────────────────────────────────────────────────────────────

function SourceRow({
  source,
  connections,
  disabled,
  onEdit,
  onRemove,
}: {
  readonly source: SourceEncoded;
  readonly connections: ReadonlyArray<WorkSourceConnectionView>;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const connection = connections.find((c) => c.connectionRef === String(source.connectionRef));
  const connectionLabel = connection?.displayName ?? String(source.connectionRef);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-medium text-foreground">
          {source.provider} — {connectionLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          → {String(source.destinationLane)} · closed: {String(source.closedLane)}
          {!source.enabled ? " · disabled" : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="xs" variant="outline" disabled={disabled} onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="icon-xs"
          variant="destructive-outline"
          disabled={disabled}
          aria-label={`Remove source ${String(source.id)}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── SourceForm ───────────────────────────────────────────────────────────────

function SourceForm({
  draft,
  lanes,
  connections,
  disabled,
  onChange,
  onSave,
  onCancel,
  onRemove,
  isNew,
}: {
  readonly draft: SourceDraft;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly connections: ReadonlyArray<WorkSourceConnectionView>;
  readonly disabled: boolean;
  readonly onChange: (next: SourceDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onRemove: (() => void) | null;
  readonly isNew: boolean;
}) {
  const providerConnections = connections.filter((c) => c.provider === draft.provider);

  const updateGithub = (patch: Partial<GithubSelectorDraft>) => {
    if (draft.selector.provider !== "github") return;
    onChange({
      ...draft,
      selector: { provider: "github", github: { ...draft.selector.github, ...patch } },
    });
  };

  const updateAsana = (patch: Partial<AsanaSelectorDraft>) => {
    if (draft.selector.provider !== "asana") return;
    onChange({
      ...draft,
      selector: { provider: "asana", asana: { ...draft.selector.asana, ...patch } },
    });
  };

  const handleProviderChange = (provider: "github" | "asana") => {
    const selector: SelectorDraft =
      provider === "github"
        ? { provider: "github", github: defaultGithubSelector() }
        : { provider: "asana", asana: defaultAsanaSelector() };
    onChange({ ...draft, provider, connectionRef: "", selector });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {isNew ? "New source" : "Edit source"}
        </span>
        {onRemove ? (
          <Button
            size="icon-xs"
            variant="destructive-outline"
            disabled={disabled}
            aria-label="Remove source"
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {/* Provider */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Provider</span>
        <select
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={draft.provider}
          disabled={disabled}
          onChange={(e) => handleProviderChange(e.currentTarget.value as "github" | "asana")}
        >
          <option value="github">GitHub</option>
          <option value="asana">Asana</option>
        </select>
      </label>

      {/* Connection */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Connection</span>
        <select
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={draft.connectionRef}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, connectionRef: e.currentTarget.value })}
        >
          <option value="">— select connection —</option>
          {providerConnections.map((c) => (
            <option key={c.connectionRef} value={c.connectionRef}>
              {c.displayName}
            </option>
          ))}
        </select>
        {providerConnections.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No {draft.provider} connections. Add one in Settings → Work Sources.
          </p>
        ) : null}
      </label>

      {/* Destination + Closed lanes */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Destination lane</span>
          <select
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={draft.destinationLane}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, destinationLane: e.currentTarget.value })}
          >
            {lanes.map((lane) => (
              <option key={String(lane.key)} value={String(lane.key)}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Closed lane</span>
          <select
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={draft.closedLane}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, closedLane: e.currentTarget.value })}
          >
            {lanes.map((lane) => (
              <option key={String(lane.key)} value={String(lane.key)}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Provider-specific selector */}
      {draft.selector.provider === "github" ? (
        <GithubSelectorFields
          selector={draft.selector.github}
          disabled={disabled}
          onChange={updateGithub}
        />
      ) : (
        <AsanaSelectorFields
          selector={draft.selector.asana}
          disabled={disabled}
          onChange={updateAsana}
        />
      )}

      {/* Sync interval */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Sync interval (seconds, optional)</span>
        <Input
          nativeInput
          type="number"
          min={30}
          value={draft.syncIntervalSec}
          placeholder="Default"
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, syncIntervalSec: e.currentTarget.value })}
        />
      </label>

      {/* Enabled */}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, enabled: e.currentTarget.checked })}
        />
        Enabled
      </label>

      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={disabled} onClick={onSave}>
          {isNew ? "Add source" : "Save source"}
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function GithubSelectorFields({
  selector,
  disabled,
  onChange,
}: {
  readonly selector: GithubSelectorDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<GithubSelectorDraft>) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/5 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        GitHub selector
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Owner *</span>
          <Input
            value={selector.owner}
            disabled={disabled}
            placeholder="octocat"
            onChange={(e) => onChange({ owner: e.currentTarget.value })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Repo *</span>
          <Input
            value={selector.repo}
            disabled={disabled}
            placeholder="my-repo"
            onChange={(e) => onChange({ repo: e.currentTarget.value })}
          />
        </label>
        <label className="grid gap-1 sm:col-span-2">
          <span className="text-xs font-medium text-foreground">Labels (comma-separated)</span>
          <Input
            value={selector.labels}
            disabled={disabled}
            placeholder="bug, enhancement"
            onChange={(e) => onChange({ labels: e.currentTarget.value })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Assignee</span>
          <Input
            value={selector.assignee}
            disabled={disabled}
            placeholder="octocat"
            onChange={(e) => onChange({ assignee: e.currentTarget.value })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">State</span>
          <select
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={selector.state}
            disabled={disabled}
            onChange={(e) => onChange({ state: e.currentTarget.value as "all" | "open" })}
          >
            <option value="all">all</option>
            <option value="open">open</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function AsanaSelectorFields({
  selector,
  disabled,
  onChange,
}: {
  readonly selector: AsanaSelectorDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<AsanaSelectorDraft>) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/5 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Asana selector
      </p>
      <div className="grid gap-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Project GID *</span>
          <Input
            value={selector.projectGid}
            disabled={disabled}
            placeholder="1234567890"
            onChange={(e) => onChange({ projectGid: e.currentTarget.value })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={selector.includeCompleted}
          disabled={disabled}
          onChange={(e) => onChange({ includeCompleted: e.currentTarget.checked })}
        />
        Include completed tasks
      </label>
    </div>
  );
}
