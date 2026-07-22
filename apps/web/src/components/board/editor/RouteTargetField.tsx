import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import {
  PARK_SELECT_VALUES,
  addParkAction,
  parseRouteSelectValue,
  removeParkAction,
  routeTargetSelectValue,
  setRouteTarget,
  setRouteTargetKind,
  updateParkAction,
  updateParkTarget,
  type RouteTargetPath,
  type WorkflowParkTargetEncoded,
  type WorkflowRouteTargetEncoded,
} from "~/workflow/editorModel";

import type { WorkflowEditorMutation, WorkflowLaneEncoded } from "./WorkflowEditor";

const parkOptionLabels = { issue: "Park — issue", waiting: "Park — waiting" } as const;

/**
 * A routing target <select>: bare lane moves plus the two park substates. It
 * only writes the target — callers render {@link ParkTargetFields} beneath the
 * row when the current target is a park so the sub-editor gets full width.
 */
export function RouteTargetSelect({
  ariaLabel,
  lanes,
  target,
  path,
  allowNoRoute = false,
  disabled = false,
  onMutate,
}: {
  readonly ariaLabel: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly target: WorkflowRouteTargetEncoded | undefined;
  readonly path: RouteTargetPath;
  readonly allowNoRoute?: boolean;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
      value={routeTargetSelectValue(target) ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const choice = parseRouteSelectValue(event.currentTarget.value);
        onMutate((current) => {
          if (choice.kind === "park") {
            return setRouteTargetKind(
              current,
              path,
              choice.substate === "issue" ? "park-issue" : "park-waiting",
            );
          }
          return setRouteTarget(
            current,
            path,
            choice.kind === "clear" ? undefined : choice.laneKey,
          );
        });
      }}
    >
      {allowNoRoute ? <option value="">No route</option> : null}
      {lanes.map((lane) => (
        <option key={String(lane.key)} value={String(lane.key)}>
          {lane.name}
        </option>
      ))}
      <option value={PARK_SELECT_VALUES.issue}>{parkOptionLabels.issue}</option>
      <option value={PARK_SELECT_VALUES.waiting}>{parkOptionLabels.waiting}</option>
    </select>
  );
}

/**
 * The park sub-editor shared by lane on.*, transition, external-event, and step
 * routes: an optional label and the park's recovery actions (label / target
 * lane / hint), matching the lane-action row idiom. A park needs at least one
 * action, so the last remove control is disabled.
 */
export function ParkTargetFields({
  target,
  path,
  lanes,
  ariaLabelBase,
  heading,
  disabled = false,
  onMutate,
}: {
  readonly target: WorkflowParkTargetEncoded;
  readonly path: RouteTargetPath;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly ariaLabelBase: string;
  readonly heading: string;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const isIssue = target.park === "issue";
  const actions = target.actions;
  return (
    <div
      data-testid="park-target-fields"
      data-substate={target.park}
      className={cn(
        "space-y-3 rounded-md border p-3",
        isIssue ? "border-warning/45 bg-warning/8" : "border-info/45 bg-info/8",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm text-[10px] font-semibold",
            isIssue ? "bg-warning/20 text-warning-foreground" : "bg-info/20 text-info-foreground",
          )}
        >
          {isIssue ? "⚠" : "⏸"}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading} · park {isIssue ? "issue" : "waiting on you"}
        </span>
      </div>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Park label (optional)</span>
        <Input
          aria-label={`${ariaLabelBase} park label`}
          value={target.label ?? ""}
          placeholder={isIssue ? "Needs a fix" : "Waiting on you"}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => {
            const label = event.currentTarget.value;
            onMutate((current) => updateParkTarget(current, path, { label }));
          }}
        />
      </label>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Recovery actions</span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addParkAction(current, path))}
          >
            <PlusIcon className="size-3.5" />
            Action
          </Button>
        </div>
        <ol className="space-y-3">
          {actions.map((action, index) => (
            <li
              key={index}
              className="space-y-2 rounded-md border border-border/70 bg-background/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Action {index + 1}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${ariaLabelBase} action ${index + 1}`}
                  disabled={disabled || actions.length <= 1}
                  onClick={() => onMutate((current) => removeParkAction(current, path, index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  aria-label={`${ariaLabelBase} action ${index + 1} label`}
                  value={action.label}
                  disabled={disabled}
                  onChange={(event) => {
                    const label = event.currentTarget.value;
                    onMutate((current) => updateParkAction(current, path, index, { label }));
                  }}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Moves to</span>
                <select
                  aria-label={`${ariaLabelBase} action ${index + 1} target lane`}
                  className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={String(action.to)}
                  disabled={disabled}
                  onChange={(event) => {
                    const to = event.currentTarget.value;
                    onMutate((current) => updateParkAction(current, path, index, { to }));
                  }}
                >
                  {lanes.map((lane) => (
                    <option key={String(lane.key)} value={String(lane.key)}>
                      {lane.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Hint</span>
                <Input
                  aria-label={`${ariaLabelBase} action ${index + 1} hint`}
                  value={action.hint ?? ""}
                  placeholder="Shown as the button tooltip"
                  disabled={disabled}
                  onChange={(event) => {
                    const hint = event.currentTarget.value;
                    onMutate((current) => updateParkAction(current, path, index, { hint }));
                  }}
                />
              </label>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
