import { assert, describe, it } from "@effect/vitest";
import type { AppsConnectionsOpenResponse, AuthTestResponse } from "@slack/web-api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { SLACK_THREAD_SNAPSHOT_MAX_MESSAGES } from "../../workflow/slack/slackThreadSnapshot.ts";
import { SlackApi, SlackApiError } from "../Services/SlackApi.ts";
import {
  SlackApiLive,
  SlackSdkFactory,
  type SlackSocketClient,
  type SlackWebClient,
} from "./SlackApi.ts";

const authResponse = {
  ok: true,
  team_id: "T123",
  team: "Acme",
  user_id: "U999",
  user: "t3_chris",
  bot_id: "B999",
  app_id: "A999",
  response_metadata: { scopes: ["app_mentions:read", "chat:write"] },
} satisfies AuthTestResponse;

const connectionResponse = {
  ok: true,
  url: "wss://example.test/socket",
} satisfies AppsConnectionsOpenResponse;

const makeWebClient = (overrides: Partial<SlackWebClient> = {}): SlackWebClient => ({
  auth: { test: () => Promise.resolve(authResponse) },
  apps: { connections: { open: () => Promise.resolve(connectionResponse) } },
  conversations: {
    replies: () => Promise.resolve({ ok: true, messages: [] }),
    info: () => Promise.resolve({ ok: true, channel: { id: "C123", name: "general" } }),
  },
  users: {
    info: ({ user }) =>
      Promise.resolve({
        ok: true,
        user: {
          id: user,
          profile: { display_name: user === authResponse.user_id ? "t3_chris" : `User ${user}` },
        },
      }),
  },
  chat: {
    postMessage: ({ channel }) => Promise.resolve({ ok: true, channel, ts: "1700000001.000001" }),
    update: ({ channel, ts }) => Promise.resolve({ ok: true, channel, ts }),
  },
  ...overrides,
});

class FakeSocket implements SlackSocketClient {
  readonly listeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
  startCount = 0;
  disconnectCount = 0;
  private readonly startImpl: (() => Promise<AppsConnectionsOpenResponse>) | undefined;

  constructor(startImpl?: () => Promise<AppsConnectionsOpenResponse>) {
    this.startImpl = startImpl;
  }

  on(event: string, listener: (...args: ReadonlyArray<unknown>) => void) {
    this.listeners.set(event, listener);
    return this;
  }

  start() {
    this.startCount += 1;
    if (this.startImpl !== undefined) return this.startImpl();
    this.listeners.get("connected")?.();
    return Promise.resolve(connectionResponse);
  }

  disconnect() {
    this.disconnectCount += 1;
    this.listeners.get("disconnected")?.();
    return Promise.resolve();
  }

  emitLifecycle(event: "connecting" | "connected" | "reconnecting" | "disconnected") {
    this.listeners.get(event)?.();
  }

  emitEnvelope(input: {
    readonly envelopeId: string;
    readonly payload: unknown;
    readonly ack: () => Promise<void>;
  }) {
    this.listeners.get("slack_event")?.({
      envelope_id: input.envelopeId,
      type: "events_api",
      body: input.payload,
      accepts_response_payload: false,
      ack: input.ack,
    });
  }
}

const provideApi =
  (input: {
    readonly webClient?: SlackWebClient | undefined;
    readonly webClientForToken?: ((token: string) => SlackWebClient) | undefined;
    readonly socket?: FakeSocket | undefined;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const testLayer = SlackApiLive.pipe(
      Layer.provide(
        Layer.succeed(SlackSdkFactory, {
          makeWebClient: (token) =>
            input.webClientForToken?.(token) ?? input.webClient ?? makeWebClient(),
          makeSocketModeClient: () => input.socket ?? new FakeSocket(),
        }),
      ),
    );
    return effect.pipe(Effect.provide(testLayer));
  };

describe("SlackApiLive", () => {
  it.effect("validates bot and app credentials without returning tokens", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(provideApi({ webClient: makeWebClient() }));

      assert.deepStrictEqual(result, {
        workspaceId: "T123",
        workspaceName: "Acme",
        botUserId: "U999",
        botUserName: "t3_chris",
        botId: "B999",
        appId: "A999",
        grantedScopes: ["app_mentions:read", "chat:write"],
      });
      assert.notEqual(result.workspaceId, "xapp-secret");
      assert.notEqual(result.workspaceName, "xoxb-secret");
    }),
  );

  it.effect("validates the bot display name instead of the auth username", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(
        provideApi({
          webClient: makeWebClient({
            auth: {
              test: () => Promise.resolve({ ...authResponse, user: "t3chris" }),
            },
            users: {
              info: ({ user }) =>
                Promise.resolve({
                  ok: true,
                  user: {
                    id: user,
                    name: "t3chris",
                    profile: { display_name: "t3_chris" },
                  },
                }),
            },
          }),
        }),
      );

      assert.equal(result.botUserName, "t3_chris");
    }),
  );

  it.effect("falls back to the bot profile real name when its display name is empty", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(
        provideApi({
          webClient: makeWebClient({
            auth: {
              test: () => Promise.resolve({ ...authResponse, user: "t3chris" }),
            },
            users: {
              info: ({ user }) =>
                Promise.resolve({
                  ok: true,
                  user: {
                    id: user,
                    name: "t3chris",
                    real_name: "t3_user_real_name",
                    profile: { display_name: "", real_name: "t3_chris" },
                  },
                }),
            },
          }),
        }),
      );

      assert.equal(result.botUserName, "t3_chris");
    }),
  );

  it.effect("keeps stable credential validation when the bot profile lookup fails", () =>
    Effect.gen(function* () {
      let botUsersInfoCalls = 0;
      const botClient = makeWebClient({
        auth: {
          test: () => Promise.resolve({ ...authResponse, user: "t3chris" }),
        },
        users: {
          info: () => {
            botUsersInfoCalls += 1;
            return Promise.reject(new Error("transient profile lookup failure"));
          },
        },
      });
      const appClient = makeWebClient({
        users: {
          info: () => Promise.reject(new Error("users.info must use the bot token")),
        },
      });

      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(
        provideApi({
          webClientForToken: (token) => (token === "xoxb-secret" ? botClient : appClient),
        }),
      );

      assert.equal(botUsersInfoCalls, 1);
      assert.equal(result.botUserName, undefined);
      assert.equal(result.botUserId, "U999");
    }),
  );

  it.effect("falls back when Slack rejects the optional bot profile lookup", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(
        provideApi({
          webClient: makeWebClient({
            auth: {
              test: () => Promise.resolve({ ...authResponse, user: "t3chris" }),
            },
            users: {
              info: () =>
                Promise.resolve({
                  ok: false,
                  error: "missing_scope",
                  needed: "users:read",
                  provided: "chat:write",
                }),
            },
          }),
        }),
      );

      assert.equal(result.botUserName, undefined);
      assert.equal(result.botUserId, "U999");
    }),
  );

  it.effect("uses the canonical username only when Slack returns no profile name", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.validateCredentials({
          appToken: "xapp-secret",
          botToken: "xoxb-secret",
        });
      }).pipe(
        provideApi({
          webClient: makeWebClient({
            auth: {
              test: () => Promise.resolve({ ...authResponse, user: "t3chris" }),
            },
            users: {
              info: ({ user }) =>
                Promise.resolve({
                  ok: true,
                  user: { id: user, name: "t3chris", profile: { display_name: "" } },
                }),
            },
          }),
        }),
      );

      assert.equal(result.botUserName, "t3chris");
    }),
  );

  it.effect("acks socket envelopes before processing them asynchronously", () =>
    Effect.gen(function* () {
      const socket = new FakeSocket();
      const order: Array<string> = [];
      const processed = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* SlackApi;
          yield* api.openSocket({
            appToken: "xapp-secret",
            onState: () => Effect.void,
            onEnvelope: () =>
              Effect.sync(() => {
                order.push("process");
              }).pipe(Effect.andThen(Deferred.succeed(processed, undefined))),
          });
          socket.emitEnvelope({
            envelopeId: "env-1",
            payload: { event: "app_mention" },
            ack: async () => {
              order.push("ack");
            },
          });
          yield* Deferred.await(processed);
        }).pipe(provideApi({ socket })),
      );

      assert.deepStrictEqual(order, ["ack", "process"]);
    }),
  );

  it.effect("reports socket ack failures and skips envelope processing", () =>
    Effect.gen(function* () {
      const socket = new FakeSocket();
      const order: Array<string> = [];
      const errors: Array<SlackApiError> = [];
      const errorReported = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* SlackApi;
          yield* api.openSocket({
            appToken: "xapp-secret",
            onState: (state) =>
              state.type === "error"
                ? Effect.sync(() => {
                    errors.push(state.error);
                  }).pipe(Effect.andThen(Deferred.succeed(errorReported, undefined)))
                : Effect.void,
            onEnvelope: () =>
              Effect.sync(() => {
                order.push("process");
              }),
          });
          socket.emitEnvelope({
            envelopeId: "env-1",
            payload: { event: "app_mention" },
            ack: () => {
              order.push("ack");
              return Promise.reject(new Error("ack rejected for xapp-secret"));
            },
          });
          yield* Deferred.await(errorReported);
        }).pipe(provideApi({ socket })),
      );

      assert.deepStrictEqual(order, ["ack"]);
      assert.equal(errors[0]?.operation, "SlackApi.openSocket.ack");
      assert.notInclude(errors[0]?.message ?? "", "xapp-secret");
    }),
  );

  it.effect("disconnects the socket when the scope closes", () =>
    Effect.gen(function* () {
      const socket = new FakeSocket();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* SlackApi;
          yield* api.openSocket({
            appToken: "xapp-secret",
            onState: () => Effect.void,
            onEnvelope: () => Effect.void,
          });
          assert.equal(socket.startCount, 1);
          assert.equal(socket.disconnectCount, 0);
        }).pipe(provideApi({ socket })),
      );
      assert.equal(socket.disconnectCount, 1);
    }),
  );

  it.effect("disconnects the socket when acquisition is interrupted before start resolves", () =>
    Effect.gen(function* () {
      let markStartCalled: (() => void) | undefined;
      const startCalled = new Promise<void>((resolve) => {
        markStartCalled = resolve;
      });
      const socket = new FakeSocket(() => {
        markStartCalled?.();
        return new Promise<AppsConnectionsOpenResponse>(() => {});
      });
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* SlackApi;
            yield* api.openSocket({
              appToken: "xapp-secret",
              onState: () => Effect.void,
              onEnvelope: () => Effect.void,
            });
          }).pipe(provideApi({ socket })),
        ),
      );

      yield* Effect.promise(() => startCalled);
      assert.equal(socket.startCount, 1);
      assert.equal(socket.disconnectCount, 0);
      yield* Fiber.interrupt(fiber);
      assert.equal(socket.disconnectCount, 1);
    }),
  );

  it.effect("maps Socket Mode reconnect and disconnect lifecycle events", () =>
    Effect.gen(function* () {
      const socket = new FakeSocket();
      const states: Array<string> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* SlackApi;
          yield* api.openSocket({
            appToken: "xapp-secret",
            onState: (state) =>
              Effect.sync(() => {
                states.push(state.type);
              }),
            onEnvelope: () => Effect.void,
          });
          socket.emitLifecycle("reconnecting");
          socket.emitLifecycle("disconnected");
          yield* Effect.yieldNow;
        }).pipe(provideApi({ socket })),
      );

      assert.deepStrictEqual(states.slice(0, 3), ["connected", "connecting", "disconnect"]);
      assert.equal(states.at(-1), "closed");
    }),
  );

  it.effect("paginates replies through the trigger timestamp", () =>
    Effect.gen(function* () {
      const pages = [
        {
          ok: true,
          response_metadata: { next_cursor: "next" },
          messages: [
            { client_msg_id: "m1", ts: "1700000001.000001", user: "U1", text: "one" },
            {
              client_msg_id: "m2",
              ts: "1700000002.000001",
              user: "U2",
              text: "two",
              files: [
                {
                  id: "F123",
                  name: "trace.log",
                  title: "Trace",
                  mimetype: "text/plain",
                  size: 42,
                  permalink: "https://slack.test/files/F123",
                },
              ],
            },
          ],
        },
        {
          ok: true,
          messages: [
            { client_msg_id: "m3", ts: "1700000003.000001", user: "U2", text: "three" },
            { client_msg_id: "m4", ts: "1700000004.000001", user: "U4", text: "after" },
          ],
        },
      ];
      const calls: Array<string | undefined> = [];
      const userCalls: Array<string> = [];
      const webClient = makeWebClient({
        conversations: {
          ...makeWebClient().conversations,
          replies: async (request) => {
            calls.push(request.cursor);
            return pages.shift() ?? { ok: true, messages: [] };
          },
        },
        users: {
          info: ({ user }) => {
            userCalls.push(user);
            return Promise.resolve({ ok: true, user: { id: user, name: `name-${user}` } });
          },
        },
      });

      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.fetchThreadThrough({
          botToken: "xoxb-secret",
          channelId: "C123",
          threadTs: "1700000001.000001",
          triggerTs: "1700000003.000001",
        });
      }).pipe(provideApi({ webClient }));

      assert.deepStrictEqual(calls, [undefined, "next"]);
      assert.deepStrictEqual(userCalls, ["U1", "U2"]);
      assert.deepStrictEqual(
        result.messages.map((message) => [
          message.messageId,
          message.authorLabel,
          message.text,
          message.files,
        ]),
        [
          ["m1", "name-U1", "one", []],
          [
            "m2",
            "name-U2",
            "two",
            [
              {
                id: "F123",
                name: "trace.log",
                title: "Trace",
                mimetype: "text/plain",
                size: 42,
                permalink: "https://slack.test/files/F123",
              },
            ],
          ],
          ["m3", "name-U2", "three", []],
        ],
      );
    }),
  );

  it.effect("keeps the trailing bounded window when the trigger is beyond the message cap", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: SLACK_THREAD_SNAPSHOT_MAX_MESSAGES }, (_, index) => ({
        client_msg_id: `m${index}`,
        ts: `170000${String(index).padStart(4, "0")}.000001`,
        user: "U1",
        text: `message ${index}`,
      }));
      const calls: Array<string | undefined> = [];
      let page = 0;
      const webClient = makeWebClient({
        conversations: {
          ...makeWebClient().conversations,
          replies: async (request) => {
            calls.push(request.cursor);
            page += 1;
            return page === 1
              ? {
                  ok: true,
                  response_metadata: { next_cursor: "next" },
                  messages,
                }
              : {
                  ok: true,
                  response_metadata: { next_cursor: "" },
                  messages: [
                    {
                      client_msg_id: "trigger",
                      ts: "1700099999.000001",
                      user: "U1",
                      text: "trigger message",
                    },
                  ],
                };
          },
        },
      });

      const result = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api.fetchThreadThrough({
          botToken: "xoxb-secret",
          channelId: "C123",
          threadTs: "1700000000.000001",
          triggerTs: "1700099999.000001",
        });
      }).pipe(provideApi({ webClient }));

      assert.deepStrictEqual(calls, [undefined, "next"]);
      assert.equal(result.messages.length, SLACK_THREAD_SNAPSHOT_MAX_MESSAGES);
      assert.equal(result.messages[0]?.messageId, "m1");
      assert.equal(result.messages.at(-1)?.messageId, "trigger");
    }),
  );

  it.effect("redacts token-shaped values from Slack errors and preserves retry hints", () =>
    Effect.gen(function* () {
      const webClient = makeWebClient({
        chat: {
          ...makeWebClient().chat,
          postMessage: () =>
            Promise.reject({
              message: "Authorization: Bearer xoxb-secret failed for xapp-secret",
              retryAfter: 2,
            }),
        },
      });
      const error = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* api["postMessage"]({
          botToken: "xoxb-secret",
          channelId: "C123",
          threadTs: "1700000001.000001",
          text: "hello",
        });
      }).pipe(provideApi({ webClient }), Effect.flip);

      assert.instanceOf(error, SlackApiError);
      assert.equal(error.retryAfterMs, 2_000);
      assert.notInclude(error.message, "xoxb-secret");
      assert.notInclude(error.message, "xapp-secret");
      assert.include(error.message, "[redacted-token]");
      assert.equal(error.cause, undefined);
    }),
  );

  it.effect("resolves channel names and falls back to user IDs for missing profiles", () =>
    Effect.gen(function* () {
      const webClient = makeWebClient({
        conversations: {
          ...makeWebClient().conversations,
          info: () => Promise.resolve({ ok: true, channel: { id: "C123", name: "engineering" } }),
        },
        users: {
          info: () => Promise.resolve({ ok: true, user: {} }),
        },
      });

      const [channelName, userLabel] = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* Effect.all([
          api.resolveChannelName({
            botToken: "xoxb-secret",
            channelId: "C123",
          }),
          api.resolveUserLabel({
            botToken: "xoxb-secret",
            userId: "U123",
          }),
        ]);
      }).pipe(provideApi({ webClient }));

      assert.equal(channelName, "engineering");
      assert.equal(userLabel, "U123");
    }),
  );

  it.effect("posts and updates threaded messages", () =>
    Effect.gen(function* () {
      const posted: Array<string> = [];
      const updated: Array<string> = [];
      const webClient = makeWebClient({
        chat: {
          postMessage: async (request) => {
            posted.push(`${request.channel}:${request.thread_ts}:${request.text}`);
            return { ok: true, channel: request.channel, ts: "1700000002.000001" };
          },
          update: async (request) => {
            updated.push(`${request.channel}:${request.ts}:${request.text}`);
            return { ok: true, channel: request.channel, ts: request.ts };
          },
        },
      });

      const [postResult, updateResult] = yield* Effect.gen(function* () {
        const api = yield* SlackApi;
        return yield* Effect.all([
          api["postMessage"]({
            botToken: "xoxb-secret",
            channelId: "C123",
            threadTs: "1700000001.000001",
            text: "hello",
          }),
          api.updateMessage({
            botToken: "xoxb-secret",
            channelId: "C123",
            threadTs: "1700000001.000001",
            messageTs: "1700000002.000001",
            text: "updated",
          }),
        ]);
      }).pipe(provideApi({ webClient }));

      assert.deepStrictEqual(postResult, {
        channelId: "C123",
        messageTs: "1700000002.000001",
      });
      assert.deepStrictEqual(updateResult, {
        channelId: "C123",
        messageTs: "1700000002.000001",
      });
      assert.deepStrictEqual(posted, ["C123:1700000001.000001:hello"]);
      assert.deepStrictEqual(updated, ["C123:1700000002.000001:updated"]);
    }),
  );
});
