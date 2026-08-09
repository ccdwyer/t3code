import {
  CommandId,
  MessageId,
  MockSlackMessageId,
  normalizeSlackAgentTargetProjects,
  type ProjectId,
  SlackAgentDisabledInstanceError,
  SlackAgentInvalidTargetError,
  SlackAgentOversizedSnapshotError,
  SlackAgentRunId,
  ThreadId,
  type SlackAgentInvocation,
  type SlackAgentRunSummaryView,
  type SlackAgentTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SlackChatBridge } from "../../slack/Services/SlackChatBridge.ts";
import { SlackChatReplyRelay } from "../../slack/Services/SlackChatReplyRelay.ts";
import { makeKeyedSemaphore } from "../../utils/keyedSemaphore.ts";
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
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { validateSlackAgentTarget } from "../slack/slackAgentTargetValidator.ts";
import {
  renderSlackThreadSnapshotMarkdown,
  type SlackThreadSnapshot,
} from "../slack/slackThreadSnapshot.ts";
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
    `Source: Slack #${input.thread.channelName}, thread ${input.thread.threadTs}`,
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
  createdThread: false,
  message: `This Slack thread is already linked to @${run.handle}. The replay did not create another T3 turn.`,
});

const sourceKeyFor = (input: SlackAgentMentionInput) =>
  [input.instanceId, input.thread.workspaceId, input.thread.channelId, input.thread.threadTs].join(
    ":",
  );

const deterministicId = (prefix: string, parts: ReadonlyArray<string>) =>
  `${prefix}-${sha256Hex(parts.join("\n")).slice(0, 40)}`;

const availableProjectSelectorText = (target: SlackAgentTarget) =>
  normalizeSlackAgentTargetProjects(target)
    .map((binding) => String(binding.selector))
    .join(", ");

const resolveProjectId = (target: SlackAgentTarget, invocation: SlackAgentInvocation) =>
  Effect.gen(function* () {
    if (invocation.projectSelector === undefined) return target.projectId;
    const selector = String(invocation.projectSelector).toLowerCase();
    const matches = normalizeSlackAgentTargetProjects(target).filter(
      (binding) => String(binding.selector).toLowerCase() === selector,
    );
    if (matches.length === 1) return matches[0]!.projectId;
    return yield* new SlackAgentInvalidTargetError({
      message:
        matches.length === 0
          ? `Slack project selector "${invocation.projectSelector}" is not linked to this Slack agent. Available project aliases: ${availableProjectSelectorText(target)}.`
          : `Slack project selector "${invocation.projectSelector}" is ambiguous for this Slack agent. Available project aliases: ${availableProjectSelectorText(target)}.`,
    });
  });

const linkedRunProjectId = (run: SlackAgentRunSummaryView, fallbackProjectId: ProjectId) =>
  run.projectId ?? fallbackProjectId;

const runIdFor = (input: SlackAgentMentionInput) =>
  SlackAgentRunId.make(deterministicId("slackrun", ["run", sourceKeyFor(input)]));

const threadIdFor = (input: SlackAgentMentionInput) =>
  ThreadId.make(deterministicId("thread-slack", ["thread", sourceKeyFor(input)]));

const recoveredThreadIdFor = (input: SlackAgentMentionInput) =>
  ThreadId.make(
    deterministicId("thread-slack", [
      "recovered-thread",
      sourceKeyFor(input),
      input.externalEventId,
    ]),
  );

const commandIdFor = (kind: string, input: SlackAgentMentionInput) =>
  CommandId.make(deterministicId(`command-slack-${kind}`, [kind, sourceKeyFor(input)]));

const initialTurnCommandIdFor = (input: SlackAgentMentionInput) =>
  CommandId.make(
    deterministicId("command-slack-turn", [
      "initial-turn",
      sourceKeyFor(input),
      input.triggerMessageId,
    ]),
  );

const unarchiveCommandIdFor = (input: SlackAgentMentionInput) =>
  CommandId.make(
    deterministicId("command-slack-unarchive", [sourceKeyFor(input), input.triggerMessageId]),
  );

const followUpTurnCommandIdFor = (input: SlackAgentMentionInput) =>
  CommandId.make(
    deterministicId("command-slack-turn", [
      "follow-up-turn",
      sourceKeyFor(input),
      input.triggerMessageId,
    ]),
  );

const recoveredCreateCommandIdFor = (input: SlackAgentMentionInput) =>
  CommandId.make(
    deterministicId("command-slack-recreate", [sourceKeyFor(input), input.externalEventId]),
  );

const recoveredTurnCommandIdFor = (input: SlackAgentMentionInput) =>
  CommandId.make(
    deterministicId("command-slack-recovered-turn", [
      sourceKeyFor(input),
      input.externalEventId,
      input.triggerMessageId,
    ]),
  );

const initialMessageIdFor = (input: SlackAgentMentionInput) =>
  MessageId.make(
    deterministicId("message-slack", [
      "initial-message",
      sourceKeyFor(input),
      input.triggerMessageId,
    ]),
  );

const followUpMessageIdFor = (input: SlackAgentMentionInput) =>
  MessageId.make(
    deterministicId("message-slack", [
      "follow-up-message",
      sourceKeyFor(input),
      input.triggerMessageId,
    ]),
  );

const titleForSnapshot = (snapshot: SlackThreadSnapshot) => {
  const trigger = snapshot.messages.find(
    (message) => message.messageId === snapshot.triggerMessageId,
  );
  const request = requestWithoutMention(trigger?.text ?? "");
  return clip(request === "" ? `Slack thread #${snapshot.channelName}` : request, MAX_TITLE_CHARS);
};

const renderSlackMessageMarkdown = (
  message: SlackThreadSnapshot["messages"][number] | SlackAgentMentionInput["messages"][number],
  thread: SlackAgentMentionInput["thread"],
) => {
  const lines = [
    `Slack reply in #${thread.channelName} at ${message.ts}`,
    "",
    `Author: ${message.authorLabel} (${message.authorUserId})`,
    "",
    message.text,
    "",
  ];
  if (message.editedTs !== undefined) {
    lines.push(`Edited: ${message.editedTs}`, "");
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of attachments) {
      lines.push(
        `- ${attachment.filename} (${attachment.mediaType}, ${attachment.sizeBytes} bytes): ${attachment.permalink} [id: ${attachment.id}]`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\r/g, "")}\n`;
};

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
      trimToFit: input.trimSnapshotToFit,
    })
    .pipe(Effect.ignore);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* SlackAgentInstanceStore;
  const runs = yield* SlackAgentRunStore;
  const gateway = yield* SlackAgentGateway;
  const chatBridge = yield* SlackChatBridge;
  const chatReplyRelay = yield* SlackChatReplyRelay;
  const engine = yield* WorkflowEngine;
  const committer = yield* WorkflowEventCommitter;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const registry = yield* BoardRegistry;
  const readModel = yield* WorkflowReadModel;
  const sourceLocks = yield* makeKeyedSemaphore;

  const snapshotInput = (
    input: SlackAgentMentionInput,
    trigger: NonNullable<ReturnType<typeof triggerRequest>>,
  ) => ({
    workspaceId: input.thread.workspaceId,
    channelId: input.thread.channelId,
    channelName: input.thread.channelName,
    threadTs: input.thread.threadTs,
    triggerEventId: input.externalEventId,
    triggerTs: trigger.ts,
    triggerMessageId: trigger.messageId,
    messages: input.messages,
    trimToFit: input.trimSnapshotToFit,
  });

  const snapshotThroughTrigger = (input: SlackAgentMentionInput) =>
    Effect.gen(function* () {
      const trigger = triggerRequest(input);
      if (trigger === undefined) {
        return yield* new SlackAgentInvalidTargetError({
          message: `Trigger message ${input.triggerMessageId} is not present in the Slack thread.`,
        });
      }
      const snapshot = yield* gateway
        .snapshotThreadThroughTrigger(snapshotInput(input, trigger))
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
      return { trigger, snapshot };
    });

  const validateWorkflowInvocation = (
    invocation: Extract<SlackAgentInvocation, { mode: "workflow" }>,
    projectId: ProjectId,
  ) =>
    Effect.gen(function* () {
      const board = yield* readModel.getBoard(invocation.target.boardId);
      if (board === null || board.projectId !== projectId) {
        return yield* new SlackAgentInvalidTargetError({
          message:
            board === null
              ? `Workflow board "${invocation.target.boardId}" was not found.`
              : `Workflow board "${invocation.target.boardId}" does not belong to project "${projectId}".`,
        });
      }

      const validation = yield* validateSlackAgentTarget({
        boardId: invocation.target.boardId,
        initialLane: invocation.target.initialLane,
      }).pipe(Effect.provideService(BoardRegistry, registry));
      if (!validation.valid) {
        return yield* new SlackAgentInvalidTargetError({
          message: validation.message,
          ...(validation.path.length === 0
            ? {}
            : { path: validation.path.map((lane) => String(lane)) }),
        });
      }
      return { board, validation };
    });

  const isInitialRunEvent = (runId: string, externalEventId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM slack_agent_run
      WHERE run_id = ${runId}
        AND external_event_id = ${externalEventId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new WorkflowEventStoreError({
            message: "SlackAgentIntake.initialRunEventCheck failed",
            cause,
          }),
        ),
      ),
    );

  const acceptMentionUnlocked: SlackAgentIntakeShape["acceptMention"] = (input) =>
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

      const invocation = input.invocation ?? ({ mode: "chat" } as const);
      const { trigger, snapshot } = yield* snapshotThroughTrigger(input);
      const threadKey =
        input.thread.threadKey ??
        `${input.thread.workspaceId}:${input.thread.channelId}:${input.thread.threadTs}`;

      const existingByThread = yield* runs.findBySourceThread(
        instance.instanceId,
        input.thread.workspaceId,
        input.thread.channelId,
        input.thread.threadTs,
      );
      if (existingByThread !== null) {
        const existingDetail = yield* runs.getRun(existingByThread.runId);
        if (existingDetail === null) {
          return yield* new SlackAgentInvalidTargetError({
            message: `Slack run "${existingByThread.runId}" disappeared while handling its source thread.`,
          });
        }
        if (
          existingDetail.snapshot.triggerMessageId === input.triggerMessageId ||
          (yield* isInitialRunEvent(existingByThread.runId, input.externalEventId))
        ) {
          return duplicateResult(existingByThread);
        }
        if (existingByThread.mode === "chat") {
          const alreadyDelivered = yield* runs.reserveIngestedEvent({
            runId: existingByThread.runId,
            externalEventId: input.externalEventId,
            triggerMessageId: input.triggerMessageId,
            messageId: followUpMessageIdFor(input),
          });
          if (alreadyDelivered) {
            return {
              run: existingByThread,
              duplicate: true,
              statusMessageId:
                existingByThread.statusMessageId ?? statusMessageIdFor(existingByThread.runId),
              createdThread: false,
              message: "This Slack reply was already delivered to the linked chat thread.",
            } satisfies SlackAgentIntakeResult;
          }
          if (existingByThread.threadId === undefined) {
            return yield* new SlackAgentInvalidTargetError({
              message: `Slack chat run "${existingByThread.runId}" is missing its linked thread.`,
            });
          }
          const triggerMessage = snapshot.messages.find(
            (message) => message.messageId === snapshot.triggerMessageId,
          );
          if (triggerMessage === undefined) {
            return yield* new SlackAgentInvalidTargetError({
              message: `Trigger message ${input.triggerMessageId} is not present in the Slack snapshot.`,
            });
          }
          const projectId = linkedRunProjectId(existingByThread, instance.target.projectId);
          const existingThreadId = existingByThread.threadId;
          let linkedRun = existingByThread;
          let linkedThreadId = existingThreadId;
          const delivered = yield* chatBridge
            .deliverUserMessage({
              projectId,
              defaultModelSelection: instance.defaultModelSelection,
              threadId: existingThreadId,
              createThreadCommandId: commandIdFor("create", input),
              unarchiveThreadCommandId: unarchiveCommandIdFor(input),
              startTurnCommandId: followUpTurnCommandIdFor(input),
              messageId: followUpMessageIdFor(input),
              title: titleForSnapshot(snapshot) as never,
              text: renderSlackMessageMarkdown(triggerMessage, input.thread),
            })
            .pipe(
              Effect.catchTag("SlackChatBridgeThreadDeletedError", () =>
                Effect.gen(function* () {
                  const recoveredThreadId = recoveredThreadIdFor(input);
                  const recovered = yield* chatBridge.deliverUserMessage({
                    projectId,
                    defaultModelSelection: instance.defaultModelSelection,
                    threadId: recoveredThreadId,
                    createThreadCommandId: recoveredCreateCommandIdFor(input),
                    unarchiveThreadCommandId: unarchiveCommandIdFor(input),
                    startTurnCommandId: recoveredTurnCommandIdFor(input),
                    messageId: followUpMessageIdFor(input),
                    title: titleForSnapshot(snapshot) as never,
                    text: renderSlackThreadSnapshotMarkdown(snapshot),
                    existingThreadText: renderSlackMessageMarkdown(triggerMessage, input.thread),
                  });
                  linkedRun = yield* runs.relinkChatThread({
                    runId: existingByThread.runId,
                    threadId: recoveredThreadId,
                  });
                  linkedThreadId = recoveredThreadId;
                  yield* chatReplyRelay.notifyChatLinked(recoveredThreadId);
                  return recovered;
                }),
              ),
            );
          yield* runs.markIngestedEventDelivered({
            runId: existingByThread.runId,
            externalEventId: input.externalEventId,
            triggerMessageId: input.triggerMessageId,
          });
          yield* gateway
            .postOrUpdateStatus({
              workspaceId: input.thread.workspaceId,
              channelId: input.thread.channelId,
              channelName: input.thread.channelName,
              threadTs: input.thread.threadTs,
              runId: existingByThread.runId,
              deliveryId: deterministicId("slack-chat-delivery", [
                existingByThread.runId,
                input.externalEventId,
              ]),
              statusMessageId: existingByThread.statusMessageId,
              text: `Delivered Slack reply to T3 chat thread ${linkedThreadId}.`,
            })
            .pipe(
              Effect.flatMap((posted) =>
                runs.updateRunStatus({
                  runId: existingByThread.runId,
                  statusMessageId: posted.statusMessageId,
                }),
              ),
              Effect.ignore,
            );
          return {
            run: linkedRun,
            duplicate: false,
            statusMessageId:
              linkedRun.statusMessageId ?? statusMessageIdFor(existingByThread.runId),
            createdThread: delivered.createdThread,
          } satisfies SlackAgentIntakeResult;
        }

        if (input.workflowAuthorized !== true) {
          return yield* new SlackAgentInvalidTargetError({
            message: "Workflow authorization is required for this linked Slack thread.",
          });
        }

        const alreadyDelivered = yield* runs.reserveIngestedEvent({
          runId: existingByThread.runId,
          externalEventId: input.externalEventId,
          triggerMessageId: input.triggerMessageId,
          messageId: followUpMessageIdFor(input),
        });
        if (alreadyDelivered) {
          return {
            run: existingByThread,
            duplicate: true,
            statusMessageId:
              existingByThread.statusMessageId ?? statusMessageIdFor(existingByThread.runId),
            createdThread: false,
            message: "This Slack reply was already delivered to the linked workflow ticket.",
          } satisfies SlackAgentIntakeResult;
        }
        if (existingByThread.ticketId === undefined) {
          return yield* new SlackAgentInvalidTargetError({
            message: `Slack workflow run "${existingByThread.runId}" is missing its linked ticket.`,
          });
        }
        const triggerMessage = snapshot.messages.find(
          (message) => message.messageId === snapshot.triggerMessageId,
        );
        if (triggerMessage === undefined) {
          return yield* new SlackAgentInvalidTargetError({
            message: `Trigger message ${input.triggerMessageId} is not present in the Slack snapshot.`,
          });
        }
        const text = renderSlackMessageMarkdown(triggerMessage, input.thread);
        const followUpMessageId = followUpMessageIdFor(input);
        const detail = yield* readModel.getTicketDetail(existingByThread.ticketId);
        const awaiting = detail?.steps.find(
          (step) =>
            step.providerResponseKind === "user-input" &&
            (step.status === "waiting" ||
              step.status === "waiting_on_user" ||
              step.status === "awaiting_user"),
        );
        if (awaiting !== undefined) {
          yield* engine.answerTicketStep({
            stepRunId: awaiting.stepRunId as never,
            messageId: followUpMessageId,
            text,
          });
        } else if (!detail?.messages.some((message) => message.messageId === followUpMessageId)) {
          const runningAgent = detail?.steps.find(
            (step) =>
              step.stepType === "agent" &&
              step.status === "running" &&
              step.providerThreadId !== null &&
              step.canSteer !== false,
          );
          if (runningAgent !== undefined) {
            const steered = yield* Effect.exit(
              engine.steerTicketStep({
                ticketId: existingByThread.ticketId,
                stepRunId: runningAgent.stepRunId as never,
                messageId: followUpMessageId,
                text,
              }),
            );
            if (steered._tag === "Failure") {
              yield* engine.postTicketMessage({
                ticketId: existingByThread.ticketId,
                messageId: followUpMessageId,
                text,
              });
            }
          } else {
            yield* engine.postTicketMessage({
              ticketId: existingByThread.ticketId,
              messageId: followUpMessageId,
              text,
            });
          }
        }
        yield* runs.markIngestedEventDelivered({
          runId: existingByThread.runId,
          externalEventId: input.externalEventId,
          triggerMessageId: input.triggerMessageId,
        });
        yield* gateway
          .postOrUpdateStatus({
            workspaceId: input.thread.workspaceId,
            channelId: input.thread.channelId,
            channelName: input.thread.channelName,
            threadTs: input.thread.threadTs,
            runId: existingByThread.runId,
            deliveryId: deterministicId("slack-workflow-delivery", [
              existingByThread.runId,
              input.externalEventId,
            ]),
            statusMessageId: existingByThread.statusMessageId,
            text: `Delivered Slack reply to workflow ticket ${existingByThread.ticketId}.`,
          })
          .pipe(
            Effect.flatMap((posted) =>
              runs.updateRunStatus({
                runId: existingByThread.runId,
                statusMessageId: posted.statusMessageId,
              }),
            ),
            Effect.ignore,
          );
        return {
          run: existingByThread,
          duplicate: false,
          statusMessageId:
            existingByThread.statusMessageId ?? statusMessageIdFor(existingByThread.runId),
          createdThread: false,
        } satisfies SlackAgentIntakeResult;
      }

      const existingByEvent = yield* runs.findByExternalEvent(
        instance.instanceId,
        input.externalEventId,
      );
      if (existingByEvent !== null) return duplicateResult(existingByEvent);

      if (invocation.mode === "chat") {
        const projectId = yield* resolveProjectId(instance.target, invocation);
        const runId = runIdFor(input);
        const t3ThreadId = threadIdFor(input);
        const statusMessageId = statusMessageIdFor(runId);
        const title = titleForSnapshot(snapshot) as never;
        const acceptedPayloadJson = encodeJson({
          runId,
          threadId: t3ThreadId,
          workflowSequence: 0,
          status: "connected",
          kind: "accepted",
          headline: title,
          body: `Connected Slack thread #${input.thread.channelName} to T3 chat thread ${t3ThreadId}.`,
          text: `Connected Slack thread #${input.thread.channelName} to T3 chat thread ${t3ThreadId}.`,
        });
        const delivered = yield* chatBridge.deliverUserMessage({
          projectId,
          defaultModelSelection: instance.defaultModelSelection,
          threadId: t3ThreadId,
          createThreadCommandId: commandIdFor("create", input),
          unarchiveThreadCommandId: unarchiveCommandIdFor(input),
          startTurnCommandId: initialTurnCommandIdFor(input),
          messageId: initialMessageIdFor(input),
          title,
          text: renderSlackThreadSnapshotMarkdown(snapshot),
          existingThreadText: renderSlackMessageMarkdown(trigger, input.thread),
        });
        const run = yield* sql
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

              const created = yield* runs.createRunWithAcceptedDelivery({
                runId,
                instanceId: instance.instanceId,
                projectId,
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
                mode: "chat",
                threadId: t3ThreadId,
                ticketId: null,
                status: "connected",
                acceptedPayloadJson,
              });
              yield* runs.seedDeliveredIngestedEvents({
                runId: created.runId,
                events: snapshot.messages.map((message) => ({
                  externalEventId:
                    message.messageId === input.triggerMessageId
                      ? input.externalEventId
                      : deterministicId("slack-snapshot-event", [
                          sourceKeyFor(input),
                          message.messageId,
                        ]),
                  triggerMessageId: message.messageId,
                  messageId:
                    message.messageId === input.triggerMessageId
                      ? initialMessageIdFor(input)
                      : deterministicId("message-slack-snapshot", [
                          sourceKeyFor(input),
                          message.messageId,
                        ]),
                })),
              });
              return {
                run: created,
                duplicate: false,
                statusMessageId,
                createdThread: delivered.createdThread,
              } satisfies SlackAgentIntakeResult;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                new WorkflowEventStoreError({
                  message: "SlackAgentIntake.chatTransaction failed",
                  cause,
                }),
              ),
            ),
          );
        yield* chatReplyRelay.notifyChatLinked(t3ThreadId);
        return run;
      }

      if (input.workflowAuthorized !== true) {
        return yield* new SlackAgentInvalidTargetError({
          message: "Workflow authorization is required to start a workflow Slack thread.",
        });
      }

      const projectId = yield* resolveProjectId(instance.target, invocation);
      const { validation } = yield* validateWorkflowInvocation(invocation, projectId);
      const fields = deriveSlackTicketFields(input);
      const accepted = yield* engine.withBoardAdmissionLock(
        invocation.target.boardId,
        saveLocks.withSaveLock(
          invocation.target.boardId,
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
                  boardId: invocation.target.boardId,
                  title: fields.title,
                  description: fields.description,
                  destinationLane: invocation.target.initialLane,
                });
                const runId = runIdFor(input);
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
                  projectId,
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
                  mode: "workflow",
                  threadId: null,
                  ticketId: created.ticketId,
                  status: state,
                  acceptedPayloadJson,
                });
                yield* runs.seedDeliveredIngestedEvents({
                  runId: run.runId,
                  events: snapshot.messages.map((message) => ({
                    externalEventId:
                      message.messageId === input.triggerMessageId
                        ? input.externalEventId
                        : deterministicId("slack-snapshot-event", [
                            sourceKeyFor(input),
                            message.messageId,
                          ]),
                    triggerMessageId: message.messageId,
                    messageId: deterministicId("message-slack-snapshot", [
                      sourceKeyFor(input),
                      message.messageId,
                    ]),
                  })),
                });
                return {
                  run,
                  duplicate: false,
                  statusMessageId,
                  createdThread: false,
                } satisfies SlackAgentIntakeResult;
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
          .publishTicketView(accepted.run.ticketId!)
          .pipe(Effect.catch(() => Effect.void));
        yield* engine.recoverBoardWip(invocation.target.boardId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("SlackAgentIntake.recoverBoardWip failed post-commit", {
              boardId: invocation.target.boardId,
              cause,
            }),
          ),
        );
      }

      return accepted;
    });

  const acceptMention: SlackAgentIntakeShape["acceptMention"] = (input) =>
    sourceLocks.withPermit(sourceKeyFor(input), acceptMentionUnlocked(input));

  return { acceptMention } satisfies SlackAgentIntakeShape;
});

export const SlackAgentIntakeLive = Layer.effect(SlackAgentIntake, make);
