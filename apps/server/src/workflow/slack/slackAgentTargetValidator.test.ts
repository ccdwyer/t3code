import { assert, it } from "@effect/vitest";
import type { BoardId, LaneKey } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { BoardRegistryLive } from "../Layers/BoardRegistry.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowReadModelLive } from "../Layers/WorkflowReadModel.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  validateSlackAgentTarget,
  validateSlackAgentTargetForProject,
} from "./slackAgentTargetValidator.ts";

const layer = it.layer(BoardRegistryLive);
const projectLayer = it.layer(
  WorkflowReadModelLive.pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const agent = { instance: "codex", model: "gpt-5.5" };
const boardId = (value: string) => value as BoardId;
const laneKey = (value: string) => value as LaneKey;

const validDefinition = {
  name: "Slack PR board",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "implementation",
      name: "Implementation",
      entry: "auto",
      pipeline: [{ key: "agent", type: "agent", agent, instruction: "do it" }],
      on: { success: "open_pr" },
    },
    {
      key: "open_pr",
      name: "Open PR",
      entry: "auto",
      pipeline: [{ key: "open", type: "pullRequest", action: "open" }],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

layer("SlackAgentTargetValidator", (it) => {
  it.effect("accepts an auto lane that runs an agent before opening a pull request", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(boardId("board-1"), validDefinition);

      const result = yield* validateSlackAgentTarget({
        boardId: boardId("board-1"),
        initialLane: laneKey("implementation"),
      });

      if (result.valid !== true) throw new Error(result.message);
      assert.deepEqual(result.path.map(String), ["implementation", "open_pr"]);
    }),
  );

  it.effect("rejects a pull request route that has not first run an agent", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(boardId("board-2"), {
        name: "No agent",
        lanes: [
          {
            key: "open_pr",
            name: "Open PR",
            entry: "auto",
            pipeline: [{ key: "open", type: "pullRequest", action: "open" }],
          },
        ],
      });

      const result = yield* validateSlackAgentTarget({
        boardId: boardId("board-2"),
        initialLane: laneKey("open_pr"),
      });

      if (result.valid !== false) throw new Error("Expected route validation to fail.");
      assert.equal(result.reason, "pull_request_before_agent");
      assert.deepEqual(result.path.map(String), ["open_pr"]);
    }),
  );

  it.effect("rejects manual, parked, conditional-only, missing, and cyclic success paths", () =>
    Effect.gen(function* () {
      const definition = {
        name: "Invalid routes",
        lanes: [
          {
            key: "manual_start",
            name: "Manual",
            entry: "manual",
            on: { success: "open_pr" },
          },
          {
            key: "parks",
            name: "Parks",
            entry: "auto",
            pipeline: [{ key: "agent", type: "agent", agent, instruction: "do it" }],
            on: { success: { park: "waiting", actions: [{ label: "Retry", to: "parks" }] } },
          },
          {
            key: "conditional",
            name: "Conditional",
            entry: "auto",
            pipeline: [{ key: "agent", type: "agent", agent, instruction: "do it" }],
            transitions: [{ when: { "==": [1, 1] }, to: "open_pr" }],
          },
          {
            key: "missing",
            name: "Missing",
            entry: "auto",
            pipeline: [{ key: "agent", type: "agent", agent, instruction: "do it" }],
            on: { success: "ghost" },
          },
          {
            key: "cycle_a",
            name: "Cycle A",
            entry: "auto",
            pipeline: [{ key: "agent", type: "agent", agent, instruction: "do it" }],
            on: { success: "cycle_b" },
          },
          { key: "cycle_b", name: "Cycle B", entry: "auto", on: { success: "cycle_a" } },
          {
            key: "open_pr",
            name: "Open PR",
            entry: "auto",
            pipeline: [{ key: "open", type: "pullRequest", action: "open" }],
          },
        ],
      };
      const registry = BoardRegistry.of({
        register: () => Effect.succeed(definition as never),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition as never),
        listDefinitions: () =>
          Effect.succeed([{ boardId: boardId("board-3"), definition: definition as never }]),
        getLane: (_boardId, laneKey) =>
          Effect.succeed(
            definition.lanes.find((lane) => lane.key === String(laneKey)) ?? null,
          ) as never,
      } satisfies BoardRegistry["Service"]);

      for (const [lane, reason] of [
        ["manual_start", "initial_lane_not_auto"],
        ["parks", "parked_route"],
        ["conditional", "conditional_only_route"],
        ["missing", "missing_target"],
        ["cycle_a", "cycle"],
      ] as const) {
        const result = yield* validateSlackAgentTarget({
          boardId: boardId("board-3"),
          initialLane: laneKey(lane),
        }).pipe(Effect.provideService(BoardRegistry, registry));
        if (result.valid !== false) throw new Error("Expected route validation to fail.");
        assert.equal(result.reason, reason);
      }
    }),
  );
});

projectLayer("SlackAgentTargetValidator project ownership", (it) => {
  it.effect("accepts targets on any registered project in this environment", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const readModel = yield* WorkflowReadModel;
      yield* registry.register(boardId("board-alpha"), validDefinition);
      yield* registry.register(boardId("board-beta"), validDefinition);
      yield* readModel.registerBoard({
        boardId: boardId("board-alpha"),
        projectId: ProjectId.make("project-alpha"),
        name: "Alpha",
        workflowFilePath: ".t3/workflows/alpha.json",
        workflowVersionHash: "alpha",
        maxConcurrentTickets: 1,
      });
      yield* readModel.registerBoard({
        boardId: boardId("board-beta"),
        projectId: ProjectId.make("project-beta"),
        name: "Beta",
        workflowFilePath: ".t3/workflows/beta.json",
        workflowVersionHash: "beta",
        maxConcurrentTickets: 1,
      });

      const alpha = yield* validateSlackAgentTargetForProject({
        projectId: ProjectId.make("project-alpha"),
        boardId: boardId("board-alpha"),
        initialLane: laneKey("implementation"),
      });
      const beta = yield* validateSlackAgentTargetForProject({
        projectId: ProjectId.make("project-beta"),
        boardId: boardId("board-beta"),
        initialLane: laneKey("implementation"),
      });

      assert.equal(alpha.valid, true);
      assert.equal(beta.valid, true);
    }),
  );

  it.effect("rejects a target whose project does not own the board", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const readModel = yield* WorkflowReadModel;
      yield* registry.register(boardId("board-owned-by-beta"), validDefinition);
      yield* readModel.registerBoard({
        boardId: boardId("board-owned-by-beta"),
        projectId: ProjectId.make("project-beta"),
        name: "Beta",
        workflowFilePath: ".t3/workflows/beta.json",
        workflowVersionHash: "beta",
        maxConcurrentTickets: 1,
      });

      const result = yield* validateSlackAgentTargetForProject({
        projectId: ProjectId.make("project-missing"),
        boardId: boardId("board-owned-by-beta"),
        initialLane: laneKey("implementation"),
      });

      if (result.valid !== false) throw new Error("Expected project ownership validation to fail.");
      assert.equal(result.reason, "board_project_mismatch");
      assert.include(result.message, 'does not belong to project "project-missing"');
    }),
  );
});
