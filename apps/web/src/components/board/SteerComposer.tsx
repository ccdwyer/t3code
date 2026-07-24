import { StepRunId, TicketId, type EnvironmentApi } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";

import {
  isSteerComposerInteractive,
  isSteerComposerVisible,
  steerBlockedTooltip,
  type SteerBlockedReason,
} from "./steerVisibility";

export type SteerComposerStep = {
  readonly stepRunId: string;
  readonly canSteer?: boolean | undefined;
  readonly steerBlockedReason?: SteerBlockedReason | undefined;
  readonly steerCount?: number | undefined;
};

/** Pure submit outcome used by the composer (and unit tests). */
export async function runSteerSubmit(input: {
  readonly text: string;
  readonly submit: () => Promise<unknown>;
}): Promise<{ readonly text: string; readonly error: string | null }> {
  try {
    await input.submit();
    return { text: "", error: null };
  } catch (cause) {
    return {
      text: input.text,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function SteerComposer({
  api,
  ticketId,
  step,
  onSteered,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: string;
  readonly step: SteerComposerStep;
  readonly onSteered?: (() => void) | undefined;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const blocked = step.steerBlockedReason;
  if (!isSteerComposerVisible({ canSteer: step.canSteer, steerBlockedReason: blocked })) {
    return null;
  }

  const interactive = isSteerComposerInteractive({
    canSteer: step.canSteer,
    steerBlockedReason: blocked,
  });
  const disabled = submitting || !interactive || text.trim().length === 0;
  const tooltip = steerBlockedTooltip(blocked);

  const submit = async () => {
    if (disabled) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const trimmed = text.trim();
    const outcome = await runSteerSubmit({
      text: trimmed,
      submit: () =>
        api.workflow.steerTicketStep({
          ticketId: TicketId.make(ticketId),
          stepRunId: StepRunId.make(step.stepRunId),
          messageId: randomUUID() as never,
          text: trimmed,
        }),
    });
    setText(outcome.text);
    setError(outcome.error);
    setSubmitting(false);
    if (outcome.error === null) {
      onSteered?.();
    }
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="steer-composer">
      <label className="text-xs font-medium text-muted-foreground">
        Steer the agent
        {step.steerCount !== undefined && step.steerCount > 0
          ? ` · steered ${step.steerCount}×`
          : null}
      </label>
      <textarea
        className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
        rows={2}
        placeholder="Steer the agent…"
        value={text}
        disabled={submitting || !interactive}
        title={tooltip}
        data-testid="steer-composer-input"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          disabled={disabled}
          title={tooltip}
          data-testid="steer-composer-send"
          onClick={() => {
            void submit();
          }}
        >
          Send
        </Button>
        {blocked !== undefined ? (
          <span className="text-xs text-muted-foreground" data-testid="steer-composer-blocked">
            {tooltip}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p className="text-xs text-destructive-foreground" data-testid="steer-composer-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
