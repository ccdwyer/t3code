import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { sanitizeExternalEventPayload } from "./externalEvent.ts";
import { WorkflowEngine } from "./Services/WorkflowEngine.ts";
import { WorkflowReadModel } from "./Services/WorkflowReadModel.ts";
import { WorkflowWebhook } from "./Services/WorkflowWebhook.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_DELIVERY_ID_LENGTH = 128;
const MAX_CORRELATION_LENGTH = 200;

const notFound = HttpServerResponse.text("Not Found", { status: 404 });
const unprocessable = (detail: string) =>
  HttpServerResponse.json({ error: detail }, { status: 422 }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text(detail, { status: 422 })),
  );

interface ParsedHookBody {
  readonly name: string;
  readonly ticketId: string;
  readonly payload: unknown;
  readonly deliveryId: string | undefined;
}

const parseHookBody = (raw: string): ParsedHookBody | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "body must be JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "body must be a JSON object";
  }
  const body = parsed as Record<string, unknown>;
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    return "name is required (1-100 chars)";
  }
  const ticketId = typeof body["ticketId"] === "string" ? body["ticketId"].trim() : "";
  const branch = typeof body["branch"] === "string" ? body["branch"].trim() : "";
  if ((ticketId === "") === (branch === "")) {
    return "exactly one of ticketId or branch is required";
  }
  if (ticketId.length > MAX_CORRELATION_LENGTH || branch.length > MAX_CORRELATION_LENGTH) {
    return "correlation value too long";
  }
  let correlatedTicketId = ticketId;
  if (branch !== "") {
    const match = /^workflow\/(.+)$/.exec(branch);
    if (match === null || match[1] === undefined) {
      return 'branch must look like "workflow/<ticketId>"';
    }
    correlatedTicketId = match[1];
  }
  const rawDeliveryId = body["deliveryId"];
  if (rawDeliveryId !== undefined) {
    if (typeof rawDeliveryId !== "string" || rawDeliveryId.length > MAX_DELIVERY_ID_LENGTH) {
      return "deliveryId must be a string (max 128 chars)";
    }
  }
  return {
    name,
    ticketId: correlatedTicketId,
    payload: sanitizeExternalEventPayload(body["payload"] ?? null),
    deliveryId: typeof rawDeliveryId === "string" ? rawDeliveryId : undefined,
  };
};

/**
 * Per-board webhook ingress: external systems (CI, PR automation, cron) POST
 * events that move correlated tickets through their lane's onEvent matchers.
 * Unknown board and bad token are indistinguishable (404, no oracle).
 */
export const workflowHooksRouteLayer = HttpRouter.add(
  "POST",
  "/hooks/workflow/:boardId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (url._tag === "None") {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const segments = url.value.pathname.split("/").filter((segment) => segment.length > 0);
    const rawBoardId = segments[2] ?? "";
    let boardId: string;
    try {
      boardId = decodeURIComponent(rawBoardId);
    } catch {
      // Malformed percent-encoding — keep the no-oracle 404 discipline.
      return notFound;
    }
    if (boardId === "" || boardId.length > MAX_CORRELATION_LENGTH) {
      return notFound;
    }
    // Reject oversized bodies before buffering when the client declares a
    // length; the post-read byte check below covers lying clients.
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return yield* unprocessable("body must be 1 byte to 64 KiB of JSON");
    }

    const headerToken = request.headers["x-t3-webhook-token"];
    const token = typeof headerToken === "string" ? headerToken : "";
    if (token === "") {
      return notFound;
    }
    // Resolved optionally so servers composed without the workflow runtime
    // (tests, trimmed deployments) simply 404 instead of failing to build.
    const webhookOption = yield* Effect.serviceOption(WorkflowWebhook);
    const engineOption = yield* Effect.serviceOption(WorkflowEngine);
    const readModelOption = yield* Effect.serviceOption(WorkflowReadModel);
    if (
      webhookOption._tag === "None" ||
      engineOption._tag === "None" ||
      readModelOption._tag === "None"
    ) {
      return notFound;
    }
    const webhook = webhookOption.value;
    const validToken = yield* webhook
      .verifyToken(boardId as never, token)
      .pipe(Effect.orElseSucceed(() => false));
    if (!validToken) {
      return notFound;
    }

    const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return yield* unprocessable("body must be 1 byte to 64 KiB of JSON");
    }
    const parsed = parseHookBody(raw);
    if (typeof parsed === "string") {
      return yield* unprocessable(parsed);
    }

    // Board must exist and own the ticket; the engine re-verifies, but a
    // cheap read keeps error shapes clean.
    const board = yield* readModelOption.value
      .getBoard(boardId as never)
      .pipe(Effect.orElseSucceed(() => null));
    if (board === null) {
      return notFound;
    }

    if (parsed.deliveryId !== undefined) {
      // Fail closed: if dedupe state cannot be recorded, a retried delivery
      // could route twice — surface a retryable 5xx instead of ingesting.
      const recorded = yield* webhook
        .recordDelivery(boardId as never, parsed.deliveryId)
        .pipe(Effect.result);
      if (recorded._tag === "Failure") {
        return HttpServerResponse.text("delivery could not be recorded", { status: 503 });
      }
      if (recorded.success) {
        return yield* HttpServerResponse.json({ outcome: "duplicate" }, { status: 202 }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.text("duplicate", { status: 202 })),
        );
      }
    }

    const result = yield* engineOption.value
      .ingestExternalEvent({
        boardId: boardId as never,
        name: parsed.name,
        ticketId: parsed.ticketId as never,
        payload: parsed.payload,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      // The delivery was recorded before ingest; release it so the sender's
      // retry is ingested instead of answered "duplicate" for an event that
      // never landed. 503 keeps the failure retryable even if the release
      // itself fails (the retry then dedupes, but nothing was lost silently).
      if (parsed.deliveryId !== undefined) {
        yield* webhook
          .releaseDelivery(boardId as never, parsed.deliveryId)
          .pipe(Effect.orElseSucceed(() => undefined));
      }
      return HttpServerResponse.text("event could not be ingested", { status: 503 });
    }
    return yield* HttpServerResponse.json(
      {
        outcome: result.success.outcome,
        ...(result.success.toLane === undefined ? {} : { toLane: result.success.toLane }),
      },
      { status: 202 },
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("accepted", { status: 202 })));
  }),
);
