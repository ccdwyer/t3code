import type {
  LaneEntryToken,
  PipelineRunId,
  TicketId,
  WorkflowContextPackSection,
  WorkflowStep,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ContextPackDiffPort } from "../Services/ContextPackDiffPort.ts";
import {
  ContextPackCompiler,
  type ContextPackCompilerShape,
} from "../Services/ContextPackCompiler.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  CONTEXT_PACK_PER_STEP_MAX,
  applyTotalCap,
  escapeForPack,
  redactAndCap,
  renderDiffSummary,
} from "../contextPack.ts";

/**
 * Whole-section budget for `diff_summary`: worktree lookup, untracked discovery,
 * and every stat call together. Bounding only the named stat call would leave
 * the other two unbounded.
 */
const DIFF_SECTION_TIMEOUT_MS = 3_000;

/**
 * Run one section's compilation so that NOTHING it does can fail routing:
 * typed failures, defects, and timeouts all degrade to "no section" plus a
 * warning. Interrupts are the deliberate exception — swallowing the interrupt
 * from a superseded pipeline would leave the fiber running against a lane the
 * ticket has already left, and deadlock the admission path behind it.
 */
const guardSection = <A>(
  label: string,
  effect: Effect.Effect<A, unknown, never>,
): Effect.Effect<A | null, never, never> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause) as Effect.Effect<never, never, never>;
      }
      return Effect.logWarning(`context pack section ${label} failed`, cause).pipe(Effect.as(null));
    }),
  ) as Effect.Effect<A | null, never, never>;

const make = Effect.gen(function* () {
  const read = yield* WorkflowReadModel;
  const diff = yield* ContextPackDiffPort;

  const compilePriorOutputs = (
    ticketId: TicketId,
    pipelineRunId: PipelineRunId,
    steps: ReadonlyArray<WorkflowStep>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* read.listPackPriorOutputs(ticketId, pipelineRunId);
      if (rows.length === 0) {
        return null;
      }
      // The query returns started_at order; the agent wants the lane's own
      // pipeline order, which lives only in the board definition.
      const declarationOrder = new Map(steps.map((step, index) => [step.key as string, index]));
      const ordered = [...rows].sort(
        (left, right) =>
          (declarationOrder.get(left.stepKey) ?? Number.MAX_SAFE_INTEGER) -
          (declarationOrder.get(right.stepKey) ?? Number.MAX_SAFE_INTEGER),
      );
      const body = ordered
        .map((row) => {
          // Step keys are arbitrary strings rendered as headings, so they forge
          // pack structure just as easily as a crafted filename would.
          const heading = `### ${escapeForPack(row.stepKey)}`;
          // Redact BEFORE the per-step cap: redaction can expand short values.
          const text = redactAndCap(row.preview, CONTEXT_PACK_PER_STEP_MAX);
          // The query truncated mid-value, so this is a preview, not decodable
          // output — say so rather than handing the agent half a document.
          return row.oversized ? `${heading}\n${text}\n… (truncated)` : `${heading}\n${text}`;
        })
        .join("\n\n");
      return body.trim().length === 0 ? null : body;
    });

  const compileFailedAttempts = (ticketId: TicketId, laneEntryToken: LaneEntryToken) =>
    Effect.gen(function* () {
      const { rows, totalMatched } = yield* read.listPackFailedAttempts(ticketId, laneEntryToken);
      if (rows.length === 0) {
        return null;
      }
      const lines = rows.map(
        (row) =>
          `${escapeForPack(row.stepKey)} attempt ${String(row.attempt)}: ${escapeForPack(
            redactAndCap(row.error, CONTEXT_PACK_PER_STEP_MAX),
          )}`,
      );
      const omitted = totalMatched - rows.length;
      if (omitted > 0) {
        lines.push(`… (${String(omitted)} older attempts omitted)`);
      }
      return lines.join("\n");
    });

  const compileDiffSummary = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const stat = yield* diff.statTicketDiff(ticketId);
      if (stat === null) {
        return null;
      }
      const body = renderDiffSummary(stat);
      return body.length === 0 ? null : body;
    }).pipe(Effect.timeout(DIFF_SECTION_TIMEOUT_MS));

  const compile: ContextPackCompilerShape["compile"] = (input) =>
    Effect.gen(function* () {
      const [priorOutputs, failedAttempts, diffSummary] = yield* Effect.all(
        [
          guardSection(
            "prior_outputs",
            compilePriorOutputs(input.ticketId, input.pipelineRunId, input.steps),
          ),
          guardSection(
            "failed_attempts",
            compileFailedAttempts(input.ticketId, input.laneEntryToken),
          ),
          guardSection("diff_summary", compileDiffSummary(input.ticketId)),
        ],
        { concurrency: 3 },
      );

      const sections: Array<WorkflowContextPackSection> = [];
      const push = (key: WorkflowContextPackSection["key"], body: string | null) => {
        if (body === null || body.trim().length === 0) {
          return;
        }
        sections.push({ key, body: redactAndCap(body), autoGenerated: true });
      };
      push("prior_outputs", priorOutputs);
      push("diff_summary", diffSummary);
      push("failed_attempts", failedAttempts);

      return applyTotalCap(sections);
    }).pipe(
      // Any failure or defect at the compile boundary degrades to "no pack".
      // Routing must never fail because a pack could not be built.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause) as Effect.Effect<never, never, never>;
        }
        return Effect.logWarning("context pack compilation failed", cause).pipe(
          Effect.as([] as ReadonlyArray<WorkflowContextPackSection>),
        );
      }),
    ) as Effect.Effect<ReadonlyArray<WorkflowContextPackSection>, never, never>;

  return { compile } satisfies ContextPackCompilerShape;
});

export const ContextPackCompilerLive = Layer.effect(ContextPackCompiler, make);
