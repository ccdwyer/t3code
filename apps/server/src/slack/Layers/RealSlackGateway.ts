import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SlackAgentInstanceStore } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import {
  SlackAgentGatewayError,
  type SlackAgentGatewayShape,
} from "../../workflow/Services/SlackAgentGateway.ts";
import { buildSlackThreadSnapshot } from "../../workflow/slack/slackThreadSnapshot.ts";
import { SlackApi, SlackApiError } from "../Services/SlackApi.ts";
import { RealSlackGateway } from "../Services/RealSlackGateway.ts";

interface SlackRunRow {
  readonly instanceId: string;
  readonly statusMessageId: string | null;
}

const TOKEN_PATTERN = /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/g;
const AUTH_HEADER_PATTERN = /authorization\s*:\s*bearer\s+[^\s,)}\]]+/gi;
const isSlackAgentGatewayError = Schema.is(SlackAgentGatewayError);

const threadKeyFor = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}) => `${input.workspaceId}:${input.channelId}:${input.threadTs}`;

const redact = (value: string) =>
  value
    .replace(TOKEN_PATTERN, "[redacted-token]")
    .replace(AUTH_HEADER_PATTERN, "authorization: bearer [redacted]");

const toGatewayError = (message: string, cause?: unknown) =>
  isSlackAgentGatewayError(cause)
    ? cause
    : new SlackAgentGatewayError({
        message,
        cause,
      });

const fromSlackApiError = (error: SlackApiError) =>
  new SlackAgentGatewayError({
    message: redact(error.message),
    retryAfterMs: error.retryAfterMs,
  });

const fromSqlError = (operation: string) => (cause: SqlError) =>
  new SlackAgentGatewayError({
    message: `${operation} failed`,
    cause,
  });

const make = Effect.gen(function* () {
  const api = yield* SlackApi;
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* SlackAgentInstanceStore;

  const findRun = (runId: string) =>
    sql<SlackRunRow>`
      SELECT
        instance_id AS "instanceId",
        status_message_id AS "statusMessageId"
      FROM slack_agent_run
      WHERE run_id = ${runId}
      LIMIT 1
    `.pipe(Effect.mapError(fromSqlError("RealSlackGateway.findRun")));

  const snapshotThreadThroughTrigger: SlackAgentGatewayShape["snapshotThreadThroughTrigger"] = (
    input,
  ) => buildSlackThreadSnapshot(input);

  const postOrUpdateStatus: SlackAgentGatewayShape["postOrUpdateStatus"] = (input) =>
    Effect.gen(function* () {
      const run = (yield* findRun(input.runId))[0];
      if (run === undefined) {
        return yield* new SlackAgentGatewayError({
          message: `Slack agent run was not found: ${input.runId}`,
        });
      }

      const credentials = yield* instances.readCredentials(run.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new SlackAgentGatewayError({
              message: `Failed to read Slack credentials for instance: ${run.instanceId}`,
              cause,
            }),
        ),
      );
      if (credentials === null) {
        return yield* new SlackAgentGatewayError({
          message: `Slack credentials are missing for instance: ${run.instanceId}`,
        });
      }

      const statusMessageId = input.forceNewMessage
        ? undefined
        : (input.statusMessageId ?? run.statusMessageId ?? undefined);
      const post = api.postMessage;
      const update = api.updateMessage;
      const posted =
        statusMessageId === undefined
          ? yield* post({
              botToken: credentials.botToken,
              channelId: input.channelId,
              threadTs: input.threadTs,
              text: input.text,
            }).pipe(Effect.mapError(fromSlackApiError))
          : yield* update({
              botToken: credentials.botToken,
              channelId: input.channelId,
              threadTs: input.threadTs,
              text: input.text,
              messageTs: statusMessageId,
            }).pipe(Effect.mapError(fromSlackApiError));

      return {
        threadKey: threadKeyFor(input),
        statusMessageId: posted.messageTs,
      };
    }).pipe(
      Effect.mapError((cause) =>
        toGatewayError("RealSlackGateway.postOrUpdateStatus failed", cause),
      ),
    );

  return RealSlackGateway.of({
    snapshotThreadThroughTrigger,
    postOrUpdateStatus,
    subscribeMockThread: () => Effect.succeed(null),
    subscribeMockThreadChanges: () => Effect.succeed(Stream.empty),
  });
});

export const RealSlackGatewayLive = Layer.effect(RealSlackGateway, make);
