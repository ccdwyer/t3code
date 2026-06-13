import type {
  AgentSelection,
  WorkflowBoardDigest,
  WorkflowWebhookConfig,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { IntakeTicketInput } from "~/workflow/intakeState";

import { BoardDigestDialog } from "./BoardDigestDialog";
import { IntakeDialog } from "./IntakeDialog";
import { WebhookConfigDialog } from "./WebhookConfigDialog";

export interface BoardHeaderLane {
  readonly key: string;
  readonly name: string;
}

export interface NewTicketInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly initialLane: string;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly tokenBudget?: number | undefined;
}

export interface BoardHeaderTicketOption {
  readonly ticketId: string;
  readonly title: string;
}

export const getDefaultInitialLane = (lanes: ReadonlyArray<BoardHeaderLane>): string | null =>
  lanes[0]?.key ?? null;

export function BoardHeaderControls({
  boardId,
  lanes,
  tickets = [],
  workflowEditorOpen = false,
  intakeDisabledReason,
  needsAttentionCount = 0,
  onCreateTicket,
  onCreateTicketAsync,
  onProposeTickets,
  onToggleWorkflowEditor,
  onFetchDigest,
  onFetchWebhookConfig,
}: {
  readonly boardId: string | null;
  readonly lanes: ReadonlyArray<BoardHeaderLane>;
  readonly tickets?: ReadonlyArray<BoardHeaderTicketOption>;
  readonly workflowEditorOpen?: boolean | undefined;
  readonly intakeDisabledReason?: string | undefined;
  readonly onCreateTicket: (input: NewTicketInput) => void;
  readonly onCreateTicketAsync?: ((input: NewTicketInput) => Promise<string | void>) | undefined;
  readonly onProposeTickets?:
    | ((braindump: string, agent: AgentSelection) => Promise<ReadonlyArray<IntakeTicketInput>>)
    | undefined;
  readonly onToggleWorkflowEditor?: (() => void) | undefined;
  readonly needsAttentionCount?: number | undefined;
  readonly onFetchDigest?: (() => Promise<WorkflowBoardDigest>) | undefined;
  readonly onFetchWebhookConfig?: ((rotate: boolean) => Promise<WorkflowWebhookConfig>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [initialLane, setInitialLane] = useState(() => getDefaultInitialLane(lanes) ?? "");
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<string>>([]);
  const [tokenBudget, setTokenBudget] = useState("");

  useEffect(() => {
    if (lanes.some((lane) => lane.key === initialLane)) {
      return;
    }
    setInitialLane(getDefaultInitialLane(lanes) ?? "");
  }, [initialLane, lanes]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canCreateTicket = Boolean(boardId && initialLane && trimmedTitle);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setInitialLane(getDefaultInitialLane(lanes) ?? "");
    setDependsOn([]);
    setTokenBudget("");
  };

  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {onFetchWebhookConfig ? (
        <WebhookConfigDialog disabled={!boardId} onFetchConfig={onFetchWebhookConfig} />
      ) : null}
      {onFetchDigest ? (
        <BoardDigestDialog
          disabled={!boardId}
          needsAttentionCount={needsAttentionCount}
          onFetchDigest={onFetchDigest}
        />
      ) : null}
      {onToggleWorkflowEditor ? (
        <Button
          type="button"
          size="xs"
          variant={workflowEditorOpen ? "secondary" : "outline"}
          disabled={!boardId}
          aria-pressed={workflowEditorOpen}
          onClick={onToggleWorkflowEditor}
        >
          <PencilIcon className="size-3.5" />
          Edit workflow
        </Button>
      ) : null}
      {onProposeTickets ? (
        <IntakeDialog
          disabled={!boardId || lanes.length === 0 || intakeDisabledReason !== undefined}
          disabledReason={intakeDisabledReason}
          onPropose={onProposeTickets}
          onCreateTickets={async (tickets) => {
            const lane = getDefaultInitialLane(lanes);
            if (lane === null) {
              return;
            }
            // Sequential so dependency edges can reference the ids of the
            // tickets created earlier in this same batch.
            const createdIds: Array<string | undefined> = [];
            for (const ticket of tickets) {
              const dependsOn = ticket.dependsOnIndices
                .map((index) => createdIds[index])
                .filter((ticketId): ticketId is string => ticketId !== undefined);
              const input = {
                title: ticket.title,
                ...(ticket.description === undefined ? {} : { description: ticket.description }),
                initialLane: lane,
                ...(dependsOn.length > 0 ? { dependsOn } : {}),
              };
              if (onCreateTicketAsync) {
                createdIds.push((await onCreateTicketAsync(input)) ?? undefined);
              } else {
                onCreateTicket(input);
                createdIds.push(undefined);
              }
            }
          }}
        />
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            resetForm();
          }
        }}
      >
        <Button
          type="button"
          size="xs"
          disabled={!boardId || lanes.length === 0}
          onClick={() => setOpen(true)}
        >
          <PlusIcon className="size-3.5" />
          New ticket
        </Button>
        <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden">
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreateTicket) {
                return;
              }

              const parsedBudget = Number.parseInt(tokenBudget, 10);
              onCreateTicket({
                title: trimmedTitle,
                ...(trimmedDescription ? { description: trimmedDescription } : {}),
                initialLane,
                ...(dependsOn.length > 0 ? { dependsOn } : {}),
                ...(Number.isFinite(parsedBudget) && parsedBudget > 0
                  ? { tokenBudget: parsedBudget }
                  : {}),
              });
              resetForm();
              setOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>New ticket</DialogTitle>
              <DialogDescription>
                Capture the work request, context, and acceptance criteria before adding it to the
                board.
              </DialogDescription>
            </DialogHeader>
            <div
              className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
              data-slot="dialog-panel"
            >
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Title</span>
                <Input
                  value={title}
                  placeholder="Ticket title"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  aria-label="Ticket title"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Description</span>
                <Textarea
                  value={description}
                  placeholder="Describe the work, useful context, and acceptance criteria."
                  onChange={(event) => setDescription(event.currentTarget.value)}
                  aria-label="Ticket description"
                  rows={8}
                />
              </label>
              {tickets.length > 0 ? (
                <fieldset className="grid gap-1.5">
                  <legend className="text-xs font-medium text-foreground">
                    Depends on (held until these land)
                  </legend>
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/70 p-2">
                    {tickets.map((option) => (
                      <label key={option.ticketId} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={dependsOn.includes(option.ticketId)}
                          onChange={(event) => {
                            // currentTarget is nulled before the updater runs.
                            const checked = event.currentTarget.checked;
                            setDependsOn((current) =>
                              checked
                                ? [...current, option.ticketId]
                                : current.filter((ticketId) => ticketId !== option.ticketId),
                            );
                          }}
                          aria-label={`Depends on ${option.title}`}
                        />
                        <span className="truncate">{option.title}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Token budget (optional)</span>
                <Input
                  value={tokenBudget}
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="e.g. 500000 — agent steps block once usage reaches it"
                  onChange={(event) => setTokenBudget(event.currentTarget.value)}
                  aria-label="Token budget"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Initial lane</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-64"
                  value={initialLane}
                  disabled={lanes.length === 0}
                  onChange={(event) => setInitialLane(event.currentTarget.value)}
                  aria-label="Initial lane"
                >
                  {lanes.map((lane) => (
                    <option key={lane.key} value={lane.key}>
                      {lane.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  resetForm();
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canCreateTicket}>
                Create ticket
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
