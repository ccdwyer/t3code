import { MessageId, ProjectId, TicketId } from "@t3tools/contracts";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { TicketDiffContent } from "./TicketDiff";
import { TicketDrawer, TicketFullscreen, isTicketSourceOwned } from "./TicketDrawer";

vi.mock("@pierre/diffs/react", () => {
  const FileDiff = (props: {
    fileDiff: { name?: string | null; prevName?: string | null };
    renderHeaderPrefix?: () => ReactNode;
  }) => (
    <div data-testid="file-diff">
      {props.renderHeaderPrefix?.()}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );

  return { FileDiff };
});

const ticketDetail = {
  ticket: {
    ticketId: "ticket-1",
    boardId: "board-1",
    title: "Review release blockers",
    description: "Check the compatibility risk before shipping.",
    currentLaneKey: "review",
    status: "waiting_on_user",
  },
  steps: [
    {
      stepRunId: "step-1",
      stepKey: "agent-review",
      stepType: "agent",
      status: "awaiting_user",
      waitingReason: "Approve the proposed fix",
      providerResponseKind: "user-input",
    },
    {
      stepRunId: "step-2",
      stepKey: "ship",
      stepType: "approval",
      status: "awaiting_user",
      waitingReason: "Ship this release?",
      providerResponseKind: "request",
    },
  ],
  messages: [
    {
      messageId: MessageId.make("message-agent"),
      ticketId: "ticket-1",
      stepRunId: "step-1",
      author: "agent",
      body: "Should I change the websocket payload guard?",
      attachments: [],
      createdAt: "2026-06-08T14:00:00.000Z",
    },
    {
      messageId: MessageId.make("message-user"),
      ticketId: "ticket-1",
      stepRunId: "step-1",
      author: "user",
      body: "Yes, preserve old clients too.",
      attachments: [
        {
          kind: "image",
          id: "image-1",
          name: "payload.png",
          mimeType: "image/png",
          sizeBytes: 7,
          dataUrl: "data:image/png;base64,cGF5bG9hZA==",
        },
      ],
      createdAt: "2026-06-08T14:01:00.000Z",
    },
  ],
} as const;

describe("isTicketSourceOwned", () => {
  it("returns false when syncedSource is absent", () => {
    expect(isTicketSourceOwned({ syncedSource: undefined })).toBe(false);
  });

  it("returns true when syncedSource is present", () => {
    expect(
      isTicketSourceOwned({
        syncedSource: { provider: "github", url: "https://github.com/o/r/issues/1" },
      }),
    ).toBe(true);
  });
});

describe("TicketDrawer", () => {
  it("explains a blocked ticket and does not present its current step as live", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          ticket: {
            ...ticketDetail.ticket,
            status: "blocked",
            attentionKind: "blocked",
            attentionReason: "Review provider did not start before the dispatch deadline.",
          },
          steps: [
            {
              stepRunId: "step-review",
              stepKey: "review",
              stepType: "agent",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              providerThreadId: "thread-review",
              startedAt: "2026-07-23T23:15:39.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="ticket-blocked-banner"');
    expect(markup).toContain("Review provider did not start before the dispatch deadline.");
    expect(markup).toContain(">blocked<");
    expect(markup).not.toContain("Waiting for the agent to start");
  });

  it("includes the failed step cause in a blocked ticket's technical details", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          ticket: {
            ...ticketDetail.ticket,
            status: "blocked",
            attentionKind: "blocked",
            attentionReason: "pipeline failure with no route",
          },
          steps: [
            {
              stepRunId: "step-review",
              stepKey: "review",
              stepType: "agent",
              status: "failed",
              waitingReason: null,
              blockedReason: null,
              error: "session/set_model rejected grok-composer-2.5-fast",
              startedAt: "2026-07-23T23:45:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("pipeline failure with no route");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("session/set_model rejected grok-composer-2.5-fast");
  });

  it("presents an abandoned running step as superseded when a newer step has started", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          ticket: {
            ...ticketDetail.ticket,
            status: "running",
            currentStepLabel: "implement",
          },
          steps: [
            {
              stepRunId: "step-review",
              stepKey: "review",
              stepType: "agent",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              providerThreadId: "thread-review",
              startedAt: "2026-07-23T23:15:39.000Z",
            },
            {
              stepRunId: "step-implement",
              stepKey: "implement",
              stepType: "agent",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              providerThreadId: "thread-implement",
              startedAt: "2026-07-23T23:29:59.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup.match(/>superseded</g)?.length).toBe(1);
    expect(markup.match(/>running</g)?.length).toBe(1);
    expect(markup.match(/Waiting for the agent to start/g)?.length).toBe(1);
  });

  it("offers a delete control when onDeleteTicket is provided", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={ticketDetail}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onDeleteTicket={async () => undefined}
      />,
    );
    // Confirm dialog content only mounts when open (portal); the trigger is
    // enough to prove the surface is wired.
    expect(markup).toContain("ticket-delete");
    expect(markup).toContain('aria-label="Delete ticket Review release blockers"');
  });

  it("hides the delete control when onDeleteTicket is omitted", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );
    expect(markup).not.toContain("ticket-delete");
  });

  it("renders ticket metadata, the message thread, the reply composer, and approval gates", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).toContain("Review release blockers");
    expect(markup).toContain("Check the compatibility risk before shipping.");
    expect(markup).toContain("agent-review");
    expect(markup).toContain("awaiting user");
    expect(markup).toContain("Approve the proposed fix");
    expect(markup).toContain("Should I change the websocket payload guard?");
    expect(markup).toContain("Yes, preserve old clients too.");
    expect(markup).toContain("payload.png");
    expect(markup).toContain("Ticket reply");
    expect(markup).toContain("Send reply");
    expect(markup).toContain("Edit ticket");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Run lane");
  });

  it("surfaces Open conversation in the header when an agent step has a provider thread", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-1",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Approve the proposed fix",
              providerResponseKind: "user-input",
              providerThreadId: "thread-agent-review",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("ticket-open-conversation");
    expect(markup).toContain("Open conversation");
  });

  it("renders the steer composer for a running agent step when canSteer is true", () => {
    const api = {
      workflow: {
        steerTicketStep: vi.fn(async () => ({ accepted: true as const })),
      },
    } as never;
    const markup = renderToStaticMarkup(
      <TicketDrawer
        api={api}
        detail={{
          ...ticketDetail,
          ticket: { ...ticketDetail.ticket, status: "running" },
          steps: [
            {
              stepRunId: "step-running",
              stepKey: "implement",
              stepType: "agent",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              providerThreadId: "thread-impl",
              canSteer: true,
              startedAt: "2026-07-24T00:00:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="steer-composer"');
    expect(markup).toContain("Steer the agent");
  });

  it("renders disabled steer composer with tooltip when steerBlockedReason is delivering", () => {
    const api = {
      workflow: {
        steerTicketStep: vi.fn(async () => ({ accepted: true as const })),
      },
    } as never;
    const markup = renderToStaticMarkup(
      <TicketDrawer
        api={api}
        detail={{
          ...ticketDetail,
          ticket: { ...ticketDetail.ticket, status: "running" },
          steps: [
            {
              stepRunId: "step-running",
              stepKey: "implement",
              stepType: "agent",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              providerThreadId: "thread-impl",
              canSteer: false,
              steerBlockedReason: "delivering",
              startedAt: "2026-07-24T00:00:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="steer-composer"');
    expect(markup).toContain("Previous steering message is on its way");
  });

  it("badges steering messages in the discussion thread", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          messages: [
            {
              messageId: MessageId.make("message-steer"),
              ticketId: "ticket-1",
              stepRunId: "step-1",
              author: "user",
              body: "also update the tests",
              attachments: [],
              createdAt: "2026-06-08T14:02:00.000Z",
              kind: "steering",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );
    expect(markup).toContain("steered mid-run");
    expect(markup).toContain("also update the tests");
  });

  it("hides Open conversation when no agent step has a provider thread", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).not.toContain("ticket-open-conversation");
    expect(markup).not.toContain("Open conversation");
  });

  it("renders an edited indicator for messages with editedAt and omits it otherwise", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          messages: [
            {
              messageId: MessageId.make("message-edited"),
              ticketId: "ticket-1",
              author: "user",
              body: "Edited body text.",
              attachments: [],
              createdAt: "2026-06-08T14:01:00.000Z",
              editedAt: "2026-06-08T14:05:00.000Z",
            },
            {
              messageId: MessageId.make("message-plain"),
              ticketId: "ticket-1",
              author: "user",
              body: "Unedited body text.",
              attachments: [],
              createdAt: "2026-06-08T14:02:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Edited body text.");
    expect(markup).toContain("Unedited body text.");
    expect(markup).toContain("· edited");
    // Only the edited message should carry the indicator.
    expect(markup.match(/· edited/g)?.length).toBe(1);
  });

  it("shows an Edit button only for the user's own comments (stepRunId == null)", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          messages: [
            {
              messageId: MessageId.make("message-own"),
              ticketId: "ticket-1",
              author: "user",
              body: "My own comment.",
              attachments: [],
              createdAt: "2026-06-08T14:00:00.000Z",
            },
            {
              messageId: MessageId.make("message-answer"),
              ticketId: "ticket-1",
              stepRunId: "step-1",
              author: "user",
              body: "Answer to an agent step.",
              attachments: [],
              createdAt: "2026-06-08T14:01:00.000Z",
            },
            {
              messageId: MessageId.make("message-agent"),
              ticketId: "ticket-1",
              author: "agent",
              body: "Agent reply.",
              attachments: [],
              createdAt: "2026-06-08T14:02:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onEditMessage={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    // Exactly one Edit-message button — for the standalone user comment only.
    expect(markup.match(/aria-label="Edit comment"/g)?.length).toBe(1);
  });

  it("explains why the ticket is in its lane and lists the route history", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          routeHistory: [
            {
              occurredAt: "2026-06-08T13:00:00.000Z",
              toLane: "implement",
              source: "manual",
            },
            {
              occurredAt: "2026-06-08T14:00:00.000Z",
              fromLane: "implement",
              toLane: "review",
              source: "lane_transition",
              matchedTransitionIndex: 1,
              pipelineResult: "success",
              laneRunCount: 2,
              steps: {
                verdict: { status: "completed", exitCode: 0, verdict: "approve" },
              },
            },
          ],
        }}
        lanes={[
          { key: "implement", name: "Implementation", entry: "auto", pipelineStepCount: 1 },
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 },
        ]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Why is this ticket here?");
    expect(markup).toContain("Implementation → Review");
    expect(markup).toContain("Matched transition #2");
    expect(markup).toContain("verdict: approve");
    expect(markup).toContain("Route history (2)");
    expect(markup).toContain("Moved manually");
  });

  it("renders captured step output with a verdict badge", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-verdict",
              stepKey: "review",
              stepType: "agent",
              status: "completed",
              waitingReason: null,
              output: { verdict: "revise", notes: "Tighten the error handling." },
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("verdict: revise");
    expect(markup).toContain("Tighten the error handling.");
  });

  it("shows approval actions instead of the reply composer for provider approval requests", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-provider-request",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Approve this command?",
              providerResponseKind: "request",
            },
          ],
          messages: [],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Approve this command?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).not.toContain("Ticket reply");
    expect(markup).not.toContain("Send reply");
  });

  it("shows the reply composer for provider user-input requests", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-provider-question",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Which API should I use?",
              providerResponseKind: "user-input",
            },
          ],
          messages: [],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Which API should I use?");
    expect(markup).toContain("Ticket reply");
    expect(markup).toContain("Send reply");
    expect(markup).not.toContain("Approve");
    expect(markup).not.toContain("Reject");
  });

  it("renders ticket image attachments without direct data-url links", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).toContain('src="data:image/png;base64,cGF5bG9hZA=="');
    expect(markup).not.toContain('href="data:image/png');
  });

  it("disables Run lane when the current lane has no manual pipeline", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={ticketDetail}
        lanes={[
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 },
          { key: "implement", name: "Implement", entry: "auto", pipelineStepCount: 2 },
        ]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain('title="This lane has no manual pipeline to run."');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Run lane<\/button>/s);
  });

  it("disables Run lane for a parked ticket even when its lane has a manual pipeline", () => {
    // The parked ticket sits in a manual lane WITH a pipeline, so the old gate
    // (entry === manual && pipelineStepCount > 0) would have enabled Run lane —
    // but a parked ticket is non-admitted, so the server would no-op/error. The
    // affordance must be disabled with the recovery-pointing title.
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={parkedTicketDetail}
        lanes={[{ key: "implement", name: "Implement", entry: "manual", pipelineStepCount: 2 }]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onParkAction={async () => {}}
      />,
    );

    expect(markup).toContain('title="Parked — use the recovery actions above."');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Run lane<\/button>/s);
  });

  it("renders script steps with read-only logs and operational badges", () => {
    const Drawer = TicketDrawer as ComponentType<
      Parameters<typeof TicketDrawer>[0] & { readonly projectId: ProjectId }
    >;
    const markup = renderToStaticMarkup(
      <Drawer
        api={
          {
            terminal: {
              attachHistory: () => () => undefined,
            },
          } as never
        }
        projectId={ProjectId.make("project-1")}
        detail={{
          ticket: {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Review release blockers",
            currentLaneKey: "review",
            status: "blocked",
          },
          steps: [
            {
              stepRunId: "step-running",
              stepKey: "tests",
              stepType: "script",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              scriptThreadId: "script-thread-1",
              terminalId: "script-terminal-1",
              scriptStatus: "running",
              exitCode: null,
              signal: null,
            },
            {
              stepRunId: "step-failed",
              stepKey: "lint",
              stepType: "script",
              status: "failed",
              waitingReason: null,
              blockedReason: null,
              scriptThreadId: "script-thread-2",
              terminalId: "script-terminal-2",
              scriptStatus: "exited",
              exitCode: 2,
              signal: null,
            },
            {
              stepRunId: "step-blocked",
              stepKey: "trust",
              stepType: "script",
              status: "blocked",
              waitingReason: null,
              blockedReason: "Project not trusted to run scripts",
              scriptThreadId: null,
              terminalId: null,
              scriptStatus: null,
              exitCode: null,
              signal: null,
            },
          ],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 3 }]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Script output");
    expect(markup).toContain("running");
    expect(markup).toContain("exit 2");
    expect(markup).toContain("blocked");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Trust this project &amp; run");
  });
});

const parkedTicketDetail = {
  ticket: {
    ticketId: "ticket-1",
    boardId: "board-1",
    title: "Fix the flaky test",
    currentLaneKey: "implement",
    status: "parked",
    updatedAt: "2026-06-08T10:00:00.000Z",
    parked: {
      substate: "issue",
      label: "Issue encountered",
      reason: "The implement step exited non-zero twice.",
      parkedAt: "2026-06-08T10:00:00.000Z",
      parkedEventId: "event-1",
      actions: [
        { label: "Retry", to: "implement", hint: "Re-run the implement lane" },
        { label: "Escalate", to: "review" },
      ],
    },
  },
  steps: [],
  messages: [],
} as const;

describe("TicketDrawer parked banner", () => {
  it("renders the parked banner with label, reason, age, and recovery actions", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={parkedTicketDetail}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onParkAction={async () => {}}
      />,
    );

    expect(markup).toContain('data-testid="ticket-parked-banner"');
    expect(markup).toContain('data-tier="issue"');
    expect(markup).toContain("border-destructive/40");
    expect(markup).toContain("bg-destructive/8");
    expect(markup).toContain("text-destructive-foreground");
    expect(markup).not.toContain("border-warning/40");
    expect(markup).toContain('data-testid="ticket-parked-label"');
    expect(markup).toContain("Issue encountered");
    expect(markup).toContain('data-testid="ticket-parked-reason"');
    // Full reason text, not truncated — the drawer has room, unlike the card.
    expect(markup).toContain("The implement step exited non-zero twice.");
    // The park is far in the past relative to "now" (system date is 2026-07-22),
    // so the aging clock has kicked in.
    expect(markup).toContain('data-testid="ticket-parked-age"');
    expect(markup).toContain('data-testid="ticket-parked-actions"');
    expect(markup).toContain(">Retry<");
    expect(markup).toContain('data-testid="ticket-parked-actions-overflow"');
  });

  it("disables the banner's recovery buttons while a shared park action is in flight", () => {
    // Scope to the banner's action zone — the drawer footer has its own always
    // -disabled controls (e.g. Run lane), so we inspect only the parked actions.
    const bannerActions = (markup: string): string => {
      const start = markup.indexOf('data-testid="ticket-parked-actions"');
      const end = markup.indexOf("</div>", start);
      return markup.slice(start, end);
    };
    const render = (parkActionPending: boolean) =>
      renderToStaticMarkup(
        <TicketDrawer
          detail={parkedTicketDetail}
          onApprove={async () => undefined}
          onRunLane={() => {}}
          onParkAction={async () => {}}
          parkActionPending={parkActionPending}
        />,
      );
    expect(bannerActions(render(false))).not.toContain('disabled=""');
    expect(bannerActions(render(true))).toContain('disabled=""');
  });

  it("wires the primary action (index 0) with its hint and renders an overflow trigger for the rest — the same dispatchParkAction/splitParkActions helpers whose exact-args forwarding is unit-tested in TicketCard.test.tsx", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={parkedTicketDetail}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onParkAction={async () => {}}
      />,
    );

    // Primary action (index 0 → Retry) carries its hint as a title attribute.
    expect(markup).toContain('title="Re-run the implement lane"');
    expect(markup).toContain(">Retry<");
    // Overflow trigger present for the remaining action (index 1 → Escalate);
    // Base UI's popup content is portaled and not present in static markup.
    expect(markup).toContain('data-testid="ticket-parked-actions-overflow"');
  });

  it("shows the unavailable note when park actions are absent, pointing at the Move escape hatch", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...parkedTicketDetail,
          ticket: {
            ...parkedTicketDetail.ticket,
            parked: { ...parkedTicketDetail.ticket.parked, actions: undefined },
          },
        }}
        lanes={[
          { key: "implement", name: "Implementation", entry: "auto", pipelineStepCount: 1 },
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 },
        ]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onMove={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="ticket-parked-actions-unavailable"');
    expect(markup).not.toContain('data-testid="ticket-parked-actions"');
    expect(markup).toContain("Actions unavailable");
    // The Move select in the footer remains the escape hatch.
    expect(markup).toContain(">Move<");
  });

  it("renders no parked banner for a non-parked ticket", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).not.toContain('data-testid="ticket-parked-banner"');
  });

  it("keeps the step-answer/reply UI exclusive to waiting_on_user — a parked ticket never shows it, even with a comment composer available", () => {
    // Parked ⇒ status !== "waiting_on_user" (mutually exclusive statuses).
    expect(parkedTicketDetail.ticket.status).not.toBe("waiting_on_user");

    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={parkedTicketDetail}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onPostComment={async () => undefined}
      />,
    );

    expect(markup).not.toContain("Ticket reply");
    expect(markup).not.toContain("Send reply");
    // The plain comment composer (not the step-answer UI) is still available.
    expect(markup).toContain("Add a comment");
  });
});

// `TicketDrawer`'s `fullscreen` state is only reachable via a button click,
// which this Node-only (no DOM) test suite cannot dispatch through
// `renderToStaticMarkup` — so the fullscreen banner is exercised by rendering
// the exported `TicketFullscreen` sub-component directly.
describe("TicketFullscreen parked banner", () => {
  const laneDisplayName = (key: string): string => key;
  const baseFullscreenProps = {
    lanes: [],
    laneDisplayName,
    laneActions: [],
    canRunLane: false,
    runLaneTitle: "",
    routeHistory: [],
    latestRouteDecision: null,
    ticketDescription: "",
    editState: null,
    sourceOwned: false,
    replyState: {
      canReply: false,
      replyText: "",
      setReplyText: () => {},
      replyAttachments: [],
      setReplyAttachments: () => {},
      replyError: null,
      replySubmitting: false,
      attachReplyImages: async () => {},
      sendReply: async () => {},
    },
    approvalState: {
      approvalSubmittingStepRunId: null,
      approvalError: null,
      submitApproval: async () => {},
    },
    waitingStepCount: 0,
    onRunLane: () => {},
    now: Date.now(),
    onClose: () => {},
  };

  it("renders the parked banner (label + an action) inside the fullscreen markup", () => {
    const markup = renderToStaticMarkup(
      <TicketFullscreen
        {...baseFullscreenProps}
        detail={parkedTicketDetail}
        onParkAction={async () => {}}
      />,
    );

    expect(markup).toContain('data-testid="ticket-parked-banner"');
    expect(markup).toContain("Issue encountered");
    expect(markup).toContain(">Retry<");
  });

  it("renders no parked banner in fullscreen for a non-parked ticket", () => {
    const markup = renderToStaticMarkup(
      <TicketFullscreen {...baseFullscreenProps} detail={ticketDetail} />,
    );

    expect(markup).not.toContain('data-testid="ticket-parked-banner"');
  });

  it("pins lane controls in a footer below the scrollable steps/diff column", () => {
    const markup = renderToStaticMarkup(
      <TicketFullscreen
        {...baseFullscreenProps}
        detail={ticketDetail}
        canRunLane
        runLaneTitle="Run review"
        onMove={() => {}}
        lanes={[
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 1 },
          { key: "land", name: "Land", entry: "auto", pipelineStepCount: 0 },
        ]}
      />,
    );

    expect(markup).toContain('data-testid="ticket-fullscreen-lane-controls"');
    expect(markup).toContain("Lane controls");
    expect(markup).toContain("Run lane");
    // Footer is a sibling of the scroll region, not nested inside Accumulated diff.
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("border-t border-border");
  });
});

describe("TicketDrawer synced-source badge", () => {
  it("shows Synced from badge and hides Edit button when syncedSource is set", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          syncedSource: {
            provider: "github",
            url: "https://github.com/owner/repo/issues/42",
          },
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Synced from github");
    expect(markup).toContain("https://github.com/owner/repo/issues/42");
    expect(markup).not.toContain("Edit ticket");
  });

  it("shows Edit ticket button when syncedSource is absent", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).not.toContain("Synced from");
    expect(markup).toContain("Edit ticket");
  });
});

describe("TicketDiffContent", () => {
  it("renders file summaries and the parsed patch viewer", () => {
    const markup = renderToStaticMarkup(
      <TicketDiffContent
        diff={{
          ticketId: TicketId.make("ticket-1"),
          baseRef: "refs/workflow/tickets/ticket-1/base",
          truncated: false,
          files: [{ path: "src/workflow.ts", additions: 4, deletions: 1 }],
          patch:
            "diff --git a/src/workflow.ts b/src/workflow.ts\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/src/workflow.ts\n" +
            "+++ b/src/workflow.ts\n" +
            "@@ -1 +1 @@\n" +
            "-old\n" +
            "+new\n",
        }}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("refs/workflow/tickets/ticket-1/base");
    expect(markup).toContain("src/workflow.ts");
    expect(markup).toContain("+4");
    expect(markup).toContain("-1");
    expect(markup).toContain("file-diff");
    expect(markup).toContain("1 file");
  });

  it("renders each changed file as a collapsed details row by default", () => {
    const markup = renderToStaticMarkup(
      <TicketDiffContent
        diff={{
          ticketId: TicketId.make("ticket-1"),
          baseRef: "refs/workflow/tickets/ticket-1/base",
          truncated: false,
          files: [
            { path: "src/a.ts", additions: 2, deletions: 0 },
            { path: "src/b.ts", additions: 0, deletions: 3 },
          ],
          patch:
            "diff --git a/src/a.ts b/src/a.ts\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/src/a.ts\n" +
            "+++ b/src/a.ts\n" +
            "@@ -1 +1 @@\n" +
            "-old-a\n" +
            "+new-a\n" +
            "diff --git a/src/b.ts b/src/b.ts\n" +
            "index 3333333..4444444 100644\n" +
            "--- a/src/b.ts\n" +
            "+++ b/src/b.ts\n" +
            "@@ -1 +1 @@\n" +
            "-old-b\n" +
            "+new-b\n",
        }}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain('data-testid="ticket-diff-file-list"');
    expect(markup).toContain('data-testid="ticket-diff-file-src/a.ts"');
    expect(markup).toContain('data-testid="ticket-diff-file-src/b.ts"');
    expect(markup).toContain("2 files");
    // Collapsed by default: native <details> without an open attribute.
    expect(markup).toMatch(/<details[^>]*data-testid="ticket-diff-file-src\/a\.ts"/);
    expect(markup).not.toMatch(
      /<details[^>]*open[^>]*data-testid="ticket-diff-file-src\/a\.ts"|data-testid="ticket-diff-file-src\/a\.ts"[^>]*open/,
    );
  });

  it("renders the handoff context pack and flags an edited section", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          contextPack: {
            forLane: "review",
            fromLane: "implement",
            compiledAt: "2026-07-25T00:00:00.000Z",
            editedAt: "2026-07-25T01:00:00.000Z",
            sections: [
              { key: "diff_summary", body: "3 files changed", autoGenerated: true },
              { key: "notes", body: "watch the parser", autoGenerated: false },
            ],
          },
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );
    expect(markup).toContain("Handoff context");
    expect(markup).toContain("From implement");
    expect(markup).toContain("3 files changed");
    expect(markup).toContain("watch the parser");
    expect(markup).toContain("Diff summary");
  });

  it("renders the pack for the lane it was compiled for after a re-route", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          contextPack: {
            forLane: "verify",
            fromLane: "review",
            compiledAt: "2026-07-25T02:00:00.000Z",
            sections: [{ key: "notes", body: "second lane handoff", autoGenerated: true }],
          },
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );
    expect(markup).toContain("From review");
    expect(markup).toContain("second lane handoff");
  });

  it("renders no handoff section when the ticket has no pack", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );
    expect(markup).not.toContain("Handoff context");
  });

  it("offers no History section when the host did not wire a timeline loader", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );
    // An empty shell for an unwired capability is worse than no section.
    expect(markup).not.toContain("ticket-history");
  });

  it("renders a collapsed History section when a loader is provided", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={ticketDetail}
        onApprove={async () => undefined}
        onRunLane={() => {}}
        onLoadTimeline={async () => ({ events: [], truncated: false })}
      />,
    );
    expect(markup).toContain("ticket-history");
    expect(markup).toContain("History");
    // Collapsed: nothing is fetched until the user asks for it.
    expect(markup).not.toContain("Loading history");
  });
});
