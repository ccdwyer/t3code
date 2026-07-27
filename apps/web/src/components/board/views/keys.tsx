import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export const OPTION_KEYS = ["1", "2", "3", "4", "5"] as const;

/** A key cap, for legends and inline hints. */
export function Kbd({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-4 items-center justify-center rounded border border-border/70 bg-muted/60 px-1 font-mono text-[10px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KeyLegend({
  items,
}: {
  readonly items: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly label: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          {item.keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Whether a key event came from somewhere the user is typing.
 *
 * Board shortcuts are bare letters, so they must never fire while a field has
 * focus — otherwise typing "j" in a comment moves the cursor.
 */
export const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
};

export interface GridCursor {
  readonly col: number;
  readonly row: number;
  readonly id: string | undefined;
  readonly move: (dCol: number, dRow: number) => void;
  readonly select: (col: number, row: number) => void;
}

/**
 * A cursor over ragged columns of ids.
 *
 * `allowEmptyColumns` makes an empty column a reachable target, which is what
 * lets the cursor land on a collapsed lane and expand it again; without it
 * horizontal movement skips anything with nothing in it.
 */
export const useGridCursor = (
  columns: ReadonlyArray<ReadonlyArray<string>>,
  options?: { readonly allowEmptyColumns?: boolean; readonly pinnedId?: string | undefined },
): GridCursor => {
  const allowEmpty = options?.allowEmptyColumns ?? false;
  const [col, setCol] = useState(0);
  const [row, setRow] = useState(0);
  /**
   * The id the cursor is on, remembered so the cursor follows the TICKET rather
   * than the slot.
   *
   * A ticket advancing to the next lane leaves its row, and whatever slides up
   * into that row would otherwise silently become selected — which is
   * especially wrong with the detail open, where it swaps the ticket out from
   * under the panel you are reading.
   */
  const [trackedId, setTrackedId] = useState<string | undefined>(undefined);

  const locate = (id: string | undefined): { col: number; row: number } | undefined => {
    if (id === undefined) return undefined;
    for (const [c, column] of columns.entries()) {
      const r = column.indexOf(id);
      if (r >= 0) return { col: c, row: r };
    }
    return undefined;
  };

  // A pinned id (the open detail) wins outright; otherwise follow the tracked
  // ticket; otherwise fall back to the last position, clamped.
  const followed = locate(options?.pinnedId) ?? locate(trackedId);
  const safeCol = followed?.col ?? Math.min(col, Math.max(0, columns.length - 1));
  const column = columns[safeCol] ?? [];
  const safeRow = followed?.row ?? Math.min(row, Math.max(0, column.length - 1));
  const currentId = column[safeRow];

  const select = useCallback(
    (nextCol: number, nextRow: number) => {
      setCol(nextCol);
      setRow(nextRow);
      setTrackedId(columns[nextCol]?.[nextRow]);
    },
    [columns],
  );

  const move = useCallback(
    (dCol: number, dRow: number) => {
      if (dCol !== 0) {
        let next = safeCol;
        if (allowEmpty) {
          next = Math.min(Math.max(0, safeCol + dCol), Math.max(0, columns.length - 1));
        } else {
          for (let i = 0; i < columns.length; i += 1) {
            next = (next + dCol + columns.length) % columns.length;
            if ((columns[next]?.length ?? 0) > 0) break;
          }
        }
        const nextRow = Math.min(safeRow, Math.max(0, (columns[next]?.length ?? 1) - 1));
        setCol(next);
        setRow(nextRow);
        setTrackedId(columns[next]?.[nextRow]);
        return;
      }
      const length = columns[safeCol]?.length ?? 0;
      if (length === 0) return;
      const nextRow = Math.min(Math.max(0, safeRow + dRow), length - 1);
      setRow(nextRow);
      setCol(safeCol);
      setTrackedId(columns[safeCol]?.[nextRow]);
    },
    [allowEmpty, columns, safeCol, safeRow],
  );

  return { col: safeCol, row: safeRow, id: currentId, move, select };
};

/**
 * Board-level shortcuts.
 *
 * Handlers are held in a ref so the listener is installed once: re-binding on
 * every render would drop keystrokes that land mid-update.
 */
export const useBoardKeys = (handlers: {
  readonly onMove?: (dCol: number, dRow: number) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  readonly onOption?: (index: number) => void;
  readonly onRefresh?: () => void;
  readonly extra?: Record<string, () => void>;
}): void => {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = ref.current;
      // Board shortcuts are bare keys, so a modified chord belongs to the
      // browser or the OS: without this, Cmd-S would hit the freeform shortcut
      // instead of saving, and Cmd/Alt-1 would fire a numbered action.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      // A held key must not repeat an action. Auto-repeat on a digit would
      // toggle a multi-select answer on and off many times per second.
      if (event.repeat) {
        return;
      }
      if (isTyping(event.target)) {
        if (event.key === "Escape" && event.target instanceof HTMLElement) event.target.blur();
        return;
      }
      const hit = (fn: (() => void) | undefined) => {
        if (fn === undefined) return;
        event.preventDefault();
        fn();
      };
      const moveBy = (dCol: number, dRow: number) => {
        if (current.onMove === undefined) return;
        event.preventDefault();
        current.onMove(dCol, dRow);
      };

      switch (event.key) {
        case "h":
        case "ArrowLeft":
          return moveBy(-1, 0);
        case "l":
        case "ArrowRight":
          return moveBy(1, 0);
        case "j":
        case "ArrowDown":
          return moveBy(0, 1);
        case "k":
        case "ArrowUp":
          return moveBy(0, -1);
        case "Enter":
          return hit(current.onOpen);
        case "Escape":
          return hit(current.onClose);
        case "u":
          return hit(current.onRefresh);
        default:
          break;
      }

      const digit = OPTION_KEYS.indexOf(event.key as (typeof OPTION_KEYS)[number]);
      if (digit >= 0 && current.onOption !== undefined) {
        event.preventDefault();
        current.onOption(digit);
        return;
      }
      const extra = current.extra?.[event.key];
      if (extra !== undefined) {
        event.preventDefault();
        extra();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
};

/** Scrolls the element into view whenever it becomes the active one. */
export const useScrollIntoView = (active: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return ref;
};

/**
 * A frozen view of a live ranking.
 *
 * Console's queue re-ranks constantly as agents park and SLAs breach, which
 * made rows move out from under the cursor. This holds the order still:
 * arrivals append at the bottom, departures drop out in place, and `drift`
 * reports how far the frozen view has diverged so the user can re-sort on
 * purpose.
 */
export const useStableOrder = (
  liveOrder: ReadonlyArray<string>,
): {
  readonly order: ReadonlyArray<string>;
  readonly drift: number;
  readonly resync: () => void;
} => {
  const [frozen, setFrozen] = useState<ReadonlyArray<string>>(liveOrder);

  const live = new Set(liveOrder);
  const kept = frozen.filter((id) => live.has(id));
  const appended = liveOrder.filter((id) => !kept.includes(id));
  const order = [...kept, ...appended];

  // How many rows sit somewhere other than where the live ranking would put
  // them. Zero means the frozen view already agrees with reality.
  let drift = 0;
  for (const [index, id] of order.entries()) {
    if (liveOrder[index] !== id) drift += 1;
  }

  const resync = useCallback(() => {
    setFrozen(liveOrder);
  }, [liveOrder]);

  return { order, drift, resync };
};
