import {
  MOCK_SLACK_WORKSPACE_ID,
  ModelSelection,
  SLACK_AGENT_DEFAULT_PROJECT_SELECTOR,
  normalizeSlackAgentTargetProjects,
} from "@t3tools/contracts";
import type {
  ModelSelection as ModelSelectionType,
  ProjectId,
  SlackAgentBotUserId,
  SlackAgentConnectionState,
  SlackAgentHandle,
  SlackAgentInstanceKind,
  SlackAgentInstanceId,
  SlackAgentInstanceView,
  SlackAgentLatestRunSummary,
  SlackAgentProjectBinding,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  SlackAgentInstanceStore,
  SlackAgentInstanceStoreError,
  type SlackAgentInstanceStoreShape,
} from "../Services/SlackAgentInstanceStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";

interface InstanceRow {
  readonly instance_id: string;
  readonly kind: SlackAgentInstanceKind;
  readonly workspace_id: string;
  readonly workspace_name: string | null;
  readonly app_id: string | null;
  readonly bot_id: string | null;
  readonly bot_user_id: string;
  readonly handle: string;
  readonly owner_label: string;
  readonly project_id: string;
  readonly project_bindings_json: string;
  readonly default_model_selection_json: string | null;
  readonly app_token_secret_name: string | null;
  readonly bot_token_secret_name: string | null;
  readonly connection_state: SlackAgentConnectionState;
  readonly connected_at: string | null;
  readonly last_error: string | null;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly active_run_count: number;
  readonly latest_run_id: string | null;
  readonly latest_mode: SlackAgentLatestRunSummary["mode"] | null;
  readonly latest_thread_id: string | null;
  readonly latest_ticket_id: string | null;
  readonly latest_state: SlackAgentLatestRunSummary["state"] | null;
  readonly latest_updated_at: string | null;
  readonly latest_pr_url: string | null;
}

const DEFAULT_WORKSPACE_ID = MOCK_SLACK_WORKSPACE_ID;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toStoreError = (message: string) => (cause: unknown) =>
  new SlackAgentInstanceStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

const mapSqliteUniqueError = (message: string, uniqueMessage: string) => (error: unknown) => {
  const cause = error instanceof SlackAgentInstanceStoreError ? error.cause : error;
  if (String(cause).includes("UNIQUE")) {
    return new SlackAgentInstanceStoreError({
      message: uniqueMessage,
      cause,
    });
  }
  return error instanceof SlackAgentInstanceStoreError ? error : toStoreError(message)(error);
};

const normalizeHandle = (suffix: string): SlackAgentHandle => {
  const trimmed = suffix.trim().toLowerCase().replace(/^@/, "");
  return `t3_${trimmed}` as SlackAgentHandle;
};

const appTokenSecretName = (instanceId: string) => `slack-agent:${instanceId}:app-token`;
const botTokenSecretName = (instanceId: string) => `slack-agent:${instanceId}:bot-token`;

const redactError = (value: string | null | undefined) =>
  value === null || value === undefined
    ? null
    : value
        .replace(/\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/g, "[redacted-token]")
        .replace(/authorization\s*:\s*bearer\s+[^\s,)}\]]+/gi, "authorization: bearer [redacted]")
        .slice(0, 500);

const selectorPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const decodeDefaultModelSelectionJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ModelSelection),
);
const encodeDefaultModelSelectionJson = Schema.encodeSync(Schema.fromJsonString(ModelSelection));

const parseDefaultModelSelection = (value: string | null): ModelSelectionType | null =>
  value === null ? null : decodeDefaultModelSelectionJson(value);

const encodeDefaultModelSelection = (value: ModelSelectionType | null | undefined) =>
  value === null || value === undefined ? null : encodeDefaultModelSelectionJson(value);

const parseProjectBindings = (row: InstanceRow): ReadonlyArray<SlackAgentProjectBinding> => {
  const decoded = JSON.parse(row.project_bindings_json) as Array<{
    readonly projectId?: unknown;
    readonly selector?: unknown;
  }>;
  const projects = decoded
    .filter(
      (binding): binding is { readonly projectId: string; readonly selector: string } =>
        typeof binding.projectId === "string" &&
        typeof binding.selector === "string" &&
        selectorPattern.test(binding.selector),
    )
    .map(
      (binding) =>
        ({
          projectId: binding.projectId as ProjectId,
          selector: binding.selector as never,
        }) satisfies SlackAgentProjectBinding,
    )
    .sort((left, right) => {
      const leftIsDefault = String(left.projectId) === row.project_id;
      const rightIsDefault = String(right.projectId) === row.project_id;
      if (leftIsDefault !== rightIsDefault) return leftIsDefault ? -1 : 1;
      return String(left.selector).localeCompare(String(right.selector));
    });
  return normalizeSlackAgentTargetProjects({
    projectId: row.project_id as ProjectId,
    projects,
  });
};

const buildProjectBindings = (
  projectId: ProjectId,
  projects: ReadonlyArray<SlackAgentProjectBinding> | undefined,
) => {
  const bindings: Array<SlackAgentProjectBinding> = [];
  const seenProjects = new Map<string, string>();
  const seenSelectors = new Map<string, string>();
  const add = (binding: SlackAgentProjectBinding) => {
    const bindingProjectId = String(binding.projectId);
    const selector = String(binding.selector);
    if (!selectorPattern.test(selector)) {
      return new SlackAgentInstanceStoreError({
        message: `Invalid Slack agent project selector: ${selector}`,
      });
    }
    const existingSelector = seenProjects.get(bindingProjectId);
    if (existingSelector !== undefined) {
      return existingSelector === selector
        ? undefined
        : new SlackAgentInstanceStoreError({
            message: `Slack agent project is bound more than once: ${bindingProjectId}`,
          });
    }
    const existingProject = seenSelectors.get(selector);
    if (existingProject !== undefined) {
      return existingProject === bindingProjectId
        ? undefined
        : new SlackAgentInstanceStoreError({
            message: `Slack agent project selector is already in use: ${selector}`,
          });
    }
    seenProjects.set(bindingProjectId, selector);
    seenSelectors.set(selector, bindingProjectId);
    bindings.push(binding);
    return undefined;
  };
  for (const binding of projects ?? []) {
    const error = add(binding);
    if (error !== undefined) return error;
  }
  if (!seenProjects.has(String(projectId))) {
    const error = add({
      projectId,
      selector: SLACK_AGENT_DEFAULT_PROJECT_SELECTOR,
    } satisfies SlackAgentProjectBinding);
    if (error !== undefined) return error;
  }
  return bindings;
};

const toView = (row: InstanceRow): SlackAgentInstanceView => {
  const latestRun =
    row.latest_run_id === null ||
    row.latest_mode === null ||
    row.latest_state === null ||
    row.latest_updated_at === null
      ? undefined
      : ({
          runId: row.latest_run_id as never,
          mode: row.latest_mode,
          ...(row.latest_thread_id === null ? {} : { threadId: row.latest_thread_id as never }),
          ...(row.latest_ticket_id === null ? {} : { ticketId: row.latest_ticket_id as never }),
          state: row.latest_state,
          updatedAt: row.latest_updated_at as never,
          ...(row.latest_pr_url === null ? {} : { prUrl: row.latest_pr_url }),
        } satisfies SlackAgentLatestRunSummary);
  const enabled = row.enabled === 1;
  const credentialsConfigured =
    row.app_token_secret_name !== null && row.bot_token_secret_name !== null;
  return {
    instanceId: row.instance_id as SlackAgentInstanceId,
    kind: row.kind,
    workspace: {
      workspaceId: row.workspace_id as never,
      ...(row.workspace_name === null ? {} : { name: row.workspace_name as never }),
    },
    ...(row.app_id === null ? {} : { appId: row.app_id as never }),
    ...(row.bot_id === null ? {} : { botId: row.bot_id as never }),
    handle: row.handle as SlackAgentHandle,
    ownerLabel: row.owner_label as never,
    botUserId: row.bot_user_id as SlackAgentBotUserId,
    target: {
      projectId: row.project_id as ProjectId,
      projects: parseProjectBindings(row),
    },
    defaultModelSelection: parseDefaultModelSelection(row.default_model_selection_json),
    enabled,
    state: !enabled
      ? "disabled"
      : row.kind === "slack" && !credentialsConfigured
        ? "needs_setup"
        : "enabled",
    validation: { valid: true },
    credentialsConfigured,
    connection: {
      state: row.connection_state,
      ...(row.connected_at === null ? {} : { connectedAt: row.connected_at as never }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
    },
    activeRunCount: row.active_run_count,
    ...(latestRun === undefined ? {} : { latestRun }),
    createdAt: row.created_at as never,
    updatedAt: row.updated_at as never,
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secretStoreOption = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const ids = yield* WorkflowIds;

  const requireSecretStore = Option.match(secretStoreOption, {
    onNone: () =>
      Effect.fail(
        new SlackAgentInstanceStoreError({
          message: "Slack credential storage is not available on this server",
        }),
      ),
    onSome: Effect.succeed,
  });

  const selectViews = (where: Effect.Effect<ReadonlyArray<InstanceRow>, SqlError>) =>
    wrap("Failed to read Slack agent instances", where).pipe(
      Effect.map((rows) => rows.map(toView)),
    );

  const selectById = (instanceId: string) =>
    selectViews(sql<InstanceRow>`
      SELECT
        i.instance_id,
        i.kind,
        i.workspace_id,
        i.workspace_name,
        i.app_id,
        i.bot_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        COALESCE((
          SELECT json_group_array(json_object('projectId', project_id, 'selector', selector))
          FROM (
            SELECT project_id, selector
            FROM slack_agent_instance_project
            WHERE instance_id = i.instance_id
            ORDER BY selector, project_id
          )
        ), '[]') AS project_bindings_json,
        i.default_model_selection_json,
        i.app_token_secret_name,
        i.bot_token_secret_name,
        i.connection_state,
        i.connected_at,
        i.last_error,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.mode AS latest_mode,
        latest.t3_thread_id AS latest_thread_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE mode = 'workflow' AND status NOT IN ('done', 'failed')
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
        i.kind,
        i.workspace_id,
        i.workspace_name,
        i.app_id,
        i.bot_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        COALESCE((
          SELECT json_group_array(json_object('projectId', project_id, 'selector', selector))
          FROM (
            SELECT project_id, selector
            FROM slack_agent_instance_project
            WHERE instance_id = i.instance_id
            ORDER BY selector, project_id
          )
        ), '[]') AS project_bindings_json,
        i.default_model_selection_json,
        i.app_token_secret_name,
        i.bot_token_secret_name,
        i.connection_state,
        i.connected_at,
        i.last_error,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.mode AS latest_mode,
        latest.t3_thread_id AS latest_thread_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE mode = 'workflow' AND status NOT IN ('done', 'failed')
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

  const insertProjectBindings = (
    instanceId: string,
    projectId: ProjectId,
    projects: ReadonlyArray<SlackAgentProjectBinding> | undefined,
    now: string,
  ) =>
    Effect.gen(function* () {
      const bindings = buildProjectBindings(projectId, projects);
      if (bindings instanceof SlackAgentInstanceStoreError) {
        return yield* bindings;
      }
      yield* Effect.forEach(
        bindings,
        (binding) =>
          wrap(
            "Failed to write Slack agent project bindings",
            sql`
              INSERT INTO slack_agent_instance_project (
                instance_id,
                project_id,
                selector,
                created_at
              ) VALUES (
                ${instanceId},
                ${binding.projectId},
                ${binding.selector},
                ${now}
              )
            `,
          ),
        { discard: true },
      );
    });

  const createMock: SlackAgentInstanceStoreShape["createMock"] = Effect.fn(
    "SlackAgentInstanceStore.createMock",
  )(function* (input) {
    const eventId = yield* ids.eventId();
    const instanceId = `slackinst-${eventId}`;
    const botUserId = `mockbot-${eventId}`;
    const handle = normalizeHandle(input.handleSuffix);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* wrap(
            "Failed to create Slack agent instance",
            sql`
            INSERT INTO slack_agent_instance (
              instance_id,
              kind,
              workspace_id,
              workspace_name,
              app_id,
              bot_id,
              bot_user_id,
              handle,
              owner_label,
              owner_principal,
              project_id,
              default_model_selection_json,
              app_token_secret_name,
              bot_token_secret_name,
              connection_state,
              connected_at,
              last_error,
              enabled,
              created_at,
              updated_at,
              disabled_at
            ) VALUES (
              ${instanceId},
              'mock',
              ${input.workspaceId || DEFAULT_WORKSPACE_ID},
              NULL,
              NULL,
              NULL,
              ${botUserId},
              ${handle},
              ${input.ownerLabel},
              ${input.ownerPrincipal ?? null},
              ${input.projectId},
              ${encodeDefaultModelSelection(input.defaultModelSelection)},
              NULL,
              NULL,
              'connected',
              ${now},
              NULL,
              1,
              ${now},
              ${now},
              NULL
            )
          `,
          );
          yield* insertProjectBindings(instanceId, input.projectId, input.projects, now);
        }),
      )
      .pipe(
        Effect.mapError(
          mapSqliteUniqueError(
            "Failed to create Slack agent instance",
            `Slack agent handle is already in use: ${handle}`,
          ),
        ),
      );
    const view = yield* selectById(instanceId);
    if (view === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Created instance disappeared" });
    }
    return view;
  });

  const create: SlackAgentInstanceStoreShape["create"] = (input) => createMock(input);

  const createReal: SlackAgentInstanceStoreShape["createReal"] = Effect.fn(
    "SlackAgentInstanceStore.createReal",
  )(function* (input) {
    const secretStore = yield* requireSecretStore;
    const eventId = yield* ids.eventId();
    const instanceId = `slackinst-${eventId}`;
    const appSecretName = appTokenSecretName(instanceId);
    const botSecretName = botTokenSecretName(instanceId);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* secretStore
      .set(appSecretName, textEncoder.encode(input.appToken))
      .pipe(Effect.mapError(toStoreError("Failed to store Slack app token")));
    yield* secretStore.set(botSecretName, textEncoder.encode(input.botToken)).pipe(
      Effect.tapError(() => secretStore.remove(appSecretName).pipe(Effect.ignore)),
      Effect.mapError(toStoreError("Failed to store Slack bot token")),
    );
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* wrap(
            "Failed to create Slack agent instance",
            sql`
            INSERT INTO slack_agent_instance (
              instance_id,
              kind,
              workspace_id,
              workspace_name,
              app_id,
              bot_id,
              bot_user_id,
              handle,
              owner_label,
              owner_principal,
              project_id,
              default_model_selection_json,
              app_token_secret_name,
              bot_token_secret_name,
              connection_state,
              connected_at,
              last_error,
              enabled,
              created_at,
              updated_at,
              disabled_at
            ) VALUES (
              ${instanceId},
              'slack',
              ${input.identity.workspaceId},
              ${input.identity.workspaceName ?? null},
              ${input.identity.appId ?? null},
              ${input.identity.botId ?? null},
              ${String(input.identity.botUserId)},
              ${String(input.identity.handle)},
              ${input.ownerLabel},
              ${input.ownerPrincipal ?? null},
              ${input.projectId},
              ${encodeDefaultModelSelection(input.defaultModelSelection)},
              ${appSecretName},
              ${botSecretName},
              'connecting',
              NULL,
              NULL,
              1,
              ${now},
              ${now},
              NULL
            )
          `,
          );
          yield* insertProjectBindings(instanceId, input.projectId, input.projects, now);
        }),
      )
      .pipe(
        Effect.tapError(() =>
          Effect.all([secretStore.remove(appSecretName), secretStore.remove(botSecretName)], {
            discard: true,
          }).pipe(Effect.ignore),
        ),
        Effect.mapError(
          mapSqliteUniqueError(
            "Failed to create Slack agent instance",
            `Slack agent identity is already connected: ${input.identity.handle}`,
          ),
        ),
      );
    const view = yield* selectById(instanceId);
    if (view === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Created instance disappeared" });
    }
    return view;
  });

  const readCredentials: SlackAgentInstanceStoreShape["readCredentials"] = Effect.fn(
    "SlackAgentInstanceStore.readCredentials",
  )(function* (instanceId) {
    const rows = yield* wrap(
      "Failed to read Slack agent credential refs",
      sql<{
        readonly appTokenSecretName: string | null;
        readonly botTokenSecretName: string | null;
      }>`
        SELECT
          app_token_secret_name AS "appTokenSecretName",
          bot_token_secret_name AS "botTokenSecretName"
        FROM slack_agent_instance
        WHERE instance_id = ${String(instanceId)}
        LIMIT 1
      `,
    );
    const row = rows[0];
    if (row === undefined || row.appTokenSecretName === null || row.botTokenSecretName === null) {
      return null;
    }
    const secretStore = yield* requireSecretStore;
    const appToken = yield* secretStore
      .get(row.appTokenSecretName)
      .pipe(Effect.mapError(toStoreError("Failed to read Slack app token")));
    const botToken = yield* secretStore
      .get(row.botTokenSecretName)
      .pipe(Effect.mapError(toStoreError("Failed to read Slack bot token")));
    if (Option.isNone(appToken) || Option.isNone(botToken)) return null;
    return {
      appToken: textDecoder.decode(appToken.value),
      botToken: textDecoder.decode(botToken.value),
    };
  });

  const replaceCredentials: SlackAgentInstanceStoreShape["replaceCredentials"] = Effect.fn(
    "SlackAgentInstanceStore.replaceCredentials",
  )(function* (instanceId, input) {
    const secretStore = yield* requireSecretStore;
    const current = yield* selectById(String(instanceId));
    if (current === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    const appSecretName = appTokenSecretName(String(instanceId));
    const botSecretName = botTokenSecretName(String(instanceId));
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* secretStore
      .set(appSecretName, textEncoder.encode(input.appToken))
      .pipe(Effect.mapError(toStoreError("Failed to store Slack app token")));
    yield* secretStore
      .set(botSecretName, textEncoder.encode(input.botToken))
      .pipe(Effect.mapError(toStoreError("Failed to store Slack bot token")));
    yield* wrap(
      "Failed to update Slack agent credential refs",
      sql`
        UPDATE slack_agent_instance
        SET app_token_secret_name = ${appSecretName},
            bot_token_secret_name = ${botSecretName},
            connection_state = 'connecting',
            connected_at = NULL,
            last_error = NULL,
            updated_at = ${now}
        WHERE instance_id = ${String(instanceId)}
      `,
    );
    const next = yield* selectById(String(instanceId));
    if (next === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Updated instance disappeared" });
    }
    return next;
  });

  const disconnect: SlackAgentInstanceStoreShape["disconnect"] = Effect.fn(
    "SlackAgentInstanceStore.disconnect",
  )(function* (instanceId) {
    const rows = yield* wrap(
      "Failed to read Slack agent credential refs",
      sql<{
        readonly appTokenSecretName: string | null;
        readonly botTokenSecretName: string | null;
      }>`
        SELECT
          app_token_secret_name AS "appTokenSecretName",
          bot_token_secret_name AS "botTokenSecretName"
        FROM slack_agent_instance
        WHERE instance_id = ${String(instanceId)}
        LIMIT 1
      `,
    );
    if (rows[0] === undefined) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const refs = [rows[0].appTokenSecretName, rows[0].botTokenSecretName].filter(
      (name): name is string => name !== null,
    );
    if (refs.length > 0) {
      const secretStore = yield* requireSecretStore;
      yield* Effect.forEach(
        refs,
        (name) =>
          secretStore
            .remove(name)
            .pipe(Effect.mapError(toStoreError("Failed to remove Slack agent credential"))),
        { discard: true },
      );
    }
    yield* wrap(
      "Failed to disconnect Slack agent instance",
      sql`
        UPDATE slack_agent_instance
        SET app_token_secret_name = NULL,
            bot_token_secret_name = NULL,
            connection_state = 'disconnected',
            connected_at = NULL,
            last_error = NULL,
            updated_at = ${now}
        WHERE instance_id = ${String(instanceId)}
      `,
    );
    const next = yield* selectById(String(instanceId));
    if (next === null) {
      return yield* new SlackAgentInstanceStoreError({
        message: "Disconnected instance disappeared",
      });
    }
    return next;
  });

  const updateConnectionState: SlackAgentInstanceStoreShape["updateConnectionState"] = Effect.fn(
    "SlackAgentInstanceStore.updateConnectionState",
  )(function* (instanceId, input) {
    const current = yield* selectById(String(instanceId));
    if (current === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const connectedAt =
      input.connectedAt === undefined
        ? input.state === "connected"
          ? (current.connection.connectedAt ?? now)
          : null
        : input.connectedAt;
    yield* wrap(
      "Failed to update Slack agent connection state",
      sql`
        UPDATE slack_agent_instance
        SET connection_state = ${input.state},
            connected_at = ${connectedAt},
            last_error = ${redactError(input.lastError)},
            updated_at = ${now}
        WHERE instance_id = ${String(instanceId)}
      `,
    );
    const next = yield* selectById(String(instanceId));
    if (next === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Updated instance disappeared" });
    }
    return next;
  });

  const update: SlackAgentInstanceStoreShape["update"] = Effect.fn(
    "SlackAgentInstanceStore.update",
  )(function* (instanceId, input) {
    const current = yield* selectById(String(instanceId));
    if (current === null) {
      return yield* new SlackAgentInstanceStoreError({ message: "Slack agent instance not found" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const nextProjectId = input.projectId ?? current.target.projectId;
    const nextProjects =
      input.projects === undefined && input.projectId === undefined
        ? current.target.projects
        : input.projects;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* wrap(
            "Failed to update Slack agent instance",
            sql`
            UPDATE slack_agent_instance
            SET
              handle = ${input.handleSuffix === undefined ? current.handle : normalizeHandle(input.handleSuffix)},
              owner_label = ${input.ownerLabel ?? current.ownerLabel},
              project_id = ${nextProjectId},
              default_model_selection_json = ${
                input.defaultModelSelection === undefined
                  ? encodeDefaultModelSelection(current.defaultModelSelection)
                  : encodeDefaultModelSelection(input.defaultModelSelection)
              },
              updated_at = ${now}
            WHERE instance_id = ${String(instanceId)}
          `,
          );
          if (input.projects !== undefined || input.projectId !== undefined) {
            yield* wrap(
              "Failed to replace Slack agent project bindings",
              sql`
              DELETE FROM slack_agent_instance_project
              WHERE instance_id = ${String(instanceId)}
            `,
            );
            yield* insertProjectBindings(String(instanceId), nextProjectId, nextProjects, now);
          }
        }),
      )
      .pipe(
        Effect.mapError(
          mapSqliteUniqueError(
            "Failed to update Slack agent instance",
            "Slack agent handle or project selector is already in use",
          ),
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
        i.kind,
        i.workspace_id,
        i.workspace_name,
        i.app_id,
        i.bot_id,
        i.bot_user_id,
        i.handle,
        i.owner_label,
        i.project_id,
        COALESCE((
          SELECT json_group_array(json_object('projectId', project_id, 'selector', selector))
          FROM (
            SELECT project_id, selector
            FROM slack_agent_instance_project
            WHERE instance_id = i.instance_id
            ORDER BY selector, project_id
          )
        ), '[]') AS project_bindings_json,
        i.default_model_selection_json,
        i.app_token_secret_name,
        i.bot_token_secret_name,
        i.connection_state,
        i.connected_at,
        i.last_error,
        i.enabled,
        i.created_at,
        i.updated_at,
        i.disabled_at,
        COALESCE(active.count, 0) AS active_run_count,
        latest.run_id AS latest_run_id,
        latest.mode AS latest_mode,
        latest.t3_thread_id AS latest_thread_id,
        latest.ticket_id AS latest_ticket_id,
        latest.status AS latest_state,
        latest.updated_at AS latest_updated_at,
        latest.pr_url AS latest_pr_url
      FROM slack_agent_instance AS i
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS count
        FROM slack_agent_run
        WHERE mode = 'workflow' AND status NOT IN ('done', 'failed')
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
    yield* disconnect(instanceId);
    yield* wrap(
      "Failed to delete Slack agent project bindings",
      sql`
        DELETE FROM slack_agent_instance_project
        WHERE instance_id = ${String(instanceId)}
      `,
    );
    yield* wrap(
      "Failed to delete Slack agent instance",
      sql`DELETE FROM slack_agent_instance WHERE instance_id = ${String(instanceId)}`,
    );
  });

  return {
    create,
    createMock,
    createReal,
    list,
    get,
    getEnabledByBotUserId,
    readCredentials,
    replaceCredentials,
    disconnect,
    updateConnectionState,
    update,
    disable,
    enable,
    delete: deleteInstance,
  } satisfies SlackAgentInstanceStoreShape;
});

export const SlackAgentInstanceStoreLive = Layer.effect(SlackAgentInstanceStore, make);
