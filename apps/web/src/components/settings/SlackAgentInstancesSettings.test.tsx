import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { readonly children: ReactNode }) => (
    <main>{children}</main>
  ),
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    readonly title: string;
    readonly headerAction?: ReactNode;
    readonly children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));

import {
  canDeleteSlackAgentInstance,
  retryableFailedSlackDeliveryId,
  SlackAgentInstancesPanel,
} from "./SlackAgentInstancesSettings";
import type { SlackAgentInstanceView, SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";

function api(overrides: Partial<SlackAgentWorkflowApi> = {}): SlackAgentWorkflowApi {
  return {
    listBoards: vi.fn().mockResolvedValue([]),
    getBoardDefinition: vi.fn().mockResolvedValue({ definition: { name: "Board", lanes: [] } }),
    listSlackAgentInstances: vi.fn().mockResolvedValue({ instances: [] }),
    createSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    updateSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    disableSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    enableSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    deleteSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    simulateSlackMention: vi.fn().mockResolvedValue({
      runId: "run-1",
      ticketId: "ticket-1",
      statusMessageId: "msg-status-1",
      duplicate: false,
      state: "accepted",
    }),
    getSlackAgentRun: vi.fn().mockResolvedValue({}),
    subscribeSlackAgentRun: vi.fn(() => () => undefined),
    retrySlackAgentDelivery: vi.fn().mockResolvedValue({}),
    subscribeMockSlackThread: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("SlackAgentInstancesPanel", () => {
  it("retries an accepted head first, otherwise the newest failed update", () => {
    expect(
      retryableFailedSlackDeliveryId([
        { deliveryId: "delivery-7", workflowSequence: 7, state: "failed" },
        { deliveryId: "delivery-0", workflowSequence: 0, state: "failed" },
      ] as never),
    ).toBe("delivery-0");
    expect(
      retryableFailedSlackDeliveryId([
        { deliveryId: "delivery-1", workflowSequence: 1, state: "failed" },
        { deliveryId: "delivery-2", workflowSequence: 2, state: "failed" },
      ] as never),
    ).toBe("delivery-2");
    expect(
      retryableFailedSlackDeliveryId([
        { deliveryId: "delivery-1", workflowSequence: 1, state: "delivered" },
      ] as never),
    ).toBeNull();
  });

  it("only offers hard delete after the instance is disabled and has no active runs", () => {
    const base = {
      enabled: false,
      activeRunCount: 0,
    } as SlackAgentInstanceView;

    expect(canDeleteSlackAgentInstance(base)).toBe(true);
    expect(canDeleteSlackAgentInstance({ ...base, enabled: true })).toBe(false);
    expect(canDeleteSlackAgentInstance({ ...base, activeRunCount: 1 })).toBe(false);
    expect(
      canDeleteSlackAgentInstance({
        ...base,
        latestRun: { runId: "run-1" },
      } as SlackAgentInstanceView),
    ).toBe(false);
  });

  it("labels the settings page as a mock that does not connect to Slack", () => {
    const markup = renderToStaticMarkup(<SlackAgentInstancesPanel api={api()} />);

    expect(markup).toContain("Personal Slack agents");
    expect(markup).toContain("Mock");
    expect(markup).toContain("does not connect to slack.com");
    expect(markup).toContain("No mock Slack agents yet");
  });

  it("shows setup diagnostics and retry/delete controls for loaded instances", () => {
    const markup = renderToStaticMarkup(
      <SlackAgentInstancesPanel
        api={api()}
        initialInstances={[
          {
            instanceId: "instance-1",
            handle: "t3_chris",
            ownerLabel: "Chris",
            botUserId: "U123",
            enabled: true,
            state: "needs_setup",
            validation: {
              valid: false,
              reason: "No automatic path reaches Open PR.",
              path: ["GitHub flow", "Implement", "Open PR"],
            },
            target: {
              projectId: "project-1",
              boardId: "board-1",
              initialLane: "implement",
            },
            activeRunCount: 0,
            latestRun: {
              runId: "run-1",
              state: "failed",
              ticketId: "ticket-1",
              updatedAt: "2026-08-07T00:00:00.000Z",
              prUrl: "https://github.com/pingdotgg/t3code/pull/1",
            },
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z",
          } as unknown as SlackAgentInstanceView,
        ]}
      />,
    );

    expect(markup).toContain("@t3_chris");
    expect(markup).toContain("Needs setup");
    expect(markup).toContain("GitHub flow / Implement / Open PR");
    expect(markup).toContain("Delete");
  });
});
