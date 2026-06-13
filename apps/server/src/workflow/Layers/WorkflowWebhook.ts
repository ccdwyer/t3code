import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowWebhook, type WorkflowWebhookShape } from "../Services/WorkflowWebhook.ts";

const toWebhookError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow webhook store failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toWebhookError));

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const workflowWebhookPath = (boardId: string): string =>
  `/hooks/workflow/${encodeURIComponent(boardId)}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const getConfig: WorkflowWebhookShape["getConfig"] = (boardId, rotate) =>
    Effect.gen(function* () {
      const rows = yield* wrap(sql<{ readonly tokenPrefix: string }>`
        SELECT token_prefix AS "tokenPrefix"
        FROM workflow_board_webhook
        WHERE board_id = ${boardId}
      `);
      const existing = rows[0];
      if (existing !== undefined && !rotate) {
        return {
          path: workflowWebhookPath(boardId as string),
          hasToken: true,
          tokenPrefix: existing.tokenPrefix,
        };
      }
      const token = randomBytes(32).toString("hex");
      const tokenPrefix = token.slice(0, 8);
      const createdAt = yield* nowIso;
      yield* wrap(sql`
        INSERT INTO workflow_board_webhook (board_id, token_hash, token_prefix, created_at)
        VALUES (${boardId}, ${hashToken(token)}, ${tokenPrefix}, ${createdAt})
        ON CONFLICT(board_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          token_prefix = excluded.token_prefix,
          created_at = excluded.created_at
      `);
      return {
        path: workflowWebhookPath(boardId as string),
        hasToken: true,
        tokenPrefix,
        token,
      };
    });

  const verifyToken: WorkflowWebhookShape["verifyToken"] = (boardId, token) =>
    Effect.gen(function* () {
      const rows = yield* wrap(sql<{ readonly tokenHash: string }>`
        SELECT token_hash AS "tokenHash"
        FROM workflow_board_webhook
        WHERE board_id = ${boardId}
      `);
      const stored = rows[0]?.tokenHash;
      if (stored === undefined) {
        return false;
      }
      const expected = Buffer.from(stored, "hex");
      const candidate = Buffer.from(hashToken(token), "hex");
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });

  const recordDelivery: WorkflowWebhookShape["recordDelivery"] = (boardId, deliveryId) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      // RETURNING yields a row only when the insert actually happened, so a
      // conflicting (duplicate) delivery is detected race-free.
      const inserted = yield* wrap(sql<{ readonly deliveryId: string }>`
        INSERT INTO workflow_webhook_delivery (board_id, delivery_id, created_at)
        VALUES (${boardId}, ${deliveryId}, ${createdAt})
        ON CONFLICT(board_id, delivery_id) DO NOTHING
        RETURNING delivery_id AS "deliveryId"
      `);
      return inserted.length === 0;
    });

  const releaseDelivery: WorkflowWebhookShape["releaseDelivery"] = (boardId, deliveryId) =>
    wrap(sql`
      DELETE FROM workflow_webhook_delivery
      WHERE board_id = ${boardId} AND delivery_id = ${deliveryId}
    `).pipe(Effect.asVoid);

  const deleteForBoard: WorkflowWebhookShape["deleteForBoard"] = (boardId) =>
    Effect.gen(function* () {
      yield* wrap(sql`DELETE FROM workflow_webhook_delivery WHERE board_id = ${boardId}`);
      yield* wrap(sql`DELETE FROM workflow_board_webhook WHERE board_id = ${boardId}`);
    });

  return {
    getConfig,
    verifyToken,
    recordDelivery,
    releaseDelivery,
    deleteForBoard,
  } satisfies WorkflowWebhookShape;
});

export const WorkflowWebhookLive = Layer.effect(WorkflowWebhook, make);
