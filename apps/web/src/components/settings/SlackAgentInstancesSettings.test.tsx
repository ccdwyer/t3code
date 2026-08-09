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
  buildSlackAgentEditTarget,
  canDeleteSlackAgentInstance,
  retryableFailedSlackDeliveryId,
  selectSlackAgentDefaultProject,
  SlackAgentInstancesPanel,
} from "./SlackAgentInstancesSettings";
import type { SlackAgentInstanceView, SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";

function api(overrides: Partial<SlackAgentWorkflowApi> = {}): SlackAgentWorkflowApi {
  return {
    listBoards: vi.fn().mockResolvedValue([]),
    getBoardDefinition: vi.fn().mockResolvedValue({ definition: { name: "Board", lanes: [] } }),
    listSlackAgentInstances: vi.fn().mockResolvedValue({ instances: [] }),
    createSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    createMockSlackAgentInstance: vi.fn().mockResolvedValue({
      instance: { instanceId: "mock-instance-1" },
    }),
    connectSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    disconnectSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    testSlackAgentConnection: vi.fn().mockResolvedValue({
      ok: true,
      instance: {},
    }),
    updateSlackAgentInstance: vi.fn().mockResolvedValue({ instanceId: "instance-1" }),
    disableSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    enableSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    deleteSlackAgentInstance: vi.fn().mockResolvedValue(undefined),
    simulateSlackMention: vi.fn().mockResolvedValue({
      runId: "run-1",
      mode: "chat",
      threadId: "thread-1",
      ticketId: "ticket-1",
      statusMessageId: "msg-status-1",
      duplicate: false,
      createdThread: true,
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

  it("builds edit payload with linked projects and a selected default", () => {
    expect(
      buildSlackAgentEditTarget({
        projectIds: ["project-a", "project-b"],
        defaultProjectId: "project-b",
        projects: [
          { id: "project-a", title: "T3 Code" },
          { id: "project-b", title: "T3 Code" },
        ],
      }),
    ).toEqual({
      projectId: "project-b",
      projects: [
        { projectId: "project-a", selector: "t3-code" },
        { projectId: "project-b", selector: "t3-code-2" },
      ],
    });
  });

  it("links a project automatically when it is selected as the default", () => {
    expect(
      selectSlackAgentDefaultProject({
        projectIds: ["project-a"],
        defaultProjectId: "project-b",
      }),
    ).toEqual({
      projectIds: ["project-a", "project-b"],
      defaultProjectId: "project-b",
    });

    expect(
      selectSlackAgentDefaultProject({
        projectIds: ["project-a", "project-b"],
        defaultProjectId: "project-b",
      }),
    ).toEqual({
      projectIds: ["project-a", "project-b"],
      defaultProjectId: "project-b",
    });
  });

  it("labels the settings page as real Slack app identities", () => {
    const markup = renderToStaticMarkup(<SlackAgentInstancesPanel api={api()} />);

    expect(markup).toContain("Personal Slack app identities");
    expect(markup).toContain("Socket Mode");
    expect(markup).toContain("No Slack identities yet");
    expect(markup).not.toContain("does not connect to slack.com");
  });

  it("explains branch-preserving Slack checkout cleanup", () => {
    const markup = renderToStaticMarkup(
      <SlackAgentInstancesPanel
        api={api()}
        worktreeRetentionConfig={{ days: 14, onChange: vi.fn() }}
      />,
    );

    expect(markup).toContain("Worktree cleanup");
    expect(markup).toContain("14 days");
    expect(markup).toContain("chat branch is kept");
    expect(markup).toContain("dirty or in-use checkouts are never removed");
  });

  it("shows workspace, project, connection state, instructions, and row actions", () => {
    const markup = renderToStaticMarkup(
      <SlackAgentInstancesPanel
        api={api()}
        projects={[
          { id: "project-1", title: "Cellar Tracker" },
          { id: "project-2", title: "API" },
        ]}
        initialInstances={[
          {
            instanceId: "instance-1",
            kind: "slack",
            handle: "t3_chris",
            ownerLabel: "Chris",
            botUserId: "U123",
            enabled: true,
            state: "enabled",
            validation: {
              valid: true,
              path: ["Cellar Tracker"],
            },
            target: {
              projectId: "project-1",
              projects: [
                { projectId: "project-1", selector: "cellar-tracker" },
                { projectId: "project-2", selector: "api" },
              ],
            },
            workspace: {
              workspaceId: "T123",
              name: "Acme Slack",
            },
            connection: {
              state: "connected",
            },
            credentialsConfigured: true,
            activeRunCount: 0,
            latestRun: {
              runId: "run-1",
              mode: "workflow",
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
    expect(markup).toContain("Ready");
    expect(markup).toContain("Acme Slack");
    expect(markup).toContain("Defaults for new Slack chats");
    expect(markup).toContain("Project: Cellar Tracker");
    expect(markup).toContain("Model: Project default");
    expect(markup).toContain("2 linked projects");
    expect(markup).toContain("Socket connected");
    expect(markup).toContain("Credentials configured");
    expect(markup).toContain("Diagnostic path: Cellar Tracker");
    expect(markup).toContain("Test");
    expect(markup).toContain("Edit defaults");
    expect(markup).toContain("Rotate/reconnect tokens");
    expect(markup).toContain("Disconnect");
    expect(markup).toContain("Delete");
    expect(markup).toContain("Channel instructions");
    expect(markup).toContain("project:api");
  });

  it("renders a legacy target as one linked default project", () => {
    const markup = renderToStaticMarkup(
      <SlackAgentInstancesPanel
        api={api()}
        projects={[{ id: "project-legacy", title: "Legacy App" }]}
        initialInstances={[
          {
            instanceId: "instance-legacy",
            kind: "slack",
            handle: "t3_legacy",
            ownerLabel: "Legacy",
            botUserId: "U123",
            enabled: true,
            state: "enabled",
            validation: { valid: true },
            target: {
              projectId: "project-legacy",
            },
            workspace: {
              workspaceId: "T123",
              name: "Acme Slack",
            },
            connection: {
              state: "connected",
            },
            credentialsConfigured: true,
            activeRunCount: 0,
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z",
          } as unknown as SlackAgentInstanceView,
        ]}
      />,
    );

    expect(markup).toContain("Project: Legacy App");
    expect(markup).toContain("1 linked project");
    expect(markup).toContain("Omit a selector to use the default project.");
  });

  it("does not mark a real Slack identity ready without a connected Socket Mode session", () => {
    const baseInstance = {
      instanceId: "instance-1",
      kind: "slack",
      handle: "t3_chris",
      ownerLabel: "Chris",
      botUserId: "U123",
      enabled: true,
      state: "enabled",
      validation: {
        valid: true,
      },
      target: {
        projectId: "project-1",
      },
      workspace: {
        workspaceId: "T123",
        name: "Acme Slack",
      },
      credentialsConfigured: true,
      activeRunCount: 0,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    } as unknown as Omit<SlackAgentInstanceView, "connection">;

    const markup = renderToStaticMarkup(
      <SlackAgentInstancesPanel
        api={api()}
        projects={[{ id: "project-1", title: "Cellar Tracker" }]}
        initialInstances={[
          {
            ...baseInstance,
            connection: { state: "connecting" },
          },
          {
            ...baseInstance,
            instanceId: "instance-2" as never,
            handle: "t3_alex" as never,
            connection: { state: "disconnected" },
          },
          {
            ...baseInstance,
            instanceId: "instance-3" as never,
            handle: "t3_sam" as never,
            connection: { state: "error", lastError: "invalid_auth" },
          },
        ]}
      />,
    );

    expect(markup).toContain("Connecting");
    expect(markup).toContain("Disconnected");
    expect(markup).toContain("Error");
    expect(markup).toContain("Connection error: invalid_auth");
  });
});
