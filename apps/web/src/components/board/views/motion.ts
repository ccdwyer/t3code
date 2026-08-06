import { useEffect, useRef, useState } from "react";

/**
 * Keeps a surface mounted while it animates out.
 *
 * React unmounts the moment a condition flips, which kills any exit animation.
 * This holds the element in the tree for `ms` after `open` goes false, and
 * exposes `shown` — the flag the CSS transition is driven from — so entering
 * and leaving are symmetric.
 *
 *   const { rendered, shown } = useExitTransition(isOpen, 160);
 *   return rendered ? <Panel data-shown={shown} /> : null;
 */
export const useExitTransition = (open: boolean, ms = 160) => {
  const [rendered, setRendered] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      // Two frames: one for the element to exist at its "from" state, one for
      // the browser to register that state before it changes. A single frame
      // is occasionally coalesced away and the transition never runs.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => setRendered(false), ms);
    return () => window.clearTimeout(timer);
  }, [ms, open]);

  return { rendered, shown };
};

/**
 * Holds on to the last non-null value, so a panel can keep rendering its
 * subject while it animates out after the subject has already been cleared.
 */
export const useLastPresent = <T>(value: T | undefined): T | undefined => {
  const ref = useRef(value);
  if (value !== undefined) ref.current = value;
  return value ?? ref.current;
};

/**
 * Fizzy's transition curve: fast out of the gate, long settle. Motion is
 * ~170ms — quick enough that it reads as the surface arriving rather than a
 * modal being presented.
 */
export const EASE_SETTLE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * The transform that maps an element onto some other rectangle — the FLIP
 * "invert" step. With `transform-origin: 0 0`, applying this to a panel makes
 * it sit exactly where the card is; animating it away to `none` makes the
 * panel grow out of that card.
 *
 * Scale is deliberately non-uniform: the point is for the panel's *box* to
 * match the card's box. The squash that implies is hidden by fading the
 * panel's contents in behind it, which is how every shared-element transition
 * gets away with morphing between two differently-shaped layouts.
 */
export const transformOnto = (element: HTMLElement, target: DOMRect): string => {
  const from = element.getBoundingClientRect();
  if (from.width === 0 || from.height === 0) return "none";
  const scaleX = target.width / from.width;
  const scaleY = target.height / from.height;
  const dx = target.left - from.left;
  const dy = target.top - from.top;
  return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
};

/**
 * Keyframes for morphing `element` between its own rectangle and `target`,
 * plus the matching counter-scale for its contents.
 *
 * The contents need un-distorting or the panel reads as a squashed page. You
 * cannot get that from two separate eased animations: interpolating `1/sx → 1`
 * is not the same curve as `1 / (sx → 1)`, so the inverse drifts out of true
 * halfway across and the text visibly stretches. Instead the easing is baked
 * into the keyframe values here — every frame carries an exact inverse — and
 * the animation itself runs linear.
 *
 * With the contents held at natural size and the box clipping them, the panel
 * shows real content the whole way: at the start you see the ticket's number
 * and title through a card-sized window, which is exactly what the card had.
 */
export const morphKeyframes = (
  element: HTMLElement,
  target: DOMRect,
  direction: "in" | "out",
  steps = 24,
): { readonly box: Keyframe[]; readonly contents: Keyframe[] } | null => {
  const from = element.getBoundingClientRect();
  if (from.width === 0 || from.height === 0) return null;

  const scaleX = target.width / from.width;
  const scaleY = target.height / from.height;
  const dx = target.left - from.left;
  const dy = target.top - from.top;

  const box: Keyframe[] = [];
  const contents: Keyframe[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    // easeOutQuint — visually the settle curve, but cheap to evaluate here.
    const eased = 1 - (1 - p) ** 5;
    // `in` travels card → full; `out` travels full → card.
    const toward = direction === "in" ? 1 - eased : eased;
    const sx = 1 + (scaleX - 1) * toward;
    const sy = 1 + (scaleY - 1) * toward;
    box.push({
      offset: p,
      transform: `translate(${dx * toward}px, ${dy * toward}px) scale(${sx}, ${sy})`,
    });
    contents.push({ offset: p, transform: `scale(${1 / sx}, ${1 / sy})` });
  }
  return { box, contents };
};

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
