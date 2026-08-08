import * as NodeCrypto from "node:crypto";

import { MockSlackSourceMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  TicketSourceContextMaterializer,
  type TicketSourceContextMaterializerShape,
} from "../Services/TicketSourceContextMaterializer.ts";
import { sourceContextPath, sourceContextReference } from "../instructionTemplate.ts";
import { renderSlackThreadSnapshotMarkdown } from "../slack/slackThreadSnapshot.ts";

interface SlackRunRow {
  readonly snapshotJson: string;
  readonly snapshotSha256: string;
  readonly snapshotBytes: number;
}

const StoredSlackThreadSnapshot = Schema.Struct({
  workspaceId: Schema.String,
  channelId: Schema.String,
  channelName: Schema.String,
  threadTs: Schema.String,
  triggerEventId: Schema.String,
  triggerTs: Schema.String,
  triggerMessageId: Schema.String,
  messages: Schema.Array(MockSlackSourceMessage),
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSlackThreadSnapshot));

const toMaterializerError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toMaterializerError(message)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const materialize: TicketSourceContextMaterializerShape["materialize"] = (input) =>
    Effect.gen(function* () {
      const tableRows = yield* wrapSql(
        "Slack source context table lookup failed",
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_agent_run'
        `,
      );
      if (tableRows.length === 0) return null;

      const rows = yield* wrapSql(
        "Slack source context lookup failed",
        sql<SlackRunRow>`
          SELECT
            snapshot_json AS "snapshotJson",
            snapshot_sha256 AS "snapshotSha256",
            snapshot_bytes AS "snapshotBytes"
          FROM slack_agent_run
          WHERE ticket_id = ${String(input.ticketId)}
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (row === undefined) return null;

      const actualBytes = Buffer.byteLength(row.snapshotJson, "utf8");
      if (actualBytes !== row.snapshotBytes) {
        return yield* new WorkflowEventStoreError({
          message: `Slack source context byte count mismatch for ticket ${String(input.ticketId)}`,
        });
      }
      const actualSha = NodeCrypto.createHash("sha256").update(row.snapshotJson).digest("hex");
      if (actualSha !== row.snapshotSha256) {
        return yield* new WorkflowEventStoreError({
          message: `Slack source context SHA-256 mismatch for ticket ${String(input.ticketId)}`,
        });
      }

      const snapshot = yield* decodeJson(row.snapshotJson).pipe(
        Effect.mapError(toMaterializerError("Slack source context JSON decode failed")),
      );
      const markdown = renderSlackThreadSnapshotMarkdown({
        ...snapshot,
        messages: snapshot.messages.map((message) => ({
          ...message,
          attachments: [...(message.attachments ?? [])],
        })),
        canonicalJson: row.snapshotJson,
        byteLength: row.snapshotBytes,
      });
      const relativePath = sourceContextPath(input.ticketId as string);
      const absolutePath = path.join(input.worktreePath, relativePath);
      yield* fileSystem
        .makeDirectory(path.dirname(absolutePath), { recursive: true })
        .pipe(Effect.mapError(toMaterializerError("Slack source context directory create failed")));
      yield* fileSystem
        .writeFileString(absolutePath, markdown)
        .pipe(Effect.mapError(toMaterializerError("Slack source context write failed")));
      return sourceContextReference(relativePath);
    });

  return { materialize } satisfies TicketSourceContextMaterializerShape;
});

export const TicketSourceContextMaterializerLive = Layer.effect(
  TicketSourceContextMaterializer,
  make,
);
