import "../../index.css";

import { MessageId, ProjectId, TicketId, type EnvironmentApi } from "@t3tools/contracts";
import type { ComponentType } from "react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  TicketDrawer,
  type TicketDrawerAnswerInput,
  type TicketDrawerEditInput,
} from "./TicketDrawer";

function createApi() {
  return {
    terminal: {
      attachHistory: vi.fn(
        (
          _input: { readonly threadId: string; readonly terminalId: string },
          listener: (event: unknown) => void,
        ) => {
          listener({
            type: "snapshot",
            snapshot: {
              threadId: "script-thread-1",
              terminalId: "script-terminal-1",
              history: "running tests\n",
              status: "running",
            },
          });
          return vi.fn();
        },
      ),
    },
    workflow: {
      answerTicketStep: vi.fn(async () => undefined),
      editTicket: vi.fn(async () => undefined),
      cancelStep: vi.fn(async () => undefined),
      setProjectScriptTrust: vi.fn(async () => undefined),
      getTicketDiff: vi.fn(async () => ({
        ticketId: TicketId.make("ticket-1"),
        baseRef: "refs/workflow/tickets/ticket-1/base",
        patch: "",
        files: [],
        truncated: false,
      })),
    },
  } as unknown as EnvironmentApi;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const detail = {
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
} as const;

describe("TicketDrawer script controls", () => {
  it("cancels running scripts and trusts blocked projects before rerunning the lane", async () => {
    const api = createApi();
    const onRunLane = vi.fn();
    const Drawer = TicketDrawer as ComponentType<
      Parameters<typeof TicketDrawer>[0] & { readonly projectId: ProjectId }
    >;

    await render(
      <Drawer
        api={api}
        projectId={ProjectId.make("project-1")}
        detail={detail}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 2 }]}
        onApprove={async () => undefined}
        onRunLane={onRunLane}
      />,
    );

    await expect.element(page.getByText("running tests")).toBeInTheDocument();

    await page.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.cancelStep).toHaveBeenCalledWith({ stepRunId: "step-running" });
    });

    await page.getByRole("button", { name: "Trust this project & run" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.setProjectScriptTrust).toHaveBeenCalledWith({
        projectId: ProjectId.make("project-1"),
        trusted: true,
      });
      expect(onRunLane).toHaveBeenCalledOnce();
    });
  });

  it("edits ticket metadata and submits a text plus image reply to an awaiting agent step", async () => {
    const api = createApi();
    const onAnswerStep = vi.fn(async (_input: TicketDrawerAnswerInput) => undefined);
    const onEditTicket = vi.fn(async (_input: TicketDrawerEditInput) => undefined);

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Review release blockers",
            description: "Confirm old clients still parse the websocket payload.",
            currentLaneKey: "review",
            status: "waiting_on_user",
          },
          steps: [
            {
              stepRunId: "step-awaiting",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Need compatibility guidance",
              providerResponseKind: "user-input",
            },
          ],
          messages: [
            {
              messageId: MessageId.make("message-agent"),
              ticketId: "ticket-1",
              stepRunId: "step-awaiting",
              author: "agent",
              body: "Should the guard accept the legacy shape?",
              attachments: [],
              createdAt: "2026-06-08T14:00:00.000Z",
            },
          ],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 1 }]}
        onApprove={async () => undefined}
        onAnswerStep={onAnswerStep}
        onEditTicket={onEditTicket}
        onRunLane={() => undefined}
      />,
    );

    await expect.element(page.getByText("Should the guard accept the legacy shape?")).toBeVisible();
    await expect
      .element(page.getByText("Confirm old clients still parse the websocket payload."))
      .toBeVisible();

    await page.getByRole("button", { name: "Edit ticket" }).click();
    await page.getByLabelText("Ticket title").fill("Updated blockers");
    await page.getByLabelText("Ticket description").fill("Preserve legacy websocket parsing.");
    await page.getByRole("button", { name: "Save ticket" }).click();

    await vi.waitFor(() => {
      expect(onEditTicket).toHaveBeenCalledWith({
        ticketId: "ticket-1",
        title: "Updated blockers",
        description: "Preserve legacy websocket parsing.",
      });
    });

    await page.getByLabelText("Ticket reply").fill("Yes, accept both shapes.");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    if (!fileInput) {
      throw new Error("Expected an image attachment input.");
    }
    const file = new File(["png"], "payload.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByText("payload.png")).toBeVisible();

    await page.getByRole("button", { name: "Send reply" }).click();

    await vi.waitFor(() => {
      expect(onAnswerStep).toHaveBeenCalledOnce();
      const input = onAnswerStep.mock.calls[0]?.[0];
      expect(input).toBeDefined();
      if (!input) {
        throw new Error("Expected answer input.");
      }
      const attachments = input.attachments ?? [];
      expect(input).toMatchObject({
        stepRunId: "step-awaiting",
        text: "Yes, accept both shapes.",
      });
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        kind: "image",
        name: "payload.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
      const attachment = attachments[0];
      expect(attachment?.kind).toBe("image");
      if (!attachment || attachment.kind !== "image") {
        throw new Error("Expected an image attachment.");
      }
      expect(attachment.dataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });

  it("disables the reply composer while sending and surfaces send failures", async () => {
    const api = createApi();
    const sendResult = createDeferred<void>();
    const onAnswerStep = vi.fn((_input: TicketDrawerAnswerInput) => sendResult.promise);

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Review release blockers",
            currentLaneKey: "review",
            status: "waiting_on_user",
          },
          steps: [
            {
              stepRunId: "step-awaiting",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Need compatibility guidance",
              providerResponseKind: "user-input",
            },
          ],
          messages: [],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 1 }]}
        onApprove={async () => undefined}
        onAnswerStep={onAnswerStep}
        onRunLane={() => undefined}
      />,
    );

    const replyInput = page.getByLabelText("Ticket reply");
    const sendButton = page.getByRole("button", { name: "Send reply" });

    await replyInput.fill("Keep the compatibility guard.");
    await sendButton.click();

    await vi.waitFor(() => {
      expect(onAnswerStep).toHaveBeenCalledOnce();
    });
    await expect.element(replyInput).toBeDisabled();
    await expect.element(sendButton).toBeDisabled();

    sendResult.reject(new Error("RPC failed"));

    await expect.element(page.getByText("RPC failed")).toBeVisible();
    await expect.element(replyInput).toBeEnabled();
    await expect.element(sendButton).toBeEnabled();
    expect(onAnswerStep).toHaveBeenCalledOnce();
  });

  it("disables approval actions while pending and surfaces approval failures", async () => {
    const api = createApi();
    const approvalResult = createDeferred<void>();
    const onApprove = vi.fn((_stepRunId: string, _approved: boolean) => approvalResult.promise);

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Review release blockers",
            currentLaneKey: "review",
            status: "waiting_on_user",
          },
          steps: [
            {
              stepRunId: "step-approval",
              stepKey: "agent-approval",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Approve the provider request?",
              providerResponseKind: "request",
            },
          ],
          messages: [],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 1 }]}
        onApprove={onApprove}
        onRunLane={() => undefined}
      />,
    );

    const approveButton = page.getByRole("button", { name: "Approve" });
    const rejectButton = page.getByRole("button", { name: "Reject" });

    await approveButton.click();

    await vi.waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith("step-approval", true);
    });
    await expect.element(approveButton).toBeDisabled();
    await expect.element(rejectButton).toBeDisabled();

    approvalResult.reject(new Error("Approval RPC failed"));

    await expect.element(page.getByText("Approval RPC failed")).toBeVisible();
    await expect.element(approveButton).toBeEnabled();
    await expect.element(rejectButton).toBeEnabled();
    expect(onApprove).toHaveBeenCalledOnce();
  });
});

describe("TicketDrawer comments", () => {
  it("posts a comment when no step is awaiting input", async () => {
    const api = createApi();
    const onPostComment = vi.fn(async (_input: unknown) => undefined);

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-quiet",
            boardId: "board-1",
            title: "Quiet ticket",
            currentLaneKey: "backlog",
            status: "idle",
          },
          steps: [],
          messages: [],
        }}
        lanes={[{ key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0 }]}
        onApprove={async () => undefined}
        onPostComment={onPostComment}
        onRunLane={() => undefined}
      />,
    );

    await expect.element(page.getByText(/No discussion yet/)).toBeVisible();
    await page.getByLabelText("Add a comment").fill("Remember to check the auth flow.");
    await page.getByRole("button", { name: "Comment" }).click();

    await vi.waitFor(() => {
      expect(onPostComment).toHaveBeenCalledWith({
        ticketId: "ticket-quiet",
        text: "Remember to check the auth flow.",
      });
    });
  });
});

describe("TicketDrawer PR row", () => {
  it("renders the PR link with href/target/rel plus state and CI badges when pr is present", async () => {
    const api = createApi();

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-pr",
            boardId: "board-1",
            title: "Ship the PR loop",
            currentLaneKey: "review",
            status: "running",
            pr: {
              number: 4242,
              url: "https://github.com/org/repo/pull/4242",
              state: "open",
              ciState: "success",
            },
          },
          steps: [],
          messages: [],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 }]}
        onApprove={async () => undefined}
        onRunLane={() => undefined}
      />,
    );

    await expect.element(page.getByTestId("ticket-pr-row")).toBeVisible();

    const link = page.getByTestId("ticket-pr-link");
    await expect.element(link).toBeVisible();
    const linkElement = link.element() as HTMLAnchorElement;
    expect(linkElement.getAttribute("href")).toBe("https://github.com/org/repo/pull/4242");
    expect(linkElement.getAttribute("target")).toBe("_blank");
    expect(linkElement.getAttribute("rel")).toBe("noopener noreferrer");
    expect(linkElement.textContent).toContain("#4242");

    await expect.element(page.getByTestId("ticket-pr-state")).toHaveTextContent("open");
    await expect.element(page.getByTestId("ticket-pr-ci-state")).toHaveTextContent("success");
  });

  it("renders no PR row when pr is absent", async () => {
    const api = createApi();

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-no-pr",
            boardId: "board-1",
            title: "No PR yet",
            currentLaneKey: "review",
            status: "idle",
          },
          steps: [],
          messages: [],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 }]}
        onApprove={async () => undefined}
        onRunLane={() => undefined}
      />,
    );

    await expect.element(page.getByText("No PR yet")).toBeVisible();
    expect(document.querySelector('[data-testid="ticket-pr-row"]')).toBeNull();
  });
});

describe("TicketDrawer lane actions", () => {
  it("renders action buttons with target hints and moves the ticket", async () => {
    const api = createApi();
    const onMove = vi.fn();

    await render(
      <TicketDrawer
        api={api}
        detail={{
          ticket: {
            ticketId: "ticket-actions",
            boardId: "board-1",
            title: "Ready ticket",
            currentLaneKey: "owner_review",
            status: "idle",
          },
          steps: [],
          messages: [],
        }}
        lanes={[
          {
            key: "owner_review",
            name: "Owner Review",
            entry: "manual",
            pipelineStepCount: 0,
            actions: [
              {
                label: "Approve & land",
                to: "land",
                hint: "Merge the ticket's work into your branch.",
              },
              { label: "Send back", to: "implementation" },
            ],
          },
          { key: "land", name: "Land", entry: "manual", pipelineStepCount: 1 },
          { key: "implementation", name: "Implementation", entry: "auto", pipelineStepCount: 2 },
        ]}
        onApprove={async () => undefined}
        onMove={onMove}
        onRunLane={() => undefined}
      />,
    );

    await expect.element(page.getByRole("button", { name: /Approve & land/ })).toBeVisible();
    await expect.element(page.getByText("→ Land")).toBeVisible();
    await expect.element(page.getByText("→ Implementation")).toBeVisible();

    await page.getByRole("button", { name: /Approve & land/ }).click();
    expect(onMove).toHaveBeenCalledWith("land");

    await page.getByRole("button", { name: /Send back/ }).click();
    expect(onMove).toHaveBeenCalledWith("implementation");
  });
});
