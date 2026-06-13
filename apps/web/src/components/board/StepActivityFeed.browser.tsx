import "../../index.css";

import type {
  EnvironmentApi,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { StepActivityFeed } from "./StepActivityFeed";

const threadId = "thread-feed" as ThreadId;

const activity = (id: string, summary: string): OrchestrationThreadActivity =>
  ({
    id: id as never,
    tone: "info",
    kind: "tool.completed",
    summary,
    payload: {},
    turnId: null,
    createdAt: "2026-06-09T00:00:00.000Z",
  }) as OrchestrationThreadActivity;

function makeApi(initialActivities: ReadonlyArray<OrchestrationThreadActivity>) {
  let deliver: ((item: OrchestrationThreadStreamItem) => void) | null = null;
  const api = {
    orchestration: {
      subscribeThread: (
        _input: unknown,
        callback: (item: OrchestrationThreadStreamItem) => void,
      ) => {
        deliver = callback;
        callback({
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            thread: { activities: initialActivities },
          },
        } as OrchestrationThreadStreamItem);
        return () => {
          deliver = null;
        };
      },
    },
  } as unknown as EnvironmentApi;
  return {
    api,
    push: (item: OrchestrationThreadStreamItem) => deliver?.(item),
  };
}

describe("StepActivityFeed", () => {
  it("renders snapshot activities and appends live ones", async () => {
    const harness = makeApi([activity("a1", "Read src/app.ts")]);
    render(<StepActivityFeed api={harness.api} threadId={threadId} live={true} />);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Read src/app.ts");
      expect(document.body.textContent).toContain("Agent activity");
    });

    harness.push({
      kind: "event",
      event: {
        type: "thread.activity-appended",
        payload: { threadId, activity: activity("a2", "Edited src/app.ts") },
      },
    } as OrchestrationThreadStreamItem);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Edited src/app.ts");
    });
  });

  it("renders nothing for an idle step with no activity", async () => {
    const harness = makeApi([]);
    render(<StepActivityFeed api={harness.api} threadId={threadId} live={false} />);

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="step-activity-feed"]')).toBeNull();
    });
  });

  it("shows a waiting hint while live with no activity yet", async () => {
    const harness = makeApi([]);
    render(<StepActivityFeed api={harness.api} threadId={threadId} live={true} />);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Waiting for the agent to start");
    });
  });
});
