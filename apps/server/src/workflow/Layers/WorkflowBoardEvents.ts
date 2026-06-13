import type { BoardTicketView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  WorkflowBoardEvents,
  type WorkflowBoardEventsShape,
} from "../Services/WorkflowBoardEvents.ts";

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<BoardTicketView>();

  const publish: WorkflowBoardEventsShape["publish"] = (ticket) =>
    PubSub.publish(pubsub, ticket).pipe(Effect.asVoid);
  const stream: WorkflowBoardEventsShape["stream"] = (boardId) =>
    Stream.fromPubSub(pubsub).pipe(Stream.filter((ticket) => ticket.boardId === boardId));

  return { publish, stream } satisfies WorkflowBoardEventsShape;
});

export const WorkflowBoardEventsLive = Layer.effect(WorkflowBoardEvents, make);
