import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { ProviderTurnPort, type DispatchRequest } from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader, type TurnState } from "../Services/TurnStateReader.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowIntakeService } from "../Services/WorkflowIntake.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { parseIntakeProposals, WorkflowIntakeLive } from "./WorkflowIntake.ts";

describe("parseIntakeProposals", () => {
  it("keeps valid proposals, drops junk, and caps the list", () => {
    const proposals = parseIntakeProposals({
      tickets: [
        { title: "Fix login", description: "Users get logged out" },
        { title: "   " },
        "not an object",
        { title: "No description" },
        ...Array.from({ length: 30 }, (_, index) => ({ title: `extra ${index}` })),
      ],
    });

    assert.equal(proposals.length, 20);
    assert.deepEqual(proposals[0], { title: "Fix login", description: "Users get logged out" });
    assert.deepEqual(proposals[1], { title: "No description" });
  });

  it("truncates overlong fields instead of failing", () => {
    const proposals = parseIntakeProposals({
      tickets: [{ title: "t".repeat(500), description: "d".repeat(9000) }],
    });
    assert.equal(proposals[0]?.title.length, 200);
    assert.equal(proposals[0]?.description?.length, 4000);
  });

  it("keeps backward dependency indices and drops self/forward/junk", () => {
    const proposals = parseIntakeProposals({
      tickets: [
        { title: "API" },
        { title: "UI", dependsOn: [0] },
        { title: "Docs", dependsOn: [0, 1, 2, 7, -1, "0", 1] },
        { title: "Free", dependsOn: "nope" },
      ],
    });

    assert.equal(proposals[0]?.dependsOn, undefined);
    assert.deepEqual(proposals[1]?.dependsOn, [0]);
    assert.deepEqual(proposals[2]?.dependsOn, [0, 1]);
    assert.equal(proposals[3]?.dependsOn, undefined);
  });

  it("returns nothing for unusable shapes", () => {
    assert.deepEqual(parseIntakeProposals(null), []);
    assert.deepEqual(parseIntakeProposals({ tickets: "nope" }), []);
    assert.deepEqual(parseIntakeProposals([]), []);
  });
});

const baseInput = {
  boardId: "board-intake" as never,
  braindump: "Fix the login flow and add rate limiting",
  agent: { instance: "codex" as never, model: "gpt-5.5" as never },
};

const makeLayer = (options: {
  readonly turnState: TurnState;
  readonly capturedOutput?: unknown;
  readonly onStart?: (req: DispatchRequest) => void;
}) =>
  WorkflowIntakeLive.pipe(
    Layer.provide(
      Layer.succeed(WorkflowReadModel, {
        getBoard: () =>
          Effect.succeed({
            boardId: "board-intake",
            projectId: "project-intake",
            name: "Intake board",
            workflowFilePath: ".t3/boards/intake.json",
            workflowVersionHash: "hash",
            maxConcurrentTickets: 1,
          }),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/project-intake"),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: (req) =>
          Effect.sync(() => {
            options.onStart?.(req);
            return { turnId: "turn-intake" as never };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(TurnStateReader, { read: () => Effect.succeed(options.turnState) }),
    ),
    Layer.provide(
      Layer.succeed(CapturedStepOutputReader, {
        read: () => Effect.succeed(options.capturedOutput),
      }),
    ),
    Layer.provide(
      Layer.succeed(WorkflowIds, {
        eventId: () => Effect.succeed("evt-intake-1" as never),
        ticketId: () => Effect.succeed("ticket-x" as never),
        pipelineRunId: () => Effect.succeed("pipeline-x" as never),
        stepRunId: () => Effect.succeed("step-x" as never),
        laneEntryToken: () => Effect.succeed("token-x" as never),
      } as never),
    ),
  );

describe("WorkflowIntakeService", () => {
  it.effect("dispatches a one-shot turn and returns parsed proposals", () => {
    const starts: DispatchRequest[] = [];
    return Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const proposals = yield* intake.proposeTickets(baseInput);

      assert.deepEqual(proposals, [
        { title: "Fix login", description: "Restore session persistence" },
      ]);
      assert.equal(starts.length, 1);
      const request = starts[0];
      assert.equal(request?.worktreePath, "/tmp/project-intake");
      assert.include(request?.instruction, "Fix the login flow and add rate limiting");
      assert.include(request?.instruction, '"tickets"');
      assert.match(String(request?.ticketId), /^intake-/);
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: { _tag: "completed" },
          capturedOutput: {
            tickets: [{ title: "Fix login", description: "Restore session persistence" }],
          },
          onStart: (req) => starts.push(req),
        }),
      ),
    );
  });

  it.effect("fails when the agent asks a question", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "asked a question");
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: {
            _tag: "awaiting_user",
            waitingReason: "Which auth provider?",
            providerThreadId: "thread-1" as never,
            providerRequestId: "request-1" as never,
            providerResponseKind: "user-input",
          },
        }),
      ),
    ),
  );

  it.effect("fails when the turn fails", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "boom");
    }).pipe(Effect.provide(makeLayer({ turnState: { _tag: "failed", error: "boom" } }))),
  );

  it.effect("fails when no usable proposals come back", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "usable ticket proposals");
    }).pipe(
      Effect.provide(
        makeLayer({ turnState: { _tag: "completed" }, capturedOutput: { tickets: [] } }),
      ),
    ),
  );
});
