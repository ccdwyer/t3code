import { MOCK_SLACK_WORKSPACE_ID } from "@t3tools/contracts";
import type {
  BoardId,
  LaneKey,
  ProjectId,
  SlackAgentBotUserId,
  SlackAgentHandle,
  SlackAgentInstanceId,
  SlackAgentInstanceView,
  SlackAgentLatestRunSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  SlackAgentInstanceStore,
  SlackAgentInstanceStoreError,
  type SlackAgentInstanceStoreShape,
} from "../Services/SlackAgentInstanceStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";

interface InstanceRow {
  readonly instance_id: string;
  readonly workspace_id: string;
  readonly bot_user_id: string;
  readonly handle: string;
  readonly owner_label: string;
  readonly project_id: string;
  readonly board_id: string;
  readonly initial_lane: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly active_run_count: number;
  readonly latest_run_id: string | null;
  readonly latest_ticket_id: string | null;
  readonly latest_state: SlackAgentLatestRunSummary["state"] | null;
  readonly latest_updated_at: string | null;
  readonly latest_pr_url: string | null;
}

const DEFAULT_WORKSPACE_ID = MOCK_SLACK_WORKSPACE_ID;

const toStoreError = (message: string) => (cause: unknown) =>
  new SlackAgentInstanceStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

const normalizeHandle = (suffix: string): SlackAgentHandle => {
  const trimmed = suffix.trim().toLowerCase().replace(/^@/, "");
  return `t3_${trimmed}` as SlackAgentHandle;
};

const toView = (row: InstanceRow): SlackAgentInstanceView => {
  const latestRun =
    row.latest_run_id === null ||
    row.latest_ticket_id === null ||
    row.latest_state === null ||
    row.latest_updated_at === null
      ? undefined
      : ({
          runId: row.latest_run_id as never,
          ticketId: row.latest_ticket_id as never,
          state: row.latest_state,
          updatedAt: row.latest_updated_at as never,
          ...(row.latest_pr_url === null ? {} : { prUrl: row.latest_pr_url }),
        } satisfies SlackAgentLatestRunSummary);
  const enabled = row.enabled === 1;
  return {
    instanceId: row.instance_id as SlackAgentInstanceId,
    handle: row.handle as SlackAgentHandle,
    ownerLabel: row.owner_label as never,
    botUserId: row.bot_user_id as SlackAgentBotUserId,
    target: {
      projectId: row.project_id as ProjectId,
      boardId: row.board_id as BoardId,
      initialLane: row.initial_lane as LaneKey,
    },
    enabled,
    state: enabled ? "enabled" : "disabled",
    validation: { valid: true },
    activeRunCount: row.active_run_count,
    ...(latestRun === undefined ? {} : { latestRun }),
    createdAt: row.created_at as never,
    updatedAt: row.updated_at as never,
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* WorkflowIds;

  const selectViews = (where: Effect.Effect<ReadonlyArray<InstanceRow>, SqlError>) =>
    wrap("Failed to read Slack agent instances", where).pipe(
      Effect.map((rows) => rows.map(toView)),
    );

  const selectById = (instanceId: string) =>
    selectViews(sql<InstanceRow>`
      SELECT
        i.instance_id,
        i.workspace_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        i.board_id,
        i.initial_lane,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE status <> 'done'
        GROUP BY instance_id
      ) AS active ON active.instance_id = i.instance_id
      LEFT JOIN slack_agent_run AS latest
        ON latest.run_id = (
          SELECT run_id
          FROM slack_agent_run
          WHERE instance_id = i.instance_id
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1
        )
      WHERE i.instance_id = ${instanceId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const list: SlackAgentInstanceStoreShape["list"] = (workspaceId) =>
    selectViews(sql<InstanceRow>`
      SELECT
        i.instance_id,
        i.workspace_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        i.board_id,
        i.initial_lane,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE status <> 'done'
        GROUP BY instance_id
      ) AS active ON active.instance_id = i.instance_id
      LEFT JOIN slack_agent_run AS latest
        ON latest.run_id = (
          SELECT run_id
          FROM slack_agent_run
          WHERE instance_id = i.instance_id
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1
        )
      WHERE ${workspaceId ?? null} IS NULL OR i.workspace_id = ${workspaceId ?? null}
      ORDER BY i.created_at ASC, i.instance_id ASC
    `);

  const get: SlackAgentInstanceStoreShape["get"] = (instanceId) => selectById(String(instanceId));

  const create: SlackAgentInstanceStoreShape["create"] = Effect.fn(
    "SlackAgentInstanceStore.create",
  )(function* (input) {
    const eventId = yield* ids.eventId();
    const instanceId = `slackinst-${eventId}`;
    const botUserId = `mockbot-${eventId}`;
    const handle = normalizeHandle(input.handleSuffix);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to create Slack agent instance",
      sql`
        INSERT INTO slack_agent_instance (
          instance_id,
          kind,
          workspace_id,
          bot_user_id,
          handle,
          owner_label,
          owner_principal,
          project_id,
          board_id,
          initial_lane,
          enabled,
          created_at,
          updated_at,
          disabled_at
        ) VALUES (
          ${instanceId},
          'mock',
          ${input.workspaceId || DEFAULT_WORKSPACE_ID},
          ${botUserId},
          ${handle},
          ${input.ownerLabel},
          ${input.ownerPrincipal ?? null},
          ${input.projectId},
          ${input.boardId},
          ${input.initialLane},
          1,
          ${now},
          ${now},
          NULL
        )
      `,
    ).pipe(
      Effect.mapError((error) =>
        String(error.cause).includes("UNIQUE")
          ? new SlackAgentInstanceStoreError({
              message: `Slack agent handle is already in use: ${handle}`,
              cause: error.cause,
            })
          : error,
      ),
    );
    const view = yield* selectById(instanceId);
    if (view === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Created instance disappeared" });
    }
    return view;
  });

  const update: SlackAgentInstanceStoreShape["update"] = Effect.fn(
    "SlackAgentInstanceStore.update",
  )(function* (instanceId, input) {
    const current = yield* selectById(String(instanceId));
    if (current === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to update Slack agent instance",
      sql`
        UPDATE slack_agent_instance
        SET
          handle = ${input.handleSuffix === undefined ? current.handle : normalizeHandle(input.handleSuffix)},
          owner_label = ${input.ownerLabel ?? current.ownerLabel},
          project_id = ${input.projectId ?? current.target.projectId},
          board_id = ${input.boardId ?? current.target.boardId},
          initial_lane = ${input.initialLane ?? current.target.initialLane},
          updated_at = ${now}
        WHERE instance_id = ${String(instanceId)}
      `,
    ).pipe(
      Effect.mapError((error) =>
        String(error.cause).includes("UNIQUE")
          ? new SlackAgentInstanceStoreError({
              message: "Slack agent handle is already in use",
              cause: error.cause,
            })
          : error,
      ),
    );
    const next = yield* selectById(String(instanceId));
    if (next === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Updated instance disappeared" });
    }
    return next;
  });

  const setEnabled = Effect.fn("SlackAgentInstanceStore.setEnabled")(function* (
    instanceId: string,
    enabled: boolean,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to change Slack agent instance enabled state",
      sql`
        UPDATE slack_agent_instance
        SET enabled = ${enabled ? 1 : 0},
            updated_at = ${now},
            disabled_at = ${enabled ? null : now}
        WHERE instance_id = ${instanceId}
      `,
    );
    const view = yield* selectById(instanceId);
    if (view === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    return view;
  });

  const disable: SlackAgentInstanceStoreShape["disable"] = (instanceId) =>
    setEnabled(String(instanceId), false);

  const enable: SlackAgentInstanceStoreShape["enable"] = (instanceId) =>
    setEnabled(String(instanceId), true);

  const getEnabledByBotUserId: SlackAgentInstanceStoreShape["getEnabledByBotUserId"] = (
    workspaceId,
    botUserId,
  ) =>
    selectViews(sql<InstanceRow>`
      SELECT
        i.instance_id,
        i.workspace_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        i.board_id,
        i.initial_lane,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE status <> 'done'
        GROUP BY instance_id
      ) AS active ON active.instance_id = i.instance_id
      LEFT JOIN slack_agent_run AS latest
        ON latest.run_id = (
          SELECT run_id
          FROM slack_agent_run
          WHERE instance_id = i.instance_id
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1
        )
      WHERE i.workspace_id = ${workspaceId}
        AND i.bot_user_id = ${String(botUserId)}
        AND i.enabled = 1
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const deleteInstance: SlackAgentInstanceStoreShape["delete"] = Effect.fn(
    "SlackAgentInstanceStore.delete",
  )(function* (instanceId) {
    const rows = yield* wrap(
      "Failed to count Slack agent runs",
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM slack_agent_run
        WHERE instance_id = ${String(instanceId)}
      `,
    );
    if ((rows[0]?.count ?? 0) > 0) {
      return yield* new SlackAgentInstanceStoreError({
        message: "Disable the Slack agent before deleting linked tickets and runs",
      });
    }
    yield* wrap(
      "Failed to delete Slack agent instance",
      sql`DELETE FROM slack_agent_instance WHERE instance_id = ${String(instanceId)}`,
    );
  });

  const disableForBoard: SlackAgentInstanceStoreShape["disableForBoard"] = Effect.fn(
    "SlackAgentInstanceStore.disableForBoard",
  )(function* (boardId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to disable Slack agent instances for board",
      sql`
        UPDATE slack_agent_instance
        SET enabled = 0,
            updated_at = ${now},
            disabled_at = COALESCE(disabled_at, ${now})
        WHERE board_id = ${boardId}
      `,
    );
  });

  return {
    create,
    list,
    get,
    getEnabledByBotUserId,
    update,
    disable,
    enable,
    delete: deleteInstance,
    disableForBoard,
  } satisfies SlackAgentInstanceStoreShape;
});

export const SlackAgentInstanceStoreLive = Layer.effect(SlackAgentInstanceStore, make);
