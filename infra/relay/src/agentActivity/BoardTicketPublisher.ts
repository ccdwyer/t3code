import type {
  RelayBoardTicketState,
  RelayDeliveryResult,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import { RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema } from "@t3tools/contracts/relay";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";

// Board pushes are best-effort: the needs-you inbox/RPC is the reliable browsing
// surface, so a per-user or per-device failure is logged and skipped rather than
// failing the whole publish (which would make the server retry the outbox row and
// could permanently strand every other device behind one persistent failure). The
// only error that propagates is the pre-fanout delivery-user lookup (a real system
// error worth retrying).
export type BoardTicketPublishError = EnvironmentLinks.EnvironmentLinkUserListPersistenceError;

export interface BoardTicketPublisherShape {
  readonly publish: (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly boardId: string;
    readonly ticketId: string;
    readonly state: RelayBoardTicketState | null;
  }) => Effect.Effect<RelayPublishResponse, BoardTicketPublishError>;
}

export class BoardTicketPublisher extends Context.Service<
  BoardTicketPublisher,
  BoardTicketPublisherShape
>()("t3code-relay/agentActivity/BoardTicketPublisher") {}

const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);

function notificationAllowedForState(input: {
  readonly preferencesJson: string;
  readonly attentionKind: RelayBoardTicketState["attentionKind"];
}): boolean {
  const preferences = Option.getOrNull(
    decodeRelayAgentAwarenessPreferencesJson(input.preferencesJson),
  );
  if (!preferences?.notificationsEnabled) {
    return false;
  }
  switch (input.attentionKind) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "blocked":
      return preferences.notifyOnBlocked ?? true;
  }
}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const crypto = yield* Crypto.Crypto;

  return BoardTicketPublisher.of({
    publish: Effect.fn("relay.board_ticket_publisher.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.board_id": input.boardId,
        "relay.ticket_id": input.ticketId,
        "relay.board_ticket.attention_kind": input.state?.attentionKind ?? "cleared",
      });
      const state = input.state;
      if (state === null) {
        return { ok: true, deliveries: [] };
      }
      const notification: ApnsNotificationPayload = {
        title: state.title,
        body: state.body,
        environmentId: state.environmentId,
        boardId: state.boardId,
        ticketId: state.ticketId,
        deepLink: state.deepLink,
      };
      const deliveryUsers = yield* links.listDeliveryUsersForEnvironment({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
      });
      const deliveriesByUser = yield* Effect.forEach(
        deliveryUsers,
        (deliveryUser) =>
          Effect.gen(function* () {
            // Honor the user's environment-level notification opt-out. The delivery
            // list also includes users who only enabled live activities, so this
            // filter must be per-user — not just the per-device preferences below.
            if (!deliveryUser.notificationsEnabled) {
              return [] as ReadonlyArray<RelayDeliveryResult>;
            }
            const targets = yield* liveActivities.listTargets({ userId: deliveryUser.userId });
            const perTarget = yield* Effect.forEach(
              targets,
              (target) =>
                Effect.gen(function* () {
                  if (!target.push_token) {
                    return null;
                  }
                  if (
                    !notificationAllowedForState({
                      preferencesJson: target.preferences_json,
                      attentionKind: state.attentionKind,
                    })
                  ) {
                    return null;
                  }
                  // Bound the persisted dedup key: source_job_id is varchar(64). Real
                  // component ids make the raw composite 150-400 chars, which Postgres
                  // rejects (no truncation), silently dropping every notification. Hash
                  // an unambiguous serialization (colons are legal in the ids, so a
                  // plain colon-join could collide distinct tuples) into a fixed-width,
                  // still-stable key so dedup survives.
                  const composite = stableStringify({
                    environmentId: state.environmentId,
                    boardId: state.boardId,
                    ticketId: state.ticketId,
                    transitionId: state.transitionId,
                    deviceId: target.device_id,
                  });
                  const digest = yield* crypto.digest(
                    "SHA-256",
                    new TextEncoder().encode(composite),
                  );
                  const jobId = `board:${Encoding.encodeBase64Url(digest)}`;
                  return yield* deliveryQueue.enqueuePushNotification({
                    userId: target.user_id,
                    deviceId: target.device_id,
                    token: target.push_token,
                    notification,
                    jobId,
                  });
                }).pipe(
                  // Isolate per-device failures (digest or enqueue): log and skip so
                  // one stranded device does not block its siblings or trigger a
                  // whole-row retry.
                  Effect.catch((cause) =>
                    Effect.as(
                      Effect.logWarning("board ticket push enqueue failed", {
                        userId: deliveryUser.userId,
                        deviceId: target.device_id,
                        cause,
                      }),
                      null,
                    ),
                  ),
                ),
              { concurrency: 2 },
            );
            return perTarget;
          }).pipe(
            // Isolate per-user failures (e.g. listTargets) the same way.
            Effect.catch((cause) =>
              Effect.as(
                Effect.logWarning("board ticket push fan-out failed for user", {
                  userId: deliveryUser.userId,
                  cause,
                }),
                [] as ReadonlyArray<RelayDeliveryResult | null>,
              ),
            ),
          ),
        { concurrency: 4 },
      );
      const deliveries = deliveriesByUser
        .flat()
        .filter((delivery): delivery is RelayDeliveryResult => delivery !== null);
      return { ok: true, deliveries };
    }),
  });
});

export const layer = Layer.effect(BoardTicketPublisher, make);
