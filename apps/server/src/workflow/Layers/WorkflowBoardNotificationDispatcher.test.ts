import { assert, describe, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowBoardNotificationDispatcher } from "../Services/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowBoardNotificationRelay } from "../Services/WorkflowBoardNotificationRelay.ts";
import {
  WorkflowReadModel,
  type TicketDetail,
  type TicketRow,
} from "../Services/WorkflowReadModel.ts";
import { makeWorkflowBoardNotificationDispatcherLive } from "./WorkflowBoardNotificationDispatcher.ts";

const ENV_ID = "env-1" as EnvironmentId;

interface PublishCall {
  readonly environmentId: EnvironmentId;
  readonly boardId: string;
  readonly ticketId: string;
  readonly state: RelayBoardTicketState;
}

// Mutable per-test recorder for the stub relay. Reset in each test setup.
interface RelayRecorder {
  calls: Array<PublishCall>;
  failQueue: Array<"ok" | "fail">;
}

const makeRecorder = (failQueue: ReadonlyArray<"ok" | "fail"> = []): RelayRecorder => ({
  calls: [],
  failQueue: [...failQueue],
});

const stubRelayLayer = (recorder: RelayRecorder) =>
  Layer.succeed(WorkflowBoardNotificationRelay, {
    publishTicket: (input) =>
      Effect.suspend(() => {
        recorder.calls.push(input);
        const outcome = recorder.failQueue.length === 0 ? "ok" : recorder.failQueue.shift()!;
        return outcome === "fail"
          ? Effect.fail(new WorkflowEventStoreError({ message: "stub relay failure" }))
          : Effect.void;
      }),
  } satisfies WorkflowBoardNotificationRelay["Service"]);

const makeTicketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  ticketId: "ticket-1",
  boardId: "board-1",
  title: "Fix the thing",
  description: null,
  currentLaneKey: "review",
  currentLaneEntryToken: null,
  status: "waiting_on_user",
  queuedAt: null,
  totalTokens: null,
  totalDurationMs: null,
  attentionKind: "waiting_for_input",
  attentionReason: "please review",
  ...over,
});

const detail = (ticket: TicketRow): TicketDetail => ({ ticket, steps: [], messages: [] });

// Stub read model: only getTicketDetail is exercised by the dispatcher.
const stubReadModelLayer = (byTicket: Record<string, TicketDetail | null>) =>
  Layer.succeed(WorkflowReadModel, {
    getTicketDetail: (ticketId: string) => Effect.succeed(byTicket[ticketId] ?? null),
  } as unknown as WorkflowReadModel["Service"]) as Layer.Layer<WorkflowReadModel>;

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENV_ID),
  getDescriptor: Effect.die("unsupported descriptor read"),
} as unknown as ServerEnvironment["Service"]) as Layer.Layer<ServerEnvironment>;

const insertOutboxRow = (over: {
  readonly outboxId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly status: string;
  readonly attentionKind?: string | null;
  readonly attentionReason?: string | null;
  readonly deliveryState?: string;
  readonly attemptCount?: number;
  readonly createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workflow_notification_outbox (
        outbox_id, ticket_id, board_id, sequence, status,
        attention_kind, attention_reason, delivery_state, attempt_count, created_at
      ) VALUES (
        ${over.outboxId}, ${over.ticketId}, ${over.boardId}, ${over.sequence}, ${over.status},
        ${over.attentionKind ?? null}, ${over.attentionReason ?? null},
        ${over.deliveryState ?? "pending"}, ${over.attemptCount ?? 0},
        ${over.createdAt ?? "2026-06-12T00:00:00.000Z"}
      )
    `;
  });

const readOutbox = (outboxId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly delivery_state: string;
      readonly attempt_count: number;
    }>`
      SELECT delivery_state AS "delivery_state", attempt_count AS "attempt_count"
      FROM workflow_notification_outbox WHERE outbox_id = ${outboxId}
    `;
    return rows[0]!;
  });

const buildLayer = (recorder: RelayRecorder, byTicket: Record<string, TicketDetail | null>) =>
  makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(stubRelayLayer(recorder)),
    Layer.provideMerge(stubReadModelLayer(byTicket)),
    Layer.provideMerge(serverEnvironmentLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

describe.sequential("WorkflowBoardNotificationDispatcher", () => {
  it.effect("publishes a pending needs-you row and marks it sent", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-1",
        ticketId: "ticket-1",
        boardId: "board-1",
        sequence: 7,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "please review",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.claimed, 1);
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.superseded, 0);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(recorder.calls.length, 1);
      const call = recorder.calls[0]!;
      assert.strictEqual(call.boardId, "board-1");
      assert.strictEqual(call.ticketId, "ticket-1");
      assert.strictEqual(call.state.attentionKind, "waiting_for_input");
      assert.strictEqual(call.state.title, "Fix the thing");
      assert.strictEqual(call.state.body, "please review");
      assert.strictEqual(call.state.deepLink, "/tickets/env-1/board-1/ticket-1");
      assert.strictEqual(call.state.transitionId, "7");

      const row = yield* readOutbox("ob-1");
      assert.strictEqual(row.delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-1": detail(makeTicketRow({ status: "waiting_on_user" })),
        }),
      ),
    );
  });

  it.effect("supersedes a row whose ticket has left needs-you", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-2",
        ticketId: "ticket-2",
        boardId: "board-1",
        sequence: 8,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "stale",
      });
      yield* insertOutboxRow({
        outboxId: "ob-3",
        ticketId: "ticket-3",
        boardId: "board-1",
        sequence: 9,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "gone",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.superseded, 2);
      assert.strictEqual(result.sent, 0);
      assert.strictEqual(recorder.calls.length, 0);
      assert.strictEqual((yield* readOutbox("ob-2")).delivery_state, "superseded");
      assert.strictEqual((yield* readOutbox("ob-3")).delivery_state, "superseded");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          // ticket-2 left needs-you (now running); ticket-3 detail missing (null).
          "ticket-2": detail(makeTicketRow({ ticketId: "ticket-2", status: "running" })),
          "ticket-3": null,
        }),
      ),
    );
  });

  it.effect("retries on relay failure then gives up at the attempt ceiling", () => {
    // Five consecutive failures across five sweeps → row ends 'failed'.
    const recorder = makeRecorder(["fail", "fail", "fail", "fail", "fail"]);
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-4",
        ticketId: "ticket-4",
        boardId: "board-1",
        sequence: 10,
        status: "blocked",
        attentionKind: "blocked",
        attentionReason: "needs help",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;

      // Sweeps 1-4: stays pending, attempt_count climbs.
      for (let i = 1; i <= 4; i++) {
        const r = yield* dispatcher.sweep();
        assert.strictEqual(r.failed, 1, `sweep ${i} failed count`);
        const row = yield* readOutbox("ob-4");
        assert.strictEqual(row.delivery_state, "pending", `sweep ${i} state`);
        assert.strictEqual(row.attempt_count, i, `sweep ${i} attempts`);
      }

      // Sweep 5: 5th attempt hits the ceiling → 'failed'.
      const r5 = yield* dispatcher.sweep();
      assert.strictEqual(r5.failed, 1);
      const after = yield* readOutbox("ob-4");
      assert.strictEqual(after.delivery_state, "failed");
      assert.strictEqual(after.attempt_count, 5);
      assert.strictEqual(recorder.calls.length, 5);

      // Sweep 6: failed rows are not re-selected → no new publish.
      const r6 = yield* dispatcher.sweep();
      assert.strictEqual(r6.claimed, 0);
      assert.strictEqual(recorder.calls.length, 5);
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-4": detail(
            makeTicketRow({
              ticketId: "ticket-4",
              status: "blocked",
              attentionKind: "blocked",
              attentionReason: "needs help",
            }),
          ),
        }),
      ),
    );
  });

  it.effect("drains a pre-existing pending row (startup drain)", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-5",
        ticketId: "ticket-5",
        boardId: "board-1",
        sequence: 11,
        status: "waiting_on_user",
        attentionKind: "waiting_for_approval",
        attentionReason: "approve me",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(recorder.calls[0]!.state.attentionKind, "waiting_for_approval");
      assert.strictEqual((yield* readOutbox("ob-5")).delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-5": detail(
            makeTicketRow({
              ticketId: "ticket-5",
              status: "waiting_on_user",
              attentionKind: "waiting_for_approval",
              attentionReason: "approve me",
            }),
          ),
        }),
      ),
    );
  });

  it.effect("falls back to a non-empty title when the ticket title is blank", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-8",
        ticketId: "ticket-8",
        boardId: "board-1",
        sequence: 14,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "please review",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(recorder.calls.length, 1);
      const title = recorder.calls[0]!.state.title;
      // The relay decodes title as TrimmedNonEmptyString; a whitespace title
      // must be replaced with the non-empty fallback before publish.
      assert.isTrue(title.trim().length > 0, "blank title falls back to non-empty title");
      assert.strictEqual(title, "Ticket needs your attention");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-8": detail(makeTicketRow({ ticketId: "ticket-8", title: "   " })),
        }),
      ),
    );
  });

  it.effect("redacts and caps the body, and falls back when reason is empty", () => {
    const recorder = makeRecorder();
    const secret = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const longReason = `token leak ${secret} ` + "x".repeat(400);
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-6",
        ticketId: "ticket-6",
        boardId: "board-1",
        sequence: 12,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: longReason,
      });
      yield* insertOutboxRow({
        outboxId: "ob-7",
        ticketId: "ticket-7",
        boardId: "board-1",
        sequence: 13,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      yield* dispatcher.sweep();

      const byTicket = Object.fromEntries(recorder.calls.map((c) => [c.ticketId, c]));
      const redactedBody = byTicket["ticket-6"]!.state.body;
      assert.isFalse(redactedBody.includes(secret), "raw secret must not appear");
      assert.isAtMost(redactedBody.length, 240, "body capped to MAX_NOTIFICATION_BODY");

      const fallbackBody = byTicket["ticket-7"]!.state.body;
      assert.isTrue(fallbackBody.trim().length > 0, "empty reason falls back to non-empty body");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-6": detail(makeTicketRow({ ticketId: "ticket-6", attentionReason: longReason })),
          "ticket-7": detail(makeTicketRow({ ticketId: "ticket-7", attentionReason: "" })),
        }),
      ),
    );
  });

  it.effect(
    "does not resurrect a row the committer superseded during a failed publish (M11)",
    () => {
      // Regression: the dispatcher SELECTs a pending row, the relay publish fails,
      // and concurrently the committer supersedes the row (a newer needs-you
      // transition committed for the same ticket). The retry re-mark must be a
      // no-op once the row has left 'pending', or the superseded transition gets
      // resurrected and re-delivered as a stale push. The relay stub below
      // supersedes the row mid-publish (standing in for the committer's UPDATE
      // landing during the publish round-trip), then fails — exercising the retry
      // path against an already-superseded row.
      const supersedingRelayLayer = Layer.effect(
        WorkflowBoardNotificationRelay,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            publishTicket: () =>
              Effect.gen(function* () {
                // SqlError here would be an infra failure, not part of the relay
                // contract (WorkflowEventStoreError only) — orDie keeps the failure
                // channel aligned with the publishTicket signature.
                yield* sql`UPDATE workflow_notification_outbox SET delivery_state = 'superseded' WHERE outbox_id = ${"ob-m11"}`.pipe(
                  Effect.orDie,
                );
                return yield* new WorkflowEventStoreError({ message: "stub relay failure" });
              }),
          } satisfies WorkflowBoardNotificationRelay["Service"];
        }),
      );

      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-m11",
          ticketId: "ticket-m11",
          boardId: "board-1",
          sequence: 5,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "please review",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();
        assert.strictEqual(result.failed, 1);

        // The row must stay 'superseded' — the guarded retry re-mark must NOT
        // flip it back to 'pending' (which would re-deliver the stale transition).
        const row = yield* readOutbox("ob-m11");
        assert.strictEqual(row.delivery_state, "superseded");
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(supersedingRelayLayer),
            Layer.provideMerge(
              stubReadModelLayer({
                "ticket-m11": detail(makeTicketRow({ ticketId: "ticket-m11" })),
              }),
            ),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );

  it.effect(
    "does not publish a stale row when TicketParked supersedes it before the atomic claim (gate 1 race)",
    () => {
      // Regression: the sweep SELECTs row A (pending). Before processRow can
      // claim it, a TicketParked commit lands for the same ticket: the
      // committer supersedes row A and inserts a fresh pending row B. Because
      // 'parked' is ITSELF a needs-you status, the relevance recheck (which
      // only looks at the ticket's current status) still passes — the bug
      // this closes is that the OLD code then published row A's stale
      // `state` unconditionally and unconditionally marked it 'sent',
      // clobbering the committer's 'superseded' write. The read-model stub
      // below performs the committer's supersede-and-insert as a side effect
      // of getTicketDetail, standing in for the commit landing in the
      // SELECT→recheck window. With the atomic claim in place, processRow's
      // claimRow call (which runs AFTER this side effect) finds row A already
      // 'superseded' and returns "superseded" without ever calling
      // relay.publishTicket.
      const supersedingReadModelLayer = Layer.effect(
        WorkflowReadModel,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            getTicketDetail: (ticketId: string) =>
              Effect.gen(function* () {
                if (ticketId === "ticket-race") {
                  yield* sql`
                    UPDATE workflow_notification_outbox
                    SET delivery_state = 'superseded'
                    WHERE ticket_id = ${"ticket-race"}
                      AND delivery_state = 'pending'
                      AND sequence != 99
                  `;
                  yield* sql`
                    INSERT INTO workflow_notification_outbox (
                      outbox_id, ticket_id, board_id, sequence, status,
                      attention_kind, attention_reason, delivery_state, attempt_count, created_at
                    ) VALUES (
                      'ob-race-b', 'ticket-race', 'board-1', 99, 'parked',
                      'parked_waiting', 'Waiting on you: newer', 'pending', 0,
                      '2026-06-12T00:00:00.000Z'
                    )
                  `;
                }
                return detail(
                  makeTicketRow({
                    ticketId: "ticket-race",
                    status: "parked",
                    attentionKind: "parked_waiting",
                    attentionReason: "Waiting on you: newer",
                  }),
                );
              }).pipe(Effect.orDie),
          } as unknown as WorkflowReadModel["Service"];
        }),
      );

      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-race-a",
          ticketId: "ticket-race",
          boardId: "board-1",
          sequence: 50,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stale reason",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        // Only row A was pending when the sweep SELECTed; row B was inserted
        // mid-recheck so this sweep only claimed (selected) row A.
        assert.strictEqual(result.claimed, 1);
        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 0);
        assert.strictEqual(recorder.calls.length, 0, "must never publish the stale row");

        const rowA = yield* readOutbox("ob-race-a");
        assert.strictEqual(rowA.delivery_state, "superseded");

        const rowB = yield* readOutbox("ob-race-b");
        assert.strictEqual(rowB.delivery_state, "pending", "row B awaits its own sweep");
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(stubRelayLayer(recorder)),
            Layer.provideMerge(supersedingReadModelLayer),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );

  it.effect("publishes a parked_issue row unchanged (status='parked' is needs-you)", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-park-issue",
        ticketId: "ticket-park-issue",
        boardId: "board-1",
        sequence: 20,
        status: "parked",
        attentionKind: "parked_issue",
        attentionReason: '"Fix" hit an issue: boom',
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.superseded, 0);
      assert.strictEqual(recorder.calls.length, 1);
      // normalizeAttentionKind must pass parked_issue through unchanged, not
      // fall back to waiting_for_input.
      assert.strictEqual(recorder.calls[0]!.state.attentionKind, "parked_issue");
      assert.strictEqual((yield* readOutbox("ob-park-issue")).delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-park-issue": detail(
            makeTicketRow({
              ticketId: "ticket-park-issue",
              status: "parked",
              attentionKind: "parked_issue",
              attentionReason: '"Fix" hit an issue: boom',
            }),
          ),
        }),
      ),
    );
  });

  it.effect("publishes a parked_waiting row unchanged (status='parked' is needs-you)", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-park-waiting",
        ticketId: "ticket-park-waiting",
        boardId: "board-1",
        sequence: 21,
        status: "parked",
        attentionKind: "parked_waiting",
        attentionReason: '"Fix" is waiting on you: Needs manual review',
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.superseded, 0);
      assert.strictEqual(recorder.calls.length, 1);
      assert.strictEqual(recorder.calls[0]!.state.attentionKind, "parked_waiting");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-park-waiting": detail(
            makeTicketRow({
              ticketId: "ticket-park-waiting",
              status: "parked",
              attentionKind: "parked_waiting",
              attentionReason: '"Fix" is waiting on you: Needs manual review',
            }),
          ),
        }),
      ),
    );
  });

  it.effect(
    "CAS success-mark loses to the committer's widened supersede mid-publish; row ends superseded, never sent (gate-1 re-gate NEW-1)",
    () => {
      // Models the REAL committer race, not a stand-in: row A is claimed
      // 'publishing', then — while the relay call is in flight — the
      // committer's ACTUAL widened supersede UPDATE (`delivery_state IN
      // ('pending', 'publishing')`, see WorkflowEventCommitter.ts) lands for a
      // fresh transition on the same ticket, exactly as it would from a
      // concurrent TicketParked re-commit. Even though the publish call itself
      // succeeds, the post-publish CAS (`SET delivery_state='sent' WHERE ...
      // AND delivery_state='publishing'`) must lose to the committer's write:
      // the row ends 'superseded', never clobbered back to 'sent'.
      const supersedingRelayLayer = Layer.effect(
        WorkflowBoardNotificationRelay,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            publishTicket: () =>
              Effect.gen(function* () {
                // Exact replica of WorkflowEventCommitter's widened supersede guard.
                yield* sql`
                  UPDATE workflow_notification_outbox
                  SET delivery_state = 'superseded'
                  WHERE ticket_id = ${"ticket-cas-success"}
                    AND delivery_state IN ('pending', 'publishing')
                    AND sequence != 99
                `;
                yield* sql`
                  INSERT INTO workflow_notification_outbox (
                    outbox_id, ticket_id, board_id, sequence, status,
                    attention_kind, attention_reason, delivery_state, attempt_count, created_at
                  ) VALUES (
                    'ob-cas-success-b', 'ticket-cas-success', 'board-1', 99, 'parked',
                    'parked_waiting', 'Waiting on you: newer', 'pending', 0,
                    '2026-06-12T00:00:00.000Z'
                  )
                `;
              }).pipe(Effect.orDie),
          } satisfies WorkflowBoardNotificationRelay["Service"];
        }),
      );

      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-cas-success-a",
          ticketId: "ticket-cas-success",
          boardId: "board-1",
          sequence: 50,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stale",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 0);

        const rowA = yield* readOutbox("ob-cas-success-a");
        assert.strictEqual(
          rowA.delivery_state,
          "superseded",
          "the CAS must not clobber the committer's supersede with 'sent'",
        );

        const rowB = yield* readOutbox("ob-cas-success-b");
        assert.strictEqual(rowB.delivery_state, "pending", "row B awaits its own sweep");
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(supersedingRelayLayer),
            Layer.provideMerge(
              stubReadModelLayer({
                "ticket-cas-success": detail(
                  makeTicketRow({ ticketId: "ticket-cas-success", status: "waiting_on_user" }),
                ),
              }),
            ),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );

  it.effect(
    "CAS success-mark loses to a LEAVE-needs-you supersede mid-publish (no replacement row); row ends superseded, never sent (gate-1 round-3 NEW-2)",
    () => {
      // Models the committer's LEAVE-needs-you supersede (NEW-2): a
      // waiting_on_user row A is claimed 'publishing', then — while the relay
      // call is in flight — the ticket LEAVES needs-you (e.g. StepUserResolved →
      // running). The real committer runs the SAME pending+publishing supersede
      // UPDATE but, unlike the crossing-INTO path, inserts NO replacement row.
      // (The real leave path is proven end-to-end in WorkflowEventCommitter.test.
      // "supersedes an in-flight publishing row when the ticket LEAVES needs-you
      // via StepUserResolved"; here we assert the dispatcher's CAS loses to it.)
      // Even though the publish succeeds, the post-publish CAS
      // (`SET delivery_state='sent' WHERE ... AND delivery_state='publishing'`)
      // must lose: the row ends 'superseded', never clobbered back to 'sent'.
      const leaveSupersedeRelayLayer = Layer.effect(
        WorkflowBoardNotificationRelay,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            // Exact replica of the committer's leave-supersede UPDATE — note the
            // deliberate absence of any follow-up INSERT (a leave supersede
            // inserts no replacement row, unlike the crossing-INTO path).
            publishTicket: () =>
              sql`
                UPDATE workflow_notification_outbox
                SET delivery_state = 'superseded'
                WHERE ticket_id = ${"ticket-leave-cas"}
                  AND delivery_state IN ('pending', 'publishing')
                  AND sequence != 999
              `.pipe(Effect.asVoid, Effect.orDie),
          } satisfies WorkflowBoardNotificationRelay["Service"];
        }),
      );

      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-leave-cas-a",
          ticketId: "ticket-leave-cas",
          boardId: "board-1",
          sequence: 40,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stale",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 0);

        const rowA = yield* readOutbox("ob-leave-cas-a");
        assert.strictEqual(
          rowA.delivery_state,
          "superseded",
          "the CAS must not clobber the leave-supersede with 'sent'",
        );
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(leaveSupersedeRelayLayer),
            Layer.provideMerge(
              stubReadModelLayer({
                "ticket-leave-cas": detail(
                  makeTicketRow({ ticketId: "ticket-leave-cas", status: "waiting_on_user" }),
                ),
              }),
            ),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );

  it.effect(
    "reschedule no-ops after the committer's widened supersede mid-publish + a failed push; row stays superseded and is never re-delivered (gate-1 re-gate NEW-1/NEW-3)",
    () => {
      // Same real-committer race as the previous test, but the in-flight push
      // FAILS instead of succeeding. `fired` limits the race to the row A
      // publish call only — a real committer supersede is a one-time event
      // for a given transition, not a permanent relay behavior, and without
      // this guard the second sweep's publish of row B would attempt to
      // INSERT the same 'ob-cas-fail-b' primary key again and blow up on a
      // constraint violation instead of exercising what we actually want to
      // assert: that row A is never resurrected and row B is delivered
      // normally on its own, later sweep.
      let fired = false;
      const supersedingRelayLayer = Layer.effect(
        WorkflowBoardNotificationRelay,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            publishTicket: (input) =>
              Effect.gen(function* () {
                if (fired || input.ticketId !== "ticket-cas-fail") {
                  return;
                }
                fired = true;
                // Exact replica of WorkflowEventCommitter's widened supersede guard.
                yield* sql`
                  UPDATE workflow_notification_outbox
                  SET delivery_state = 'superseded'
                  WHERE ticket_id = ${"ticket-cas-fail"}
                    AND delivery_state IN ('pending', 'publishing')
                    AND sequence != 77
                `.pipe(Effect.orDie);
                yield* sql`
                  INSERT INTO workflow_notification_outbox (
                    outbox_id, ticket_id, board_id, sequence, status,
                    attention_kind, attention_reason, delivery_state, attempt_count, created_at
                  ) VALUES (
                    'ob-cas-fail-b', 'ticket-cas-fail', 'board-1', 77, 'parked',
                    'parked_waiting', 'Waiting on you: newer', 'pending', 0,
                    '2026-06-12T00:00:00.000Z'
                  )
                `.pipe(Effect.orDie);
                return yield* new WorkflowEventStoreError({ message: "stub relay failure" });
              }),
          } satisfies WorkflowBoardNotificationRelay["Service"];
        }),
      );

      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-cas-fail-a",
          ticketId: "ticket-cas-fail",
          boardId: "board-1",
          sequence: 30,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stale",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();
        assert.strictEqual(result.failed, 1);

        // rescheduleRetry is guarded on 'publishing'; row A already left
        // 'publishing' for 'superseded' via the committer's write, so the
        // retry re-mark must be a no-op — row A stays 'superseded', never
        // resurrected to 'pending'.
        const rowAAfterFirstSweep = yield* readOutbox("ob-cas-fail-a");
        assert.strictEqual(rowAAfterFirstSweep.delivery_state, "superseded");

        // Next sweep: only row B (the ticket's true latest, still 'pending')
        // is selected and delivered; row A is never re-selected or resurrected.
        const result2 = yield* dispatcher.sweep();
        assert.strictEqual(result2.claimed, 1);
        assert.strictEqual(result2.sent, 1);

        const rowAAfterSecondSweep = yield* readOutbox("ob-cas-fail-a");
        assert.strictEqual(
          rowAAfterSecondSweep.delivery_state,
          "superseded",
          "row A must never be re-delivered",
        );
        const rowB = yield* readOutbox("ob-cas-fail-b");
        assert.strictEqual(rowB.delivery_state, "sent");
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(supersedingRelayLayer),
            Layer.provideMerge(
              stubReadModelLayer({
                "ticket-cas-fail": detail(
                  makeTicketRow({ ticketId: "ticket-cas-fail", status: "waiting_on_user" }),
                ),
              }),
            ),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );

  it.effect(
    "un-claims via CAS when a newer needs-you row already exists at claim time (pre-publish latest-sequence check)",
    () => {
      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-seqcheck-a",
          ticketId: "ticket-seqcheck",
          boardId: "board-1",
          sequence: 10,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stale",
          createdAt: "2026-06-12T00:00:00.000Z",
        });
        yield* insertOutboxRow({
          outboxId: "ob-seqcheck-b",
          ticketId: "ticket-seqcheck",
          boardId: "board-1",
          sequence: 20,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "fresh",
          createdAt: "2026-06-12T00:00:01.000Z",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        // Row A is selected+claimed but un-claimed straight back to
        // 'superseded' by the pre-publish latest-sequence check, BEFORE
        // relay.publishTicket is ever called for it; row B — the ticket's
        // true latest — is published normally in the same sweep.
        assert.strictEqual(result.claimed, 2);
        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 1);
        assert.strictEqual(recorder.calls.length, 1, "row A must never reach relay.publishTicket");
        assert.strictEqual(recorder.calls[0]!.state.transitionId, "20");

        assert.strictEqual((yield* readOutbox("ob-seqcheck-a")).delivery_state, "superseded");
        assert.strictEqual((yield* readOutbox("ob-seqcheck-b")).delivery_state, "sent");
      }).pipe(
        Effect.provide(
          buildLayer(recorder, {
            "ticket-seqcheck": detail(
              makeTicketRow({ ticketId: "ticket-seqcheck", status: "waiting_on_user" }),
            ),
          }),
        ),
      );
    },
  );

  it.effect(
    "reclaims a row stranded 'publishing' by a crash and delivers it on the next sweep (regression)",
    () => {
      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-reclaim",
          ticketId: "ticket-reclaim",
          boardId: "board-1",
          sequence: 40,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "stuck mid-publish",
          deliveryState: "publishing",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.claimed, 1);
        assert.strictEqual(result.sent, 1);
        assert.strictEqual(recorder.calls.length, 1);
        assert.strictEqual((yield* readOutbox("ob-reclaim")).delivery_state, "sent");
      }).pipe(
        Effect.provide(
          buildLayer(recorder, {
            "ticket-reclaim": detail(
              makeTicketRow({ ticketId: "ticket-reclaim", status: "waiting_on_user" }),
            ),
          }),
        ),
      );
    },
  );

  it.effect("falls back an unknown attention kind to waiting_for_input (regression)", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-unknown-kind",
        ticketId: "ticket-unknown-kind",
        boardId: "board-1",
        sequence: 22,
        status: "waiting_on_user",
        attentionKind: "some_future_kind",
        attentionReason: "please review",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(recorder.calls.length, 1);
      assert.strictEqual(recorder.calls[0]!.state.attentionKind, "waiting_for_input");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-unknown-kind": detail(
            makeTicketRow({
              ticketId: "ticket-unknown-kind",
              status: "waiting_on_user",
              attentionKind: "some_future_kind",
              attentionReason: "please review",
            }),
          ),
        }),
      ),
    );
  });

  it.effect(
    "publishes an idle SLA breach row and maps outbox kind to legacy wire attention",
    () => {
      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-sla-idle",
          ticketId: "ticket-sla-idle",
          boardId: "board-1",
          sequence: 50,
          status: "idle",
          attentionKind: "sla_breached",
          attentionReason: "SLA breached in review",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.sent, 1);
        assert.strictEqual(result.superseded, 0);
        assert.strictEqual(recorder.calls.length, 1);
        const call = recorder.calls[0]!;
        // Internal sla_breached kind is not a wire attention kind.
        assert.strictEqual(call.state.attentionKind, "waiting_for_input");
        assert.strictEqual(call.state.body, "SLA breached in review");
        assert.strictEqual(call.state.transitionId, "50");
        assert.strictEqual((yield* readOutbox("ob-sla-idle")).delivery_state, "sent");
      }).pipe(
        Effect.provide(
          buildLayer(recorder, {
            "ticket-sla-idle": detail(
              makeTicketRow({
                ticketId: "ticket-sla-idle",
                status: "idle",
                currentLaneEntryToken: "tok-sla-idle",
                slaBreachedAt: "2026-06-12T04:00:00.000Z",
                slaBreachedEntryToken: "tok-sla-idle",
                slaBreachedReason: "SLA breached in review",
              }),
            ),
          }),
        ),
      );
    },
  );

  it.effect(
    "supersedes an SLA outbox row when the breach token no longer matches the live lane token",
    () => {
      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-sla-stale",
          ticketId: "ticket-sla-stale",
          boardId: "board-1",
          sequence: 51,
          status: "idle",
          attentionKind: "sla_breached",
          attentionReason: "SLA breached in review",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 0);
        assert.strictEqual(recorder.calls.length, 0);
        assert.strictEqual((yield* readOutbox("ob-sla-stale")).delivery_state, "superseded");
      }).pipe(
        Effect.provide(
          buildLayer(recorder, {
            // Ticket moved to a new lane entry after the outbox row was written —
            // current token no longer equals the breach token (stale/moved).
            "ticket-sla-stale": detail(
              makeTicketRow({
                ticketId: "ticket-sla-stale",
                status: "idle",
                currentLaneKey: "escalation",
                currentLaneEntryToken: "tok-new-entry",
                slaBreachedAt: null,
                slaBreachedEntryToken: null,
              }),
            ),
          }),
        ),
      );
    },
  );

  it.effect(
    "supersedes an SLA outbox row when tokens mismatch even if slaBreachedAt is still set",
    () => {
      const recorder = makeRecorder();
      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-sla-mismatch",
          ticketId: "ticket-sla-mismatch",
          boardId: "board-1",
          sequence: 52,
          status: "running",
          attentionKind: "sla_breached",
          attentionReason: "SLA breached in review",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();

        assert.strictEqual(result.superseded, 1);
        assert.strictEqual(result.sent, 0);
        assert.strictEqual(recorder.calls.length, 0);
      }).pipe(
        Effect.provide(
          buildLayer(recorder, {
            "ticket-sla-mismatch": detail(
              makeTicketRow({
                ticketId: "ticket-sla-mismatch",
                status: "running",
                currentLaneEntryToken: "tok-live",
                slaBreachedAt: "2026-06-12T04:00:00.000Z",
                // Breach recorded against a prior entry token — recheck fails.
                slaBreachedEntryToken: "tok-old",
              }),
            ),
          }),
        ),
      );
    },
  );
});
