import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedSemaphore } from "../../utils/keyedSemaphore.ts";
import { SlackChatWorktreeCoordinator } from "../Services/SlackChatWorktreeCoordinator.ts";

export const SlackChatWorktreeCoordinatorLive = Layer.effect(
  SlackChatWorktreeCoordinator,
  Effect.gen(function* () {
    const locks = yield* makeKeyedSemaphore;
    return SlackChatWorktreeCoordinator.of({ withPermit: locks.withPermit });
  }),
);
