import { SocketModeClient } from "@slack/socket-mode";
import type {
  AppsConnectionsOpenResponse,
  AuthTestResponse,
  Logger,
  WebAPICallResult,
} from "@slack/web-api";
import { LogLevel, WebClient } from "@slack/web-api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SLACK_THREAD_SNAPSHOT_MAX_MESSAGES } from "../../workflow/slack/slackThreadSnapshot.ts";
import {
  SlackApi,
  SlackApiError,
  type SlackApiShape,
  type SlackCredentialsValidation,
  type SlackPostedMessage,
  type SlackSocketEnvelope,
  type SlackThreadFile,
  type SlackThreadMessage,
  type SlackThreadSnapshot,
} from "../Services/SlackApi.ts";

type SlackApiCallResult = WebAPICallResult & {
  readonly error?: string | undefined;
  readonly needed?: string | undefined;
  readonly provided?: string | undefined;
};

export interface SlackAuthClient {
  readonly auth: {
    readonly test: () => Promise<AuthTestResponse>;
  };
  readonly apps: {
    readonly connections: {
      readonly open: () => Promise<AppsConnectionsOpenResponse>;
    };
  };
}

export interface SlackWebClient extends SlackAuthClient {
  readonly conversations: {
    readonly replies: (input: {
      readonly channel: string;
      readonly ts: string;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }) => Promise<
      SlackApiCallResult & {
        readonly messages?: ReadonlyArray<SlackSdkMessage> | undefined;
        readonly response_metadata?: { readonly next_cursor?: string | undefined } | undefined;
      }
    >;
    readonly info: (input: { readonly channel: string }) => Promise<
      SlackApiCallResult & {
        readonly channel?:
          | { readonly name?: string | undefined; readonly id?: string | undefined }
          | undefined;
      }
    >;
  };
  readonly users: {
    readonly info: (input: { readonly user: string }) => Promise<
      SlackApiCallResult & {
        readonly user?: {
          readonly id?: string | undefined;
          readonly name?: string | undefined;
          readonly real_name?: string | undefined;
          readonly profile?:
            | {
                readonly display_name?: string | undefined;
                readonly real_name?: string | undefined;
              }
            | undefined;
        };
      }
    >;
  };
  readonly chat: {
    readonly postMessage: (input: {
      readonly channel: string;
      readonly thread_ts: string;
      readonly text: string;
    }) => Promise<
      SlackApiCallResult & {
        readonly channel?: string | undefined;
        readonly ts?: string | undefined;
      }
    >;
    readonly update: (input: {
      readonly channel: string;
      readonly ts: string;
      readonly text: string;
    }) => Promise<
      SlackApiCallResult & {
        readonly channel?: string | undefined;
        readonly ts?: string | undefined;
      }
    >;
  };
}

export interface SlackSocketClient {
  readonly on: (
    event: string,
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => SlackSocketClient;
  readonly start: () => Promise<AppsConnectionsOpenResponse>;
  readonly disconnect: () => Promise<void>;
}

export interface SlackSdkFactoryShape {
  readonly makeWebClient: (token: string) => SlackWebClient;
  readonly makeSocketModeClient: (input: { readonly appToken: string }) => SlackSocketClient;
}

export class SlackSdkFactory extends Context.Service<SlackSdkFactory, SlackSdkFactoryShape>()(
  "t3/slack/Layers/SlackApi/SlackSdkFactory",
) {}

interface SlackSdkMessage {
  readonly client_msg_id?: string | undefined;
  readonly bot_id?: string | undefined;
  readonly user?: string | undefined;
  readonly username?: string | undefined;
  readonly text?: string | undefined;
  readonly ts?: string | undefined;
  readonly edited?: { readonly ts?: string | undefined } | undefined;
  readonly files?: ReadonlyArray<SlackSdkFile> | undefined;
}

interface SlackSdkFile {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly size?: number | undefined;
  readonly permalink?: string | undefined;
}

interface SlackSdkEnvelopeEvent {
  readonly envelope_id?: string | undefined;
  readonly type?: string | undefined;
  readonly body?: unknown;
  readonly payload?: unknown;
  readonly accepts_response_payload?: boolean | undefined;
  readonly ack?: (() => Promise<void>) | undefined;
}

interface SlackSdkErrorEvent {
  readonly error?: unknown;
}

const TOKEN_PATTERN = /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/g;
const AUTH_HEADER_PATTERN = /authorization\s*:\s*bearer\s+[^\s,)}\]]+/gi;

const slackNoopLogger: Logger = {
  debug: (..._messages: Array<unknown>) => {},
  info: (..._messages: Array<unknown>) => {},
  warn: (..._messages: Array<unknown>) => {},
  error: (..._messages: Array<unknown>) => {},
  setLevel: (_level: LogLevel) => {},
  getLevel: () => LogLevel.ERROR,
  setName: (_name: string) => {},
};

const redact = (value: unknown): string =>
  String(value)
    .replace(TOKEN_PATTERN, "[redacted-token]")
    .replace(AUTH_HEADER_PATTERN, "authorization: bearer [redacted]");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const retryAfterMsFrom = (cause: unknown) => {
  if (!isRecord(cause)) return undefined;
  const retryAfter = cause.retryAfter;
  if (typeof retryAfter === "number") return retryAfter * 1_000;
  const retryAfterMs = cause.retryAfterMs;
  return typeof retryAfterMs === "number" ? retryAfterMs : undefined;
};

const toSlackApiError = (operation: string) => (cause: unknown) =>
  new SlackApiError({
    operation,
    message: redact(isRecord(cause) && "message" in cause ? cause.message : cause),
    retryAfterMs: retryAfterMsFrom(cause),
  });

const failNotOk = <A extends SlackApiCallResult>(operation: string, response: A) =>
  response.ok === false
    ? Effect.fail(
        new SlackApiError({
          operation,
          message: redact(response.error ?? "Slack API request failed."),
          ...(response.response_metadata?.retryAfter === undefined
            ? {}
            : { retryAfterMs: response.response_metadata.retryAfter * 1_000 }),
        }),
      )
    : Effect.succeed(response);

const withAbortSignal = <A>(promise: PromiseLike<A>, signal: AbortSignal) =>
  new Promise<A>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Slack API operation was interrupted."));
      return;
    }
    const onAbort = () => {
      reject(signal.reason ?? new Error("Slack API operation was interrupted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

const promiseCall = <A>(operation: string, call: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: (signal) => withAbortSignal(call(signal), signal),
    catch: toSlackApiError(operation),
  });

const requireString = (operation: string, field: string, value: string | undefined) =>
  value === undefined || value.trim() === ""
    ? Effect.fail(
        new SlackApiError({
          operation,
          message: `Slack API response did not include ${field}.`,
        }),
      )
    : Effect.succeed(value);

const validateCredentialsResult = (
  auth: AuthTestResponse,
  connection: AppsConnectionsOpenResponse,
): Effect.Effect<SlackCredentialsValidation, SlackApiError> =>
  Effect.gen(function* () {
    yield* failNotOk("SlackApi.validateCredentials.authTest", auth);
    yield* failNotOk("SlackApi.validateCredentials.appsConnectionsOpen", connection);
    yield* requireString("SlackApi.validateCredentials.authTest", "user_id", auth.user_id);
    const workspaceId = yield* requireString(
      "SlackApi.validateCredentials.authTest",
      "team_id",
      auth.team_id,
    );
    const workspaceName = yield* requireString(
      "SlackApi.validateCredentials.authTest",
      "team",
      auth.team,
    );
    const botUserId = yield* requireString(
      "SlackApi.validateCredentials.authTest",
      "user_id",
      auth.user_id,
    );

    return {
      workspaceId,
      workspaceName,
      botUserId,
      ...(auth.bot_id === undefined ? {} : { botId: auth.bot_id }),
      ...(auth.app_id === undefined ? {} : { appId: auth.app_id }),
      ...(auth.response_metadata?.scopes === undefined
        ? {}
        : { grantedScopes: auth.response_metadata.scopes }),
    };
  });

const slackTimestampValue = (ts: string): bigint | null => {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (match === null) return null;
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
};

const isAtOrBefore = (messageTs: string, triggerTs: string) => {
  const messageValue = slackTimestampValue(messageTs);
  const triggerValue = slackTimestampValue(triggerTs);
  return messageValue !== null && triggerValue !== null && messageValue <= triggerValue;
};

const messageIdFor = (message: SlackSdkMessage): string | undefined =>
  message.client_msg_id ?? message.ts;

const authorIdFor = (message: SlackSdkMessage): string | undefined =>
  message.user ?? message.bot_id ?? message.username;

const toThreadFile = (file: SlackSdkFile): SlackThreadFile | null => {
  if (file.id === undefined || file.id.trim() === "") return null;
  return {
    id: file.id,
    ...(file.name === undefined ? {} : { name: file.name }),
    ...(file.title === undefined ? {} : { title: file.title }),
    ...(file.mimetype === undefined ? {} : { mimetype: file.mimetype }),
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.permalink === undefined ? {} : { permalink: file.permalink }),
  };
};

const toThreadMessage = (
  message: SlackSdkMessage,
  authorLabel: string,
): SlackThreadMessage | null => {
  const ts = message.ts;
  const messageId = messageIdFor(message);
  const authorUserId = authorIdFor(message);
  if (ts === undefined || messageId === undefined || authorUserId === undefined) return null;
  return {
    messageId,
    ts,
    authorUserId,
    authorLabel,
    text: message.text ?? "",
    files: (message.files ?? []).flatMap((file) => {
      const normalized = toThreadFile(file);
      return normalized === null ? [] : [normalized];
    }),
    ...(message.edited?.ts === undefined ? {} : { editedTs: message.edited.ts }),
  };
};

const sortMessages = (messages: ReadonlyArray<SlackThreadMessage>) =>
  [...messages].sort((left, right) => {
    const leftValue = slackTimestampValue(left.ts);
    const rightValue = slackTimestampValue(right.ts);
    if (leftValue === null || rightValue === null) return left.ts.localeCompare(right.ts);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });

const asEnvelopeEvent = (value: unknown): SlackSdkEnvelopeEvent | null => {
  if (!isRecord(value)) return null;
  const envelopeId = value.envelope_id;
  const ack = value.ack;
  if (typeof envelopeId !== "string" || typeof ack !== "function") return null;
  return value as SlackSdkEnvelopeEvent;
};

const asErrorEvent = (value: unknown): SlackSdkErrorEvent =>
  isRecord(value) && "error" in value ? { error: value.error } : { error: value };

const make = Effect.gen(function* () {
  const factory = yield* SlackSdkFactory;

  const validateCredentials: SlackApiShape["validateCredentials"] = Effect.fn(
    "SlackApi.validateCredentials",
  )(function* (input) {
    const botClient = factory.makeWebClient(input.botToken);
    const appClient = factory.makeWebClient(input.appToken);
    const [auth, connection] = yield* Effect.all([
      promiseCall("SlackApi.validateCredentials.authTest", () => botClient.auth.test()).pipe(
        Effect.flatMap((response) => failNotOk("SlackApi.validateCredentials.authTest", response)),
      ),
      promiseCall("SlackApi.validateCredentials.appsConnectionsOpen", () =>
        appClient.apps.connections.open(),
      ).pipe(
        Effect.flatMap((response) =>
          failNotOk("SlackApi.validateCredentials.appsConnectionsOpen", response),
        ),
      ),
    ]);
    const identity = yield* validateCredentialsResult(auth, connection);
    const botUser = yield* promiseCall("SlackApi.validateCredentials.usersInfo", () =>
      botClient.users.info({ user: identity.botUserId }),
    ).pipe(
      Effect.flatMap((response) => failNotOk("SlackApi.validateCredentials.usersInfo", response)),
      Effect.tapError((error) =>
        Effect.logWarning(
          "Slack bot profile lookup failed; bot handle validation is unavailable.",
          {
            operation: error.operation,
            message: error.message,
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          },
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const botUserName =
      botUser === undefined
        ? undefined
        : botUser.user?.profile?.display_name ||
          botUser.user?.profile?.real_name ||
          botUser.user?.real_name ||
          botUser.user?.name ||
          auth.user;
    return {
      ...identity,
      ...(botUserName === undefined ? {} : { botUserName }),
    };
  });

  const openSocket: SlackApiShape["openSocket"] = (input) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const client = factory.makeSocketModeClient({ appToken: input.appToken });
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        let startResolved = false;
        const report = (state: Parameters<typeof input.onState>[0]) =>
          runFork(input.onState(state));
        const disconnectIfStartInterrupted = Effect.suspend(() =>
          startResolved
            ? Effect.void
            : promiseCall("SlackApi.openSocket.disconnect", () => client.disconnect()).pipe(
                Effect.ignore,
              ),
        );

        client.on("connecting", () => {
          report({ type: "connecting" });
        });
        client.on("reconnecting", () => {
          report({ type: "connecting" });
        });
        client.on("connected", () => {
          report({ type: "connected" });
        });
        client.on("disconnected", () => {
          report({ type: "disconnect" });
        });
        client.on("error", (event) => {
          report({
            type: "error",
            error: toSlackApiError("SlackApi.openSocket")(asErrorEvent(event).error),
          });
        });
        client.on("slack_event", (event) => {
          const raw = asEnvelopeEvent(event);
          if (raw === null) return;
          const payload = raw.body ?? raw.payload;
          const envelope: SlackSocketEnvelope = {
            envelopeId: raw.envelope_id ?? "",
            type: raw.type ?? "slack_event",
            payload,
            acceptsResponsePayload: raw.accepts_response_payload === true,
          };
          runFork(
            promiseCall("SlackApi.openSocket.ack", () => raw.ack?.() ?? Promise.resolve()).pipe(
              Effect.flatMap(() => input.onEnvelope(envelope)),
              Effect.catch((error) => input.onState({ type: "error", error })),
            ),
          );
        });

        yield* promiseCall("SlackApi.openSocket.start", () => client.start()).pipe(
          Effect.flatMap((response) => failNotOk("SlackApi.openSocket.start", response)),
          Effect.tap(() =>
            Effect.sync(() => {
              startResolved = true;
            }),
          ),
          Effect.onInterrupt(() => disconnectIfStartInterrupted),
        );

        return {
          close: promiseCall("SlackApi.openSocket.disconnect", () => client.disconnect()).pipe(
            Effect.andThen(input.onState({ type: "closed" })),
          ),
        };
      }),
      (connection) => connection.close.pipe(Effect.ignore),
      { interruptible: true },
    );

  const resolveUserLabel: SlackApiShape["resolveUserLabel"] = (input) =>
    Effect.gen(function* () {
      const client = factory.makeWebClient(input.botToken);
      const response = yield* promiseCall("SlackApi.resolveUserLabel", () =>
        client.users.info({ user: input.userId }),
      ).pipe(Effect.flatMap((result) => failNotOk("SlackApi.resolveUserLabel", result)));
      return (
        response.user?.profile?.display_name ||
        response.user?.profile?.real_name ||
        response.user?.real_name ||
        response.user?.name ||
        response.user?.id ||
        input.userId
      );
    });

  const fetchThreadThrough: SlackApiShape["fetchThreadThrough"] = Effect.fn(
    "SlackApi.fetchThreadThrough",
  )(function* (input) {
    const client = factory.makeWebClient(input.botToken);
    const messages: Array<SlackThreadMessage> = [];
    const userLabels = new Map<string, string>();
    let cursor: string | undefined;
    let sawTrigger = false;
    const resolveMemoizedUserLabel = (userId: string) => {
      const cached = userLabels.get(userId);
      if (cached !== undefined) return Effect.succeed(cached);
      return resolveUserLabel({
        botToken: input.botToken,
        userId,
      }).pipe(
        Effect.orElseSucceed(() => userId),
        Effect.tap((label) =>
          Effect.sync(() => {
            userLabels.set(userId, label);
          }),
        ),
      );
    };

    do {
      const response = yield* promiseCall("SlackApi.fetchThreadThrough", () =>
        client.conversations.replies({
          channel: input.channelId,
          ts: input.threadTs,
          ...(cursor === undefined ? {} : { cursor }),
          limit: 200,
        }),
      ).pipe(Effect.flatMap((result) => failNotOk("SlackApi.fetchThreadThrough", result)));

      for (const message of response.messages ?? []) {
        if (message.ts === undefined || !isAtOrBefore(message.ts, input.triggerTs)) continue;
        const authorId = authorIdFor(message);
        if (authorId === undefined) continue;
        const authorLabel = yield* resolveMemoizedUserLabel(authorId);
        const normalized = toThreadMessage(message, authorLabel);
        if (normalized !== null) {
          messages.push(normalized);
          if (messages.length > SLACK_THREAD_SNAPSHOT_MAX_MESSAGES) {
            messages.splice(0, messages.length - SLACK_THREAD_SNAPSHOT_MAX_MESSAGES);
          }
        }
        if (message.ts === input.triggerTs) sawTrigger = true;
      }

      cursor = response.response_metadata?.next_cursor;
    } while (!sawTrigger && cursor !== undefined && cursor !== "");

    if (!sawTrigger) {
      return yield* new SlackApiError({
        operation: "SlackApi.fetchThreadThrough",
        message: `Slack thread did not include trigger timestamp ${input.triggerTs}.`,
      });
    }

    return {
      channelId: input.channelId,
      threadTs: input.threadTs,
      triggerTs: input.triggerTs,
      messages: sortMessages(messages),
    } satisfies SlackThreadSnapshot;
  });

  const resolveChannelName: SlackApiShape["resolveChannelName"] = (input) =>
    Effect.gen(function* () {
      const client = factory.makeWebClient(input.botToken);
      const response = yield* promiseCall("SlackApi.resolveChannelName", () =>
        client.conversations.info({ channel: input.channelId }),
      ).pipe(Effect.flatMap((result) => failNotOk("SlackApi.resolveChannelName", result)));
      return response.channel?.name ?? response.channel?.id ?? input.channelId;
    });

  const normalizePostedMessage = (
    operation: string,
    fallbackChannelId: string,
    response: SlackApiCallResult & {
      readonly channel?: string | undefined;
      readonly ts?: string | undefined;
    },
  ): Effect.Effect<SlackPostedMessage, SlackApiError> =>
    Effect.gen(function* () {
      yield* failNotOk(operation, response);
      const messageTs = yield* requireString(operation, "ts", response.ts);
      return {
        channelId: response.channel ?? fallbackChannelId,
        messageTs,
      };
    });

  const postMessage: SlackApiShape["postMessage"] = (input) => {
    const client = factory.makeWebClient(input.botToken);
    return promiseCall("SlackApi.postMessage", () =>
      client.chat["postMessage"]({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
      }),
    ).pipe(
      Effect.flatMap((response) =>
        normalizePostedMessage("SlackApi.postMessage", input.channelId, response),
      ),
    );
  };

  const updateMessage: SlackApiShape["updateMessage"] = (input) => {
    const client = factory.makeWebClient(input.botToken);
    return promiseCall("SlackApi.updateMessage", () =>
      client.chat.update({
        channel: input.channelId,
        ts: input.messageTs,
        text: input.text,
      }),
    ).pipe(
      Effect.flatMap((response) =>
        normalizePostedMessage("SlackApi.updateMessage", input.channelId, response),
      ),
    );
  };

  return SlackApi.of({
    validateCredentials,
    openSocket,
    fetchThreadThrough,
    resolveChannelName,
    resolveUserLabel,
    postMessage,
    updateMessage,
  });
});

export const SlackSdkFactoryLive = Layer.succeed(SlackSdkFactory, {
  makeWebClient: (token) =>
    new WebClient(token, {
      logger: slackNoopLogger,
      logLevel: LogLevel.ERROR,
    }) as SlackWebClient,
  makeSocketModeClient: (input) =>
    new SocketModeClient({
      ...input,
      logger: slackNoopLogger,
      logLevel: LogLevel.ERROR,
    }) as SlackSocketClient,
});

export const SlackApiLive = Layer.effect(SlackApi, make);
export const SlackApiLayer = SlackApiLive.pipe(Layer.provide(SlackSdkFactoryLive));
