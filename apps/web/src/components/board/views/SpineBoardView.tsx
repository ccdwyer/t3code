import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { visibleStuckDiagnosis, type CardUnstickAction } from "~/workflow/stuckDiagnosisView";
import type { BoardViewState, BoardViewTicket } from "../BoardView";
import {
  TIER_COLOR,
  TIER_LABEL,
  ageFrom,
  formatTokens,
  laneColor,
  laneModels,
  optionsFor,
  tierOf,
} from "./boardModel";
import { KeyLegend, useBoardKeys, useGridCursor, useScrollIntoView } from "./keys";
import { morphKeyframes, prefersReducedMotion, useExitTransition, useLastPresent } from "./motion";

/**
 * Opening a ticket is a shared-element transition: the detail panel is the
 * card, grown. It starts at the card's exact rectangle and travels to full
 * size; closing runs the same path in reverse, back into the row you came
 * from. The board dims underneath rather than being covered, so the panel is
 * seen moving against the board it came out of.
 *
 * One duration for the whole thing — scrim, panel, and how long the surface
 * stays mounted while it leaves — because they have to finish together or the
 * panel gets cut off mid-flight.
 */
const MORPH_MS = 260;

/** Folding a lane is a bigger spatial change, so it gets slightly longer. */
const LANE_MS = 220;

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * SPINE — lanes as columns you can fold down to a spine, driven from the
 * keyboard.
 *
 * Three things carry the design:
 *
 *  1. Selection is unmistakable. The selected line is a different object: a
 *     lifted surface, a solid filled chip in the state column, and the only
 *     full-strength title on the board. Its lane header lights up too, so the
 *     cursor is findable without reading a word.
 *
 *  2. Recovery actions are never hidden. They render as a full-width wrapped
 *     row — never truncated, never in an overflow, never behind a hover — and
 *     the selected card mirrors them in a fixed bar at the bottom so they stay
 *     readable mid-scroll.
 *
 *  3. Digits act on the selected card rather than the columns. Lane folding is
 *     `x` for the focused lane and `X` for everything else.
 */
export function SpineBoardView({
  state,
  onOpen,
  onParkAction,
  onUnstickAction,
  pendingParkActionTicketIds,
  renderTicketDetail,
  onCloseDetail,
}: {
  readonly state: BoardViewState;
  readonly onOpen: (id: string) => void;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  readonly onUnstickAction?: ((ticketId: string, action: CardUnstickAction) => void) | undefined;
  readonly pendingParkActionTicketIds?: ReadonlySet<string> | undefined;
  readonly renderTicketDetail?: ((ticketId: string) => ReactNode) | undefined;
  readonly onCloseDetail?: (() => void) | undefined;
}) {
  const models = useMemo(() => laneModels(state), [state]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const now = Date.now();

  const runParkAction = useCallback(
    (ticketId: string, index: number, parkedEventId: string) => {
      void onParkAction?.(ticketId, index, parkedEventId);
    },
    [onParkAction],
  );

  /**
   * The cursor indexes EVERY lane, not just expanded ones: a collapsed lane
   * contributes an empty column, so `h`/`l` still walk onto its spine and `x`
   * can expand it again. Column index therefore equals lane index, which also
   * means expanding a lane never moves the cursor off it.
   */
  const columns = useMemo(
    () =>
      models.map((model) =>
        collapsed.has(model.lane.key) ? [] : model.tickets.map((ticket) => ticket.ticketId),
      ),
    [collapsed, models],
  );

  // With the detail open the cursor is PINNED to the open ticket: advancing a
  // ticket moves it to the next lane, and a positional cursor would silently
  // select whatever slid into the vacated row — swapping the subject of the
  // panel you are reading.
  const cursor = useGridCursor(columns, {
    allowEmptyColumns: true,
    pinnedId: openId ?? undefined,
  });
  const cursorLane = models[cursor.col]?.lane;
  const selected = cursor.id === undefined ? undefined : state.ticketById[cursor.id];
  const options = useMemo(
    () =>
      optionsFor(
        selected,
        onParkAction === undefined ? undefined : runParkAction,
        onUnstickAction === undefined ? undefined : { now, run: onUnstickAction },
      ),
    [now, onParkAction, onUnstickAction, runParkAction, selected],
  );
  const openTicket = openId === null ? undefined : state.ticketById[openId];

  /**
   * The rectangle the detail grows out of and shrinks back into. Captured from
   * the card the instant it is opened, and re-measured on the way out in case
   * the board moved underneath.
   */
  const originRef = useRef<DOMRect | null>(null);
  const measureCard = useCallback((id: string): DOMRect | null => {
    const element = document.querySelector(`[data-ticket-id="${id}"]`);
    return element === null ? null : element.getBoundingClientRect();
  }, []);
  const openFrom = useCallback(
    (id: string) => {
      originRef.current = measureCard(id);
      setOpenId(id);
      // The host loads the detail this panel renders, so opening has to tell it
      // which ticket — the panel is the drawer's new home, not a link to it.
      onOpen(id);
    },
    [measureCard, onOpen],
  );
  const close = useCallback(() => {
    if (openId !== null) originRef.current = measureCard(openId) ?? originRef.current;
    setOpenId(null);
    onCloseDetail?.();
  }, [measureCard, onCloseDetail, openId]);

  // The detail keeps rendering its subject while it animates out, so closing
  // cross-fades back to the board instead of vanishing on the first frame.
  const { rendered: detailRendered, shown: detailShown } = useExitTransition(
    openTicket !== undefined,
    MORPH_MS,
  );
  const detailTicket = useLastPresent(openTicket);

  const toggleLane = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const focusLane = useCallback(
    (key: string) => {
      setCollapsed((prev) =>
        prev.size >= models.length - 1
          ? new Set()
          : new Set(models.filter((m) => m.lane.key !== key).map((m) => m.lane.key)),
      );
    },
    [models],
  );

  useBoardKeys({
    onMove: cursor.move,
    // Enter opens the selected ticket; on a collapsed lane there is no ticket,
    // so it expands the lane instead — the obvious meaning of "open" there.
    onOpen: () => {
      if (cursor.id !== undefined) openFrom(cursor.id);
      else if (cursorLane !== undefined && collapsed.has(cursorLane.key))
        toggleLane(cursorLane.key);
    },
    onClose: close,
    onOption: (index) => options[index]?.run(),
    extra: {
      x: () => {
        if (cursorLane !== undefined) toggleLane(cursorLane.key);
      },
      X: () => {
        if (cursorLane !== undefined) focusLane(cursorLane.key);
      },
      e: () => {
        setCollapsed(new Set());
      },
    },
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 pt-2 pb-1">
        <KeyLegend
          items={[
            { keys: ["h", "j", "k", "l"], label: "move" },
            { keys: ["1-5"], label: "act on selected" },
            { keys: ["↵"], label: "open" },
            { keys: ["x"], label: "fold lane" },
            { keys: ["X"], label: "focus lane" },
            { keys: ["e"], label: "expand all" },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto px-4 pb-2">
        {models.map((model, colIndex) => {
          const isCollapsed = collapsed.has(model.lane.key);
          const isCursorLane = colIndex === cursor.col;
          const overWip = model.lane.wipLimit !== undefined && model.admitted > model.lane.wipLimit;
          return (
            /* Collapsing is the signature move, so it moves. The wrapper's
               width tweens between the two sizes while the two contents
               cross-fade inside it — the expanded lane keeps its full width and
               is clipped away, which makes it read as the lane folding rather
               than its contents reflowing. */
            <div
              key={model.lane.key}
              /* `overflow-clip`, not `overflow-hidden`: this wrapper is a clip,
                 never a scroller. `hidden` makes it a scroll *container*, and
                 the folded lane still has its full-width section mounted inside
                 — so `scrollIntoView` on a selected card would scroll that
                 hidden width into view and carry the spine's left border out of
                 frame. `clip` cannot be scrolled, programmatically or
                 otherwise. */
              className="relative shrink-0 overflow-clip"
              style={{
                width: isCollapsed ? "2.25rem" : "19.5rem",
                transition: `width ${String(LANE_MS)}ms ${EASE}`,
              }}
            >
              <div
                aria-hidden={!isCollapsed}
                className={cn(
                  "absolute inset-0 flex",
                  isCollapsed ? "opacity-100" : "pointer-events-none opacity-0",
                )}
                style={{ transition: `opacity ${String(LANE_MS)}ms ${EASE}` }}
              >
                <button
                  type="button"
                  onClick={() => {
                    toggleLane(model.lane.key);
                  }}
                  className={cn(
                    "flex w-full flex-col items-center gap-2 rounded-md border py-2",
                    isCursorLane ? "border-primary/60 bg-muted/50" : "border-border/60",
                  )}
                  title={`${model.lane.name} — click to expand`}
                >
                  <span
                    className="grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] tabular-nums text-background"
                    style={{
                      background: laneColor(
                        model.lane.key,
                        68,
                        model.tickets.length === 0 ? 0.02 : 0.14,
                      ),
                    }}
                  >
                    {model.tickets.length}
                  </span>
                  {/* Volume, as a column of liquid: how full this lane is
                      relative to the busiest one. A folded lane still has to
                      answer "is work piling up here", and the count badge alone
                      makes you read digits across every spine to find out. */}
                  <span className="flex w-1 flex-1 flex-col justify-end overflow-hidden rounded-full bg-muted">
                    <span
                      className="w-full rounded-full transition-[height] duration-500"
                      style={{
                        height: `${String(Math.round(model.density * 100))}%`,
                        background: laneColor(model.lane.key, 60, 0.12),
                      }}
                    />
                  </span>
                  <span
                    className="text-[11px] font-medium whitespace-nowrap text-muted-foreground"
                    style={{ writingMode: "vertical-rl" }}
                  >
                    {model.lane.name}
                  </span>
                  {/* Status, as dots: one per ticket that wants a human, red
                      before amber, capped at four so a badly backed-up lane
                      does not grow an unbounded tail. Folding a lane hides its
                      cards, never the fact that something in it is stuck. */}
                  {model.needsYou > 0 ? (
                    <span
                      className="flex flex-col gap-1"
                      title={`${String(model.issues)} blocked · ${String(model.waiting)} need you`}
                      data-testid="spine-lane-alarm-dots"
                    >
                      {Array.from({ length: Math.min(model.needsYou, 4) }).map((_, i) => (
                        <span
                          key={i}
                          className="size-1.5 rounded-full motion-safe:animate-spine-breathe"
                          style={{
                            background: i < model.issues ? TIER_COLOR.issue : TIER_COLOR.waiting,
                            animationDelay: `${String(i * 0.25)}s`,
                          }}
                        />
                      ))}
                    </span>
                  ) : null}
                </button>
              </div>

              <section
                aria-hidden={isCollapsed}
                className={cn(
                  "absolute inset-y-0 left-0 flex w-[19.5rem] flex-col",
                  isCollapsed ? "pointer-events-none opacity-0" : "opacity-100",
                )}
                style={{ transition: `opacity ${String(LANE_MS)}ms ${EASE}` }}
              >
                {/* The cursor's lane is lit, so the selection is findable
                    without reading a single card. */}
                <header
                  className={cn(
                    "mb-1.5 flex items-center gap-2 rounded-md px-2 py-1",
                    isCursorLane ? "bg-muted/60" : "",
                  )}
                >
                  <span
                    className="grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] tabular-nums text-background"
                    style={{
                      background: laneColor(
                        model.lane.key,
                        68,
                        model.tickets.length === 0 ? 0.02 : 0.14,
                      ),
                    }}
                  >
                    {model.tickets.length}
                  </span>
                  <h2
                    className={cn(
                      "truncate text-[13px] font-semibold",
                      isCursorLane ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {model.lane.name}
                  </h2>
                  {model.lane.wipLimit !== undefined ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1 font-mono text-[10px] tabular-nums",
                        overWip ? "bg-destructive/20 text-destructive" : "text-muted-foreground/70",
                      )}
                      title="Admitted / WIP limit"
                    >
                      {model.admitted}/{model.lane.wipLimit}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto text-2xs text-muted-foreground/70 hover:text-foreground"
                    onClick={() => {
                      toggleLane(model.lane.key);
                    }}
                    title="Fold this lane (x)"
                  >
                    ⟨
                  </button>
                </header>

                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-1">
                  {model.tickets.length === 0 ? (
                    <p className="px-2.5 py-3 text-2xs text-muted-foreground/70">Empty</p>
                  ) : (
                    model.tickets.map((ticket, rowIndex) => (
                      <SpineCard
                        key={ticket.ticketId}
                        ticket={ticket}
                        now={now}
                        selected={isCursorLane && rowIndex === cursor.row}
                        pending={pendingParkActionTicketIds?.has(ticket.ticketId) === true}
                        onSelect={() => {
                          cursor.select(colIndex, rowIndex);
                        }}
                        onOpen={() => {
                          openFrom(ticket.ticketId);
                        }}
                        onParkAction={onParkAction === undefined ? undefined : runParkAction}
                      />
                    ))
                  )}
                </div>
              </section>
            </div>
          );
        })}
      </div>

      {/* Mirrors the selected card's actions so they stay readable mid-scroll. */}
      {selected !== undefined && options.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-1.5">
          <span className="truncate text-2xs text-muted-foreground">{selected.title}</span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                disabled={pendingParkActionTicketIds?.has(selected.ticketId) === true}
                onClick={option.run}
                className="rounded border border-border/70 px-1.5 py-0.5 text-2xs hover:bg-muted disabled:opacity-50"
              >
                <span className="mr-1 font-mono text-muted-foreground">{index + 1}</span>
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {detailRendered && detailTicket !== undefined ? (
        <SpineDetail
          ticket={detailTicket}
          shown={detailShown}
          origin={originRef.current}
          onClose={close}
          renderTicketDetail={renderTicketDetail}
        />
      ) : null}
    </div>
  );
}

function SpineCard({
  ticket,
  now,
  selected,
  pending,
  onSelect,
  onOpen,
  onParkAction,
}: {
  readonly ticket: BoardViewTicket;
  readonly now: number;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onParkAction?:
    | ((ticketId: string, index: number, parkedEventId: string) => void)
    | undefined;
}) {
  const tier = tierOf(ticket);
  const color = TIER_COLOR[tier];
  const alarm = tier === "issue" || tier === "waiting";
  const ref = useScrollIntoView(selected);
  const parked = ticket.parked;
  const actions = parked?.actions ?? [];
  // The park state already explains a parked card (even when its re-resolved
  // actions are absent), so gate on STATUS, matching cardUnstickActions.
  const diagnosis =
    ticket.status === "parked" ? null : visibleStuckDiagnosis(ticket.diagnosis, now);

  return (
    <article
      ref={ref}
      onMouseEnter={onSelect}
      onClick={onOpen}
      data-selected={selected}
      data-ticket-id={ticket.ticketId}
      className={cn(
        "grid cursor-pointer grid-cols-[3.75rem_1fr] gap-x-2 rounded border px-2.5 py-2 transition-colors",
        // Every card is a surface. Previously an unselected card had no
        // background at all, so it was invisible against the page until the
        // cursor reached it.
        selected
          ? "border-primary/50 bg-accent shadow-sm"
          : "border-border/40 bg-card hover:border-border hover:bg-muted/50",
      )}
      // Selection is always the same neutral lift, never tinted: mixing a tier
      // hue into the surface muddies it and would make the cursor a different
      // colour on every row. The filled state chip carries the tier.
      style={
        alarm && !selected
          ? { background: `color-mix(in oklch, ${color} 16%, var(--color-card))` }
          : undefined
      }
    >
      {/* The state column: the thing you scan, and where the cursor lands. */}
      <div className="flex flex-col items-start gap-1 pt-px">
        <span
          className={cn(
            "font-mono text-[9px] leading-3 tracking-[0.08em] whitespace-nowrap uppercase",
            selected ? "-mx-1 rounded-[2px] px-1 py-0.5 font-semibold text-background" : "",
          )}
          style={selected ? { background: color } : { color }}
        >
          {TIER_LABEL[tier]}
        </span>
        {/* Activity, in the state column directly under the word it qualifies:
            a hairline that says the agent is moving. Spine 2 filled this bar to
            the step's progress, but the real ticket view carries no per-step
            fraction — so it sweeps instead of filling, and claims nothing it
            cannot know. Reduced motion keeps a steady line: still a "working"
            cue, no movement. */}
        {tier === "running" ? (
          <span
            aria-hidden="true"
            data-testid="spine-working-bar"
            className="h-px w-full overflow-hidden"
            style={{ background: `color-mix(in oklch, ${color} 22%, transparent)` }}
          >
            <span
              className="block h-px w-2/5 motion-safe:animate-spine-working motion-reduce:w-full"
              style={{ background: color }}
            />
          </span>
        ) : null}
        {ticket.slaBreachedAt !== undefined ? (
          <span className="font-mono text-[9px] leading-3" style={{ color: TIER_COLOR.issue }}>
            SLA
          </span>
        ) : null}
        <span className="font-mono text-[9px] leading-3 text-muted-foreground/70">
          {ageFrom(ticket.updatedAt, now)}
        </span>
      </div>

      <div className="min-w-0">
        <p
          className={cn(
            "truncate text-[13px] leading-5 text-foreground",
            selected ? "font-medium" : "",
          )}
        >
          {ticket.title}
        </p>
        <p className="truncate text-2xs text-muted-foreground/70">
          {[ticket.currentStepLabel, formatTokens(ticket.totalTokens)]
            .filter((part): part is string => part !== undefined)
            .join(" · ")}
        </p>
        {diagnosis !== null ? (
          <p
            className="truncate text-2xs"
            style={{ color }}
            title={diagnosis.detail ?? diagnosis.summary}
            data-testid="spine-diagnosis"
          >
            {diagnosis.summary} · {ageFrom(diagnosis.since, now)}
          </p>
        ) : null}

        {/* Recovery actions: full width, wrapped, never truncated or hidden. */}
        {parked !== undefined && actions.length > 0 && onParkAction !== undefined ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {actions.slice(0, 5).map((action, index) => (
              <button
                key={action.label}
                type="button"
                disabled={pending}
                onClick={(event) => {
                  event.stopPropagation();
                  onParkAction(ticket.ticketId, index, parked.parkedEventId);
                }}
                className="rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-2xs hover:bg-muted disabled:opacity-50"
              >
                <span className="mr-1 font-mono text-muted-foreground">{index + 1}</span>
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        {parked !== undefined && actions.length === 0 ? (
          <p className="mt-1 text-2xs text-warning">
            {parked.label} — no recovery actions available
          </p>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The detail panel — the card, grown.
 *
 * It HOSTS the real ticket drawer rather than summarising it: there is one
 * detail implementation, and this is where it appears. The morph is what makes
 * that legible — the panel arrives out of the row you opened, so the full
 * detail reads as that ticket rather than as a separate screen.
 */
function SpineDetail({
  ticket,
  shown,
  origin,
  onClose,
  renderTicketDetail,
}: {
  readonly ticket: BoardViewTicket;
  readonly shown: boolean;
  /** The card's rectangle — what the panel grows out of and shrinks back to. */
  readonly origin: DOMRect | null;
  readonly onClose: () => void;
  readonly renderTicketDetail?: ((ticketId: string) => ReactNode) | undefined;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tier = tierOf(ticket);

  /**
   * A real shared-element transition, done as FLIP.
   *
   * On open the panel is laid out at its final size, then immediately
   * transformed onto the card's rectangle and released — so it grows out of the
   * row you opened rather than fading in over the top of it. On close it runs
   * the same transform in reverse, back into the card.
   */
  const morph = useCallback(
    (direction: "in" | "out") => {
      const panel = panelRef.current;
      const body = bodyRef.current;
      if (panel === null || origin === null || prefersReducedMotion()) return;

      // Clear any in-flight morph before measuring. Without this the rect we
      // measure is the *animated* one, so a second call (StrictMode invokes
      // mount effects twice in dev) would compute an identity transform and
      // silently cancel the real one.
      for (const animation of panel.getAnimations()) animation.cancel();
      if (body !== null) for (const animation of body.getAnimations()) animation.cancel();

      const frames = morphKeyframes(panel, origin, direction);
      if (frames === null) return;

      // Easing is baked into the keyframes so the counter-scale stays an exact
      // inverse at every frame; the animations themselves run linear.
      const timing = { duration: MORPH_MS, easing: "linear", fill: "both" } as const;
      panel.style.transformOrigin = "0 0";
      panel.animate(frames.box, timing);

      // The contents are counter-scaled rather than faded, so the panel is
      // never an empty rectangle: the box clips real content the whole way
      // across, starting with the title the card was already showing.
      if (body !== null) {
        body.style.transformOrigin = "0 0";
        body.animate(frames.contents, timing);
      }
    },
    [origin],
  );

  // Grow out of the card. Mount-only: the panel comes from wherever the card
  // was at the moment it was opened.
  const hasEntered = useRef(false);
  useLayoutEffect(() => {
    if (hasEntered.current) return;
    hasEntered.current = true;
    morph("in");
  }, [morph]);

  // …and shrink back into it. `shown` flips false one render before the
  // surface unmounts, which is the window the exit animation runs in.
  const wasShown = useRef(shown);
  useLayoutEffect(() => {
    if (wasShown.current && !shown) morph("out");
    wasShown.current = shown;
  }, [morph, shown]);

  return (
    <div className="absolute inset-0 z-20">
      {/* The board dims underneath rather than being covered, so the panel is
          seen moving against the board it came out of. */}
      <button
        type="button"
        aria-label="Close ticket"
        onClick={onClose}
        className={cn("absolute inset-0 bg-background/70", shown ? "opacity-100" : "opacity-0")}
        style={{ transition: `opacity ${String(MORPH_MS)}ms ${EASE}` }}
      />
      <div
        ref={panelRef}
        className="absolute inset-4 overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        {/* Counter-scaled during the morph, so the hosted drawer is never
            stretched — the box clips it instead. */}
        <div ref={bodyRef} className="flex h-full min-h-0 flex-col">
          {renderTicketDetail === undefined ? null : renderTicketDetail(ticket.ticketId)}
        </div>
      </div>
    </div>
  );
}
