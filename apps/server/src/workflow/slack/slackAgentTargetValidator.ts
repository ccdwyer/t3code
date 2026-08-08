import type { BoardId, LaneKey, ProjectId, WorkflowLane, WorkflowStep } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";

export type SlackAgentTargetInvalidReason =
  | "board_not_found"
  | "board_project_mismatch"
  | "initial_lane_missing"
  | "initial_lane_not_auto"
  | "manual_lane"
  | "terminal_lane"
  | "missing_target"
  | "parked_route"
  | "conditional_only_route"
  | "cycle"
  | "no_success_route"
  | "pull_request_before_agent"
  | "no_agent_before_pull_request";

export type SlackAgentTargetValidationResult =
  | {
      readonly valid: true;
      readonly boardId: BoardId;
      readonly initialLane: LaneKey;
      readonly path: ReadonlyArray<LaneKey>;
      readonly agentStepSeen: true;
      readonly pullRequestStepKey: string;
    }
  | {
      readonly valid: false;
      readonly boardId: BoardId;
      readonly initialLane: LaneKey;
      readonly path: ReadonlyArray<LaneKey>;
      readonly reason: SlackAgentTargetInvalidReason;
      readonly message: string;
    };

export interface SlackAgentTargetValidationInput {
  readonly boardId: BoardId;
  readonly initialLane: LaneKey;
}

export interface SlackAgentProjectTargetValidationInput extends SlackAgentTargetValidationInput {
  readonly projectId: ProjectId;
}

const stepSeesAgent = (step: WorkflowStep) => step.type === "agent";

const stepOpensPullRequest = (step: WorkflowStep) =>
  step.type === "pullRequest" && step.action === "open";

const invalid = (
  input: SlackAgentTargetValidationInput,
  path: ReadonlyArray<LaneKey>,
  reason: SlackAgentTargetInvalidReason,
  message: string,
): SlackAgentTargetValidationResult => ({
  valid: false,
  boardId: input.boardId,
  initialLane: input.initialLane,
  path,
  reason,
  message,
});

const successTarget = (lane: WorkflowLane): LaneKey | "park" | null => {
  const target = lane.on?.success;
  if (target === undefined) return null;
  if (typeof target !== "string") return "park";
  return target;
};

export const validateSlackAgentTarget = Effect.fn("validateSlackAgentTarget")(function* (
  input: SlackAgentTargetValidationInput,
) {
  const registry = yield* BoardRegistry;
  const definition = yield* registry.getDefinition(input.boardId);
  if (definition === null) {
    return invalid(
      input,
      [],
      "board_not_found",
      `Workflow board "${input.boardId}" was not found.`,
    );
  }

  const lanes = new Map(definition.lanes.map((lane) => [lane.key, lane]));
  const initial = lanes.get(input.initialLane);
  if (initial === undefined) {
    return invalid(
      input,
      [],
      "initial_lane_missing",
      `Initial lane "${input.initialLane}" was not found.`,
    );
  }
  if (initial.entry !== "auto") {
    return invalid(
      input,
      [initial.key],
      "initial_lane_not_auto",
      `Initial lane "${initial.key}" is not automatic.`,
    );
  }

  const visited = new Set<LaneKey>();
  const path: Array<LaneKey> = [];
  let current: WorkflowLane | undefined = initial;
  let agentStepSeen = false;

  while (current !== undefined) {
    if (visited.has(current.key)) {
      return invalid(input, [...path, current.key], "cycle", "Success route cycles before a PR.");
    }
    visited.add(current.key);
    path.push(current.key);

    if (current.entry !== "auto") {
      return invalid(
        input,
        path,
        "manual_lane",
        `Lane "${current.key}" is manual before the PR step.`,
      );
    }
    if (current.terminal === true) {
      return invalid(
        input,
        path,
        "terminal_lane",
        `Lane "${current.key}" is terminal before the PR step.`,
      );
    }

    for (const step of current.pipeline ?? []) {
      if (stepSeesAgent(step)) agentStepSeen = true;
      if (stepOpensPullRequest(step)) {
        if (!agentStepSeen) {
          return invalid(
            input,
            path,
            "pull_request_before_agent",
            "The PR open step appears before any agent step.",
          );
        }
        return {
          valid: true,
          boardId: input.boardId,
          initialLane: input.initialLane,
          path,
          agentStepSeen: true,
          pullRequestStepKey: String(step.key),
        } satisfies SlackAgentTargetValidationResult;
      }
    }

    const target = successTarget(current);
    if (target === "park") {
      return invalid(input, path, "parked_route", `Lane "${current.key}" parks on success.`);
    }
    if (target === null) {
      if ((current.transitions?.length ?? 0) > 0) {
        return invalid(
          input,
          path,
          "conditional_only_route",
          `Lane "${current.key}" has no literal success route.`,
        );
      }
      return invalid(
        input,
        path,
        "no_success_route",
        `Lane "${current.key}" has no success route to a PR lane.`,
      );
    }

    const next = lanes.get(target);
    if (next === undefined) {
      return invalid(input, [...path, target], "missing_target", `Lane "${target}" was not found.`);
    }
    current = next;
  }

  return invalid(input, path, "no_agent_before_pull_request", "No agent-before-PR route found.");
});

export const validateSlackAgentTargetForProject = Effect.fn("validateSlackAgentTargetForProject")(
  function* (input: SlackAgentProjectTargetValidationInput) {
    const readModel = yield* WorkflowReadModel;
    const board = yield* readModel.getBoard(input.boardId);
    if (board === null) {
      return invalid(
        input,
        [],
        "board_not_found",
        `Workflow board "${input.boardId}" was not found.`,
      );
    }
    if (board.projectId !== input.projectId) {
      return invalid(
        input,
        [],
        "board_project_mismatch",
        `Workflow board "${input.boardId}" does not belong to project "${input.projectId}".`,
      );
    }
    return yield* validateSlackAgentTarget({
      boardId: input.boardId,
      initialLane: input.initialLane,
    });
  },
);
