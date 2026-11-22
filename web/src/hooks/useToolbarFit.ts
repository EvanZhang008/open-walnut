/**
 * useToolbarFit: a toolbar row that holds a search field beside labeled buttons keeps the
 * field readable. When the field would drop under its readable width, the buttons fold to
 * their icons, one step at a time; they spell their labels again once the row has room.
 *
 * The one rule for every such row (2026-11-16, Evan: "the new and display occupy too much,
 * when I type I can't even see the text, if the space is not enough use the icon please"):
 * - The row gets `data-toolbar-fold="0" | "1" | ...`: how many fold steps are taken.
 *   A button marked `data-fit-button="N"` folds from step N on (styles/toolbar-fit.css
 *   hides its `[data-fit-label]` and squares it); step 1 goes first. A folded button keeps
 *   its name in `aria-label` and `title`.
 * - Driven by the row's own width and the field's own width (a ResizeObserver), never the
 *   window's: panels are resized on their own, and fonts differ between machines.
 * - The decision is the same typed or empty: it gives back what typing put beside the field
 *   (the clear button, the result count) and takes a fixed reserve for it instead, so the
 *   labels never jump on the first keystroke.
 *
 * The attribute is set on the element directly: a resize never re-renders the panel.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** The field's readable width: about 16 characters of the 13px toolbar font. */
export const TOOLBAR_FIT_MIN_INPUT_PX = 112;
/** What typing puts beside the field: the clear button, a three-digit count, their gaps. */
export const TOOLBAR_FIT_TYPING_RESERVE_PX = 52;
/** Whole buttons go into More only when the bare field would fall under this (the magnifier and
 *  about 6 characters): words fold first at TOOLBAR_FIT_MIN_INPUT_PX, and New task stays on the
 *  row of a panel that only just misses it (a filter count beside Display, a 306 px panel). At the
 *  224 px panel floor the field would be 48 px, so there More takes New task and Board. */
export const TOOLBAR_FIT_MORE_MIN_PX = 64;
/** Labels come back only with this much to spare, so a row at the edge never flickers. */
export const TOOLBAR_FIT_HYSTERESIS_PX = 12;
/** toolbar-fit.css spells out this many steps. */
export const TOOLBAR_FIT_MAX_STEPS = 3;

export interface ToolbarFitInput {
  /** Fold steps taken now (0: every label shows). */
  step: number;
  /** The row's last step (its buttons' highest `data-fit-button`). */
  maxStep: number;
  /** The field's width with what typing put beside it given back (the field's width while empty). */
  roomPx: number;
  /** The field's width now: a count wider than the reserve still never leaves it under `minPx`. */
  fieldPx?: number;
  /** How much wider the buttons were one step back (undefined while it is not known). */
  unfoldCostPx?: number;
  minPx?: number;
  reservePx?: number;
  hysteresisPx?: number;
}

/** The pure decision, one step per call, so its edges are unit tested (tests/web/toolbar-fit.test.ts). */
export function nextToolbarFold({
  step, maxStep, roomPx, fieldPx = Infinity, unfoldCostPx,
  minPx = TOOLBAR_FIT_MIN_INPUT_PX, reservePx = TOOLBAR_FIT_TYPING_RESERVE_PX, hysteresisPx = TOOLBAR_FIT_HYSTERESIS_PX,
}: ToolbarFitInput): number {
  const typingPx = Math.min(roomPx - reservePx, fieldPx);
  if (typingPx < minPx) return Math.min(step + 1, maxStep);
  // Unfolding is judged on the room, not the kept element's box: a title that does not grow
  // is only as wide as its text, so its box never shows the room the row has. A cost of 0 is
  // known (the More button takes the place of the one button it holds); undefined is not.
  if (step > 0 && unfoldCostPx !== undefined && roomPx - reservePx - unfoldCostPx >= minPx + hysteresisPx) return step - 1;
  return step;
}

export interface UseToolbarFitOptions {
  /** The search field inside the row (its own box, not the bar around it). */
  inputSelector: string;
  /** What typing shows beside the field (a clear button, a result count, a spinner). */
  typingSelector?: string;
  minPx?: number;
  reservePx?: number;
  /** Off: the row carries no fold (a row whose field is never typed in, a phone's door to its search layer). */
  enabled?: boolean;
}

export function useToolbarFit(rowRef: RefObject<HTMLElement | null>, { inputSelector, typingSelector, minPx, reservePx, enabled = true }: UseToolbarFitOptions): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) return;
    return attachFold(row, {
      keepSelector: inputSelector,
      measure: (el) => {
        const fieldPx = el.getBoundingClientRect().width;
        let roomPx = fieldPx;
        // Give back what typing put beside the field, each with the gap before it.
        if (typingSelector) row.querySelectorAll<HTMLElement>(typingSelector).forEach((t) => {
          if (!t.getClientRects().length) return;
          roomPx += t.getBoundingClientRect().width + (parseFloat(getComputedStyle(t.parentElement ?? t).columnGap) || 0);
        });
        return { roomPx, fieldPx, minPx, reservePx, moreMinPx: TOOLBAR_FIT_MORE_MIN_PX };
      },
    });
  }, [rowRef, inputSelector, typingSelector, minPx, reservePx, enabled]);
}

/** What one fold decision reads: the kept element's room now, and the width it needs. */
interface FoldReading {
  roomPx: number; fieldPx?: number; minPx?: number; reservePx?: number;
  /** The floor the More step is judged on (default `minPx`). */
  moreMinPx?: number;
}

/**
 * The one fold loop both rows share (a toolbar keeps its field readable, a header its title):
 * steps 1..N fold the `[data-fit-button]` labels (toolbar-fit.css), and when the row holds a
 * `[data-fit-more]` menu, one step past them puts the buttons into it (`data-fit-overflow`,
 * header-fit.css). Returns the stop function.
 */
export function attachFold(row: HTMLElement, { keepSelector, measure }: {
  keepSelector: string;
  measure: (kept: HTMLElement) => FoldReading;
}): () => void {
  // No layout to measure (a DOM without ResizeObserver or rects, as in a unit test's renderer): the row stays as written.
  if (typeof ResizeObserver === 'undefined' || typeof row.getClientRects !== 'function') return () => {};
  let step = 0;
  // The buttons' width at each step the row has shown, so unfolding knows what it costs.
  const widthAt: number[] = [];
  let kept: HTMLElement | null = null;
  const set = (next: number, foldSteps: number) => {
    step = next;
    row.dataset.toolbarFold = String(Math.min(next, foldSteps));
    if (next > foldSteps) row.dataset.fitOverflow = 'true';
    else delete row.dataset.fitOverflow;
  };
  /** One step at most; true when it moved. */
  const stepOnce = (): boolean => {
    const el = row.querySelector<HTMLElement>(keepSelector);
    if (el !== kept) { if (kept) ro.unobserve(kept); kept = el; if (el) ro.observe(el); }
    if (!el || !row.getClientRects().length) return false;
    const buttons = [...row.querySelectorAll<HTMLElement>('[data-fit-button]')];
    const foldSteps = Math.min(TOOLBAR_FIT_MAX_STEPS, Math.max(0, ...buttons.map((b) => Number(b.dataset.fitButton) || 1)));
    const maxStep = foldSteps + (row.querySelector('[data-fit-more]') ? 1 : 0);
    if (step > maxStep) { set(maxStep, foldSteps); return true; }
    widthAt[step] = [...buttons, ...row.querySelectorAll<HTMLElement>('[data-fit-more]')]
      .reduce((px, b) => px + b.getBoundingClientRect().width, 0);
    const back = step > 0 ? widthAt[step - 1] : undefined;
    const reading = measure(el);
    const unfoldCostPx = back === undefined ? undefined : Math.max(0, back - widthAt[step]);
    let next = nextToolbarFold({ step, maxStep, ...reading, unfoldCostPx });
    // The More step puts whole buttons away, so it is judged on the bare field (the typing
    // reserve only folds words) against its own floor. A field that still fits keeps its buttons.
    if (next > foldSteps || step > foldSteps) {
      const { moreMinPx, ...rest } = reading;
      next = nextToolbarFold({ step, maxStep, ...rest, minPx: moreMinPx ?? rest.minPx, reservePx: 0, unfoldCostPx });
    }
    if (next === step) return false;
    set(next, foldSteps);
    return true;
  };
  // Every step settles in the same pass (reading a box lays the row out again), so the
  // observer never sees a chain of its own changes.
  const evaluate = () => { for (let i = 0; i <= TOOLBAR_FIT_MAX_STEPS + 2 && stepOnce(); i++) { /* next step */ } };
  // A fold changes the kept element's width. When the row moved, that change is deeper than the
  // row and the observer delivers it in the same frame; when only the kept element moved (typing
  // put the clear button beside it, a title was renamed), the next step waits a frame, so no
  // notification is left undelivered ("ResizeObserver loop completed", as useTitleRowTight.ts).
  let frame = 0;
  const ro = new ResizeObserver((entries) => {
    if (entries.some((e) => e.target === row)) { cancelAnimationFrame(frame); evaluate(); return; }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(evaluate);
  });
  set(0, 0);
  ro.observe(row);
  evaluate();
  return () => { ro.disconnect(); cancelAnimationFrame(frame); delete row.dataset.toolbarFold; delete row.dataset.fitOverflow; };
}
