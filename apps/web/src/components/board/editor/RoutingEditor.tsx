import type { WorkflowLintError } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import {
  addLaneEvent,
  addTransition,
  adjustSelectionAfterTransitionRemoval,
  isParkRouteTarget,
  lintErrorKey,
  removeLaneEvent,
  removeTransition,
  updateLaneEvent,
  updateTransition,
} from "~/workflow/editorModel";

import { ParkTargetFields, RouteTargetSelect } from "./RouteTargetField";
import {
  lintErrorMatchesTransition,
  type WorkflowEditorMutation,
  type WorkflowLaneEncoded,
} from "./WorkflowEditor";

const laneRouteKinds = ["success", "failure", "blocked"] as const;

export function RoutingEditor({
  lane,
  lanes,
  lintErrors,
  disabled = false,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const transitions = lane.transitions ?? [];

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">Routing</h4>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onMutate((current) => addTransition(current, laneKey))}
        >
          <PlusIcon className="size-3.5" />
          Transition
        </Button>
      </div>
      <div className="space-y-3">
        <div className="grid gap-3 @2xl:grid-cols-3">
          {laneRouteKinds.map((kind) => (
            <label key={kind} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">{`Lane ${kind} route`}</span>
              <RouteTargetSelect
                ariaLabel={`Lane ${kind} route`}
                lanes={lanes}
                target={lane.on?.[kind]}
                path={{ site: "laneOn", laneKey, kind }}
                allowNoRoute
                disabled={disabled}
                onMutate={onMutate}
              />
            </label>
          ))}
        </div>
        {laneRouteKinds.map((kind) => {
          const target = lane.on?.[kind];
          return isParkRouteTarget(target) ? (
            <ParkTargetFields
              key={kind}
              target={target}
              path={{ site: "laneOn", laneKey, kind }}
              lanes={lanes}
              ariaLabelBase={`Lane ${kind} route`}
              heading={`Lane ${kind} route`}
              disabled={disabled}
              onMutate={onMutate}
            />
          ) : null;
        })}
      </div>
      {transitions.length === 0 ? (
        <p className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
          No conditional transitions.
        </p>
      ) : (
        <ol className="space-y-3">
          {transitions.map((transition, index) => (
            <TransitionFields
              key={transitionRowKey(index)}
              laneKey={laneKey}
              lanes={lanes}
              transitionIndex={index}
              transition={transition}
              lintErrors={lintErrors.filter((lintError) =>
                lintErrorMatchesTransition(lintError, laneKey, index),
              )}
              disabled={disabled}
              onMutate={onMutate}
            />
          ))}
        </ol>
      )}
      <LaneEventsEditor lane={lane} lanes={lanes} disabled={disabled} onMutate={onMutate} />
    </section>
  );
}

/**
 * External-event matchers: a webhook event with a matching name (and passing
 * predicate over {event: {name, payload}}) moves a ticket sitting in this
 * lane to the matcher's target.
 */
function LaneEventsEditor({
  lane,
  lanes,
  disabled = false,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const events = lane.onEvent ?? [];

  return (
    <div className="space-y-3 border-t border-border/60 pt-3" data-testid="lane-events-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h5 className="text-sm font-semibold text-foreground">External events</h5>
          <p className="text-xs text-muted-foreground">
            Webhook events (CI, PR automation, cron) that move tickets out of this lane.
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onMutate((current) => addLaneEvent(current, laneKey))}
        >
          <PlusIcon className="size-3.5" />
          Event
        </Button>
      </div>
      {events.length === 0 ? null : (
        <ol className="space-y-3">
          {events.map((event, index) => (
            <LaneEventFields
              key={`lane-event-${index}`}
              laneKey={laneKey}
              lanes={lanes}
              eventIndex={index}
              event={event}
              disabled={disabled}
              onMutate={onMutate}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function LaneEventFields({
  laneKey,
  lanes,
  event,
  eventIndex,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly event: NonNullable<WorkflowLaneEncoded["onEvent"]>[number];
  readonly eventIndex: number;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const [whenDraft, setWhenDraft] = useState(() =>
    event.when === undefined ? "" : JSON.stringify(event.when, null, 2),
  );
  const [whenError, setWhenError] = useState<string | null>(null);

  useEffect(() => {
    setWhenDraft(event.when === undefined ? "" : JSON.stringify(event.when, null, 2));
    setWhenError(null);
  }, [event.when]);

  return (
    <li className="rounded-md border border-border/70 bg-card/35 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Event {eventIndex + 1}</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove event ${eventIndex + 1}`}
          disabled={disabled}
          onClick={() => onMutate((current) => removeLaneEvent(current, laneKey, eventIndex))}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 @2xl:grid-cols-[12rem_minmax(0,1fr)_12rem]">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Event name</span>
          <Input
            aria-label={`Event ${eventIndex + 1} name`}
            value={event.name}
            placeholder="ci.passed"
            disabled={disabled}
            onChange={(changeEvent) => {
              const name = changeEvent.currentTarget.value;
              onMutate((current) => updateLaneEvent(current, laneKey, eventIndex, { name }));
            }}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            Predicate JSON (optional, reads event.name / event.payload.*)
          </span>
          <Textarea
            aria-label={`Event ${eventIndex + 1} predicate JSON`}
            value={whenDraft}
            placeholder='{"==": [{"var": "event.payload.status"}, "green"]}'
            disabled={disabled}
            rows={3}
            onChange={(changeEvent) => {
              const nextDraft = changeEvent.currentTarget.value;
              setWhenDraft(nextDraft);
              if (nextDraft.trim() === "") {
                setWhenError(null);
                onMutate((current) =>
                  updateLaneEvent(current, laneKey, eventIndex, { when: null }),
                );
                return;
              }
              let parsedWhen: unknown;
              try {
                parsedWhen = JSON.parse(nextDraft) as unknown;
              } catch {
                setWhenError("Predicate JSON is invalid.");
                return;
              }
              setWhenError(null);
              onMutate((current) =>
                updateLaneEvent(current, laneKey, eventIndex, {
                  when: parsedWhen,
                }),
              );
            }}
          />
          {whenError ? <span className="text-xs text-destructive">{whenError}</span> : null}
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Moves to</span>
          <RouteTargetSelect
            ariaLabel={`Event ${eventIndex + 1} target lane`}
            lanes={lanes}
            target={event.to}
            path={{ site: "laneEvent", laneKey, index: eventIndex }}
            disabled={disabled}
            onMutate={onMutate}
          />
        </label>
      </div>
      {isParkRouteTarget(event.to) ? (
        <div className="mt-3">
          <ParkTargetFields
            target={event.to}
            path={{ site: "laneEvent", laneKey, index: eventIndex }}
            lanes={lanes}
            ariaLabelBase={`Event ${eventIndex + 1}`}
            heading="Park in place"
            disabled={disabled}
            onMutate={onMutate}
          />
        </div>
      ) : null}
    </li>
  );
}

export function TransitionFields({
  laneKey,
  lanes,
  lintErrors,
  onMutate,
  transition,
  transitionIndex,
  disabled = false,
}: {
  readonly laneKey: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly onMutate: WorkflowEditorMutation;
  readonly transition: NonNullable<WorkflowLaneEncoded["transitions"]>[number];
  readonly transitionIndex: number;
  readonly disabled?: boolean;
}) {
  const [whenDraft, setWhenDraft] = useState(() => JSON.stringify(transition.when, null, 2));
  const [whenError, setWhenError] = useState<string | null>(null);

  useEffect(() => {
    setWhenDraft(JSON.stringify(transition.when, null, 2));
    setWhenError(null);
  }, [transition.when]);

  return (
    <li className="rounded-md border border-border/70 bg-card/35 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Transition {transitionIndex + 1}</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove transition ${transitionIndex + 1}`}
          disabled={disabled}
          onClick={() =>
            onMutate(
              (current) => removeTransition(current, laneKey, transitionIndex),
              (currentSelection) =>
                adjustSelectionAfterTransitionRemoval(currentSelection, laneKey, transitionIndex),
            )
          }
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      {lintErrors.length > 0 ? (
        <ul className="mb-3 rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
          {lintErrors.map((lintError) => (
            <li key={lintErrorKey(lintError)}>{lintError.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            Transition {transitionIndex + 1} predicate JSON
          </span>
          <Textarea
            aria-label={`Transition ${transitionIndex + 1} predicate JSON`}
            value={whenDraft}
            disabled={disabled}
            onChange={(event) => {
              const nextDraft = event.currentTarget.value;
              setWhenDraft(nextDraft);
              let parsedWhen: unknown;
              try {
                parsedWhen = JSON.parse(nextDraft) as unknown;
              } catch {
                setWhenError("Predicate JSON is invalid.");
                return;
              }
              setWhenError(null);
              onMutate((current) =>
                updateTransition(current, laneKey, transitionIndex, {
                  when: parsedWhen,
                }),
              );
            }}
          />
          {whenError ? <span className="text-xs text-destructive">{whenError}</span> : null}
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Target lane</span>
          <RouteTargetSelect
            ariaLabel={`Transition ${transitionIndex + 1} target lane`}
            lanes={lanes}
            target={transition.to}
            path={{ site: "transition", laneKey, index: transitionIndex }}
            disabled={disabled}
            onMutate={onMutate}
          />
        </label>
      </div>
      {isParkRouteTarget(transition.to) ? (
        <div className="mt-3">
          <ParkTargetFields
            target={transition.to}
            path={{ site: "transition", laneKey, index: transitionIndex }}
            lanes={lanes}
            ariaLabelBase={`Transition ${transitionIndex + 1}`}
            heading="Park in place"
            disabled={disabled}
            onMutate={onMutate}
          />
        </div>
      ) : null}
    </li>
  );
}

function transitionRowKey(index: number): string {
  return `transition-${index}`;
}
