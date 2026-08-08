// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TicketSourceContextMaterializer } from "../Services/TicketSourceContextMaterializer.ts";
import { sourceContextPath } from "../instructionTemplate.ts";
import { TicketSourceContextMaterializerLive } from "./TicketSourceContextMaterializer.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = TicketSourceContextMaterializerLive.pipe(
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const installSlackRunTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_run (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      thread_key TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      trigger_ts TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL,
      ticket_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`DELETE FROM slack_agent_run`;
});

const insertRun = (input: {
  readonly ticketId: string;
  readonly snapshot: unknown;
  readonly shaOverride?: string;
  readonly bytesOverride?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const snapshotJson = encodeJson(input.snapshot);
    const sha = NodeCrypto.createHash("sha256").update(snapshotJson).digest("hex");
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id,
        instance_id,
        external_event_id,
        workspace_id,
        channel_id,
        channel_name,
        thread_key,
        thread_ts,
        trigger_ts,
        snapshot_json,
        snapshot_sha256,
        snapshot_bytes,
        ticket_id,
        status,
        created_at,
        updated_at
      )
      VALUES (
        'run-1',
        'instance-1',
        'event-1',
        'W1',
        'C1',
        'engineering',
        'C1:1000.000',
        '1000.000',
        '1000.002',
        ${snapshotJson},
        ${input.shaOverride ?? sha},
        ${input.bytesOverride ?? Buffer.byteLength(snapshotJson, "utf8")},
        ${input.ticketId},
        'running',
        '2026-08-07T00:00:00.000Z',
        '2026-08-07T00:00:00.000Z'
      )
    `;
  });

describe("TicketSourceContextMaterializer", () => {
  it.effect("renders and rewrites verified Slack source context into ticket scratch", () =>
    Effect.gen(function* () {
      yield* installSlackRunTable;
      yield* insertRun({
        ticketId: "ticket-slack",
        snapshot: {
          workspaceId: "W1",
          channelId: "C1",
          channelName: "engineering",
          threadTs: "1000.000",
          triggerEventId: "event-1",
          triggerTs: "1000.002",
          triggerMessageId: "message-2",
          messages: [
            {
              messageId: "message-1",
              ts: "1000.001",
              authorUserId: "U1",
              authorLabel: "Chris",
              text: "Can we fix this?\r\nIt is broken.",
              attachments: [
                {
                  id: "F1",
                  filename: "trace.txt",
                  mediaType: "text/plain",
                  sizeBytes: 12,
                  permalink: "https://slack.example/files/trace",
                },
              ],
            },
            {
              messageId: "message-2",
              ts: "1000.002",
              authorUserId: "U2",
              authorLabel: "T3 Chris",
              text: "@t3_chris please handle it",
              attachments: [],
            },
          ],
        },
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "source-context-" });
      const materializer = yield* TicketSourceContextMaterializer;

      const pointer = yield* materializer.materialize({
        ticketId: "ticket-slack" as TicketId,
        worktreePath: worktree,
      });
      const rendered = yield* fileSystem.readFileString(
        `${worktree}/${sourceContextPath("ticket-slack")}`,
      );

      assert.equal(
        pointer,
        "## Source context\n\nRead the complete source transcript in `.t3/ticket/ticket-slack/SOURCE_SLACK.md` before acting.",
      );
      assert.include(rendered, "# Slack Source Thread");
      assert.include(rendered, "Channel: #engineering (C1)");
      assert.include(rendered, "Can we fix this?\nIt is broken.");
      assert.include(
        rendered,
        "- trace.txt (text/plain, 12 bytes): https://slack.example/files/trace",
      );
      assert.include(rendered, "[id: F1]");
      assert.include(rendered, "## T3 Chris at 1000.002 [trigger]");

      yield* fileSystem.writeFileString(
        `${worktree}/${sourceContextPath("ticket-slack")}`,
        "stale",
      );
      yield* materializer.materialize({
        ticketId: "ticket-slack" as TicketId,
        worktreePath: worktree,
      });
      const rewritten = yield* fileSystem.readFileString(
        `${worktree}/${sourceContextPath("ticket-slack")}`,
      );
      assert.equal(rewritten, rendered);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("returns null for ordinary tickets without touching the worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "source-context-none-",
      });
      const materializer = yield* TicketSourceContextMaterializer;

      const pointer = yield* materializer.materialize({
        ticketId: "ticket-ordinary" as TicketId,
        worktreePath: worktree,
      });
      const exists = yield* fileSystem.exists(`${worktree}/.t3`);

      assert.isNull(pointer);
      assert.isFalse(exists);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails closed when the stored snapshot hash does not match", () =>
    Effect.gen(function* () {
      yield* installSlackRunTable;
      yield* insertRun({
        ticketId: "ticket-corrupt",
        snapshot: { messages: [] },
        shaOverride: "0".repeat(64),
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "source-context-corrupt-",
      });
      const materializer = yield* TicketSourceContextMaterializer;

      const error = yield* materializer
        .materialize({
          ticketId: "ticket-corrupt" as TicketId,
          worktreePath: worktree,
        })
        .pipe(Effect.flip);

      assert.match(error.message, /SHA-256 mismatch/);
    }).pipe(Effect.provide(TestLayer)),
  );
});
