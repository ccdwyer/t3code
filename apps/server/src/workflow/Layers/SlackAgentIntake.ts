import {
  MockSlackMessageId,
  SlackAgentDisabledInstanceError,
  SlackAgentInvalidTargetError,
  SlackAgentOversizedSnapshotError,
  SlackAgentRunId,
  type SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import {
  SlackAgentIntake,
  type SlackAgentIntakeResult,
  type SlackAgentIntakeShape,
  type SlackAgentMentionInput,
} from "../Services/SlackAgentIntake.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentRunStore, type SlackAgentRunStatus } from "../Services/SlackAgentRunStore.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { validateSlackAgentTarget } from "../slack/slackAgentTargetValidator.ts";
import { sha256Hex } from "../workflowVersionHash.ts";

const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;

const triggerRequest = (input: SlackAgentMentionInput) =>
  input.messages.find((message) => message.messageId === input.triggerMessageId);

const requestWithoutMention = (text: string) =>
  text
    .replace(/<@[^>]+>/g, " ")
    .replace(/@t3_[a-z0-9_]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export const deriveSlackTicketFields = (input: SlackAgentMentionInput) => {
  const trigger = triggerRequest(input);
  const request = requestWithoutMention(trigger?.text ?? "");
  const title = clip(request === "" ? "Slack request" : request, MAX_TITLE_CHARS);
  const source = [
    `Slack request from ${trigger?.authorLabel ?? "unknown user"}:`,
    "",
    trigger?.text.trim() || "(empty request)",
    "",
    `Source: mock Slack #${input.thread.channelName}, thread ${input.thread.threadTs}`,
    "The complete immutable thread snapshot is available in SOURCE_SLACK.md during agent steps.",
  ].join("\n");
  return { title, description: clip(source, MAX_DESCRIPTION_CHARS) };
};

export const slackAgentStateForAdmissionOutcome = (
  outcome: "moved" | "queued" | "none",
): SlackAgentRunStatus => {
  switch (outcome) {
    case "moved":
      return "running";
    case "queued":
      return "queued";
    case "none":
      return "accepted";
  }
};

const statusMessageIdFor = (runId: string) => MockSlackMessageId.make(`mock-status-${runId}`);

const duplicateResult = (run: SlackAgentRunSummaryView): SlackAgentIntakeResult => ({
  run,
  duplicate: true,
  statusMessageId: run.statusMessageId ?? statusMessageIdFor(run.runId),
  message: `This mock thread was already accepted by @${run.handle}. The later trigger was not added to the winning immutable snapshot.`,
});

const mergeLaterDuplicateIntoMockThread = (
  gateway: SlackAgentGateway["Service"],
  input: SlackAgentMentionInput,
) => {
  const trigger = triggerRequest(input);
  if (trigger === undefined) return Effect.void;
  return gateway
    .snapshotThreadThroughTrigger({
      workspaceId: input.thread.workspaceId,
      channelId: input.thread.channelId,
      channelName: input.thread.channelName,
      threadTs: input.thread.threadTs,
      triggerEventId: input.externalEventId,
      triggerTs: trigger.ts,
      triggerMessageId: trigger.messageId,
      messages: input.messages,
    })
    .pipe(Effect.ignore);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* SlackAgentInstanceStore;
  const runs = yield* SlackAgentRunStore;
  const gateway = yield* SlackAgentGateway;
  const engine = yield* WorkflowEngine;
  const committer = yield* WorkflowEventCommitter;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const ids = yield* WorkflowIds;
  const registry = yield* BoardRegistry;
  const readModel = yield* WorkflowReadModel;

  const acceptMention: SlackAgentIntakeShape["acceptMention"] = (input) =>
    Effect.gen(function* () {
      const instance = yield* instances.getEnabledByBotUserId(
        input.thread.workspaceId,
        input.botUserId,
      );
      if (instance === null || instance.instanceId !== input.instanceId || !instance.enabled) {
        return yield* new SlackAgentDisabledInstanceError({
          instanceId: input.instanceId,
          message: "This Slack agent instance is disabled or unavailable.",
        });
      }

      const board = yield* readModel.getBoard(instance.target.boardId);
      if (board === null || board.projectId !== instance.target.projectId) {
        return yield* new SlackAgentInvalidTargetError({
          message:
            board === null
              ? `Workflow board "${instance.target.boardId}" was not found.`
              : `Workflow board "${instance.target.boardId}" does not belong to project "${instance.target.projectId}".`,
        });
      }

      const validation = yield* validateSlackAgentTarget({
        boardId: instance.target.boardId,
        initialLane: instance.target.initialLane,
      }).pipe(Effect.provideService(BoardRegistry, registry));
      if (!validation.valid) {
        return yield* new SlackAgentInvalidTargetError({
          message: validation.message,
          ...(validation.path.length === 0
            ? {}
            : { path: validation.path.map((lane) => String(lane)) }),
        });
      }

      // Fast idempotency path before gateway work. The locked/in-transaction
      // checks below remain authoritative for races, but this path is essential
      // for a later mention in an already-accepted thread: the winning immutable
      // snapshot intentionally does not contain that later trigger message.
      const existingByEvent = yield* runs.findByExternalEvent(
        instance.instanceId,
        input.externalEventId,
      );
      if (existingByEvent !== null) return duplicateResult(existingByEvent);
      const existingByThread = yield* runs.findBySourceThread(
        instance.instanceId,
        input.thread.workspaceId,
        input.thread.channelId,
        input.thread.threadTs,
      );
      if (existingByThread !== null) {
        yield* mergeLaterDuplicateIntoMockThread(gateway, input);
        return duplicateResult(existingByThread);
      }

      const trigger = triggerRequest(input);
      if (trigger === undefined) {
        return yield* new SlackAgentInvalidTargetError({
          message: `Trigger message ${input.triggerMessageId} is not present in the mock thread.`,
        });
      }

      const snapshot = yield* gateway
        .snapshotThreadThroughTrigger({
          workspaceId: input.thread.workspaceId,
          channelId: input.thread.channelId,
          channelName: input.thread.channelName,
          threadTs: input.thread.threadTs,
          triggerEventId: input.externalEventId,
          triggerTs: trigger.ts,
          triggerMessageId: trigger.messageId,
          messages: input.messages,
        })
        .pipe(
          Effect.mapError((error) => {
            if (
              error._tag !== "SlackThreadSnapshotError" ||
              (error.reason !== "too_many_messages" && error.reason !== "snapshot_too_large")
            ) {
              return error;
            }
            return new SlackAgentOversizedSnapshotError({
              messageCount: error.messageCount ?? input.messages.length,
              canonicalJsonBytes: error.canonicalJsonBytes ?? 0,
              message: error.message,
            });
          }),
        );

      const fields = deriveSlackTicketFields(input);
      const threadKey =
        input.thread.threadKey ??
        `${input.thread.workspaceId}:${input.thread.channelId}:${input.thread.threadTs}`;

      const accepted = yield* engine.withBoardAdmissionLock(
        instance.target.boardId,
        saveLocks.withSaveLock(
          instance.target.boardId,
          sql
            .withTransaction(
              Effect.gen(function* () {
                const byEvent = yield* runs.findByExternalEvent(
                  instance.instanceId,
                  input.externalEventId,
                );
                if (byEvent !== null) return duplicateResult(byEvent);

                const byThread = yield* runs.findBySourceThread(
                  instance.instanceId,
                  input.thread.workspaceId,
                  input.thread.channelId,
                  input.thread.threadTs,
                );
                if (byThread !== null) return duplicateResult(byThread);

                const created = yield* engine.createTicketAndEnterUnlocked({
                  boardId: instance.target.boardId,
                  title: fields.title,
                  description: fields.description,
                  destinationLane: instance.target.initialLane,
                });
                const runId = SlackAgentRunId.make(`slackrun-${yield* ids.mappingId()}`);
                const state = slackAgentStateForAdmissionOutcome(created.outcome);
                const statusMessageId = statusMessageIdFor(runId);
                const acceptedText =
                  state === "running"
                    ? "Accepted and started work."
                    : state === "queued"
                      ? "Accepted and queued by the workflow concurrency limit."
                      : "Accepted for workflow processing.";
                const responseText = [
                  `Accepted by @${instance.handle}`,
                  `Ticket: t3://ticket/${created.ticketId}`,
                  `Plan: ${[...validation.path.map(String), validation.pullRequestStepKey].join(" → ")}`,
                  acceptedText,
                ].join("\n");
                const acceptedPayloadJson = encodeJson({
                  runId,
                  ticketId: created.ticketId,
                  workflowSequence: 0,
                  status: state,
                  kind: "accepted",
                  headline: fields.title,
                  body: responseText,
                  text: responseText,
                });
                const run = yield* runs.createRunWithAcceptedDelivery({
                  runId,
                  instanceId: instance.instanceId,
                  externalEventId: input.externalEventId,
                  workspaceId: input.thread.workspaceId,
                  channelId: input.thread.channelId,
                  channelName: input.thread.channelName,
                  threadKey,
                  threadTs: input.thread.threadTs,
                  triggerTs: trigger.ts,
                  snapshotJson: snapshot.canonicalJson,
                  snapshotSha256: sha256Hex(snapshot.canonicalJson),
                  snapshotBytes: snapshot.byteLength,
                  ticketId: created.ticketId,
                  status: state,
                  acceptedPayloadJson,
                });
                return { run, duplicate: false, statusMessageId } satisfies SlackAgentIntakeResult;
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  new WorkflowEventStoreError({
                    message: "SlackAgentIntake.transaction failed",
                    cause,
                  }),
                ),
              ),
            ),
        ),
      );

      if (accepted.duplicate) {
        yield* mergeLaterDuplicateIntoMockThread(gateway, input);
      } else {
        yield* committer
          .publishTicketView(accepted.run.ticketId)
          .pipe(Effect.catch(() => Effect.void));
        yield* engine.recoverBoardWip(instance.target.boardId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("SlackAgentIntake.recoverBoardWip failed post-commit", {
              boardId: instance.target.boardId,
              cause,
            }),
          ),
        );
      }

      return accepted;
    });

  return { acceptMention } satisfies SlackAgentIntakeShape;
});

export const SlackAgentIntakeLive = Layer.effect(SlackAgentIntake, make);
