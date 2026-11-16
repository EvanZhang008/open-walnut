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
  /** How much wider the buttons were one step back (0 while it is not known). */
  unfoldCostPx: number;
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
  if (step > 0 && unfoldCostPx > 0 && typingPx - unfoldCostPx >= minPx + hysteresisPx) return step - 1;
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
    let step = 0;
    // The buttons' width at each step the row has shown, so unfolding knows what it costs.
    const widthAt: number[] = [];
    let input: HTMLInputElement | null = null;
    const set = (next: number) => { step = next; row.dataset.toolbarFold = String(next); };
    /** One step at most; true when it moved. */
    const stepOnce = (): boolean => {
      const el = row.querySelector<HTMLInputElement>(inputSelector);
      if (el !== input) { if (input) ro.unobserve(input); input = el; if (el) ro.observe(el); }
      if (!el || !row.getClientRects().length) return false;
      const buttons = [...row.querySelectorAll<HTMLElement>('[data-fit-button]')];
      const maxStep = Math.min(TOOLBAR_FIT_MAX_STEPS, Math.max(0, ...buttons.map((b) => Number(b.dataset.fitButton) || 1)));
      if (step > maxStep) { set(maxStep); return true; }
      widthAt[step] = buttons.reduce((px, b) => px + b.getBoundingClientRect().width, 0);
      const back = step > 0 ? widthAt[step - 1] : undefined;
      const fieldPx = el.getBoundingClientRect().width;
      let roomPx = fieldPx;
      // Give back what typing put beside the field, each with the gap before it.
      if (typingSelector) row.querySelectorAll<HTMLElement>(typingSelector).forEach((t) => {
        if (!t.getClientRects().length) return;
        roomPx += t.getBoundingClientRect().width + (parseFloat(getComputedStyle(t.parentElement ?? t).columnGap) || 0);
      });
      const next = nextToolbarFold({
        step, maxStep, roomPx, fieldPx,
        unfoldCostPx: back === undefined ? 0 : Math.max(0, back - widthAt[step]), minPx, reservePx,
      });
      if (next === step) return false;
      set(next);
      return true;
    };
    // Every step settles in the same pass (reading a box lays the row out again), so the
    // observer never sees a chain of its own changes.
    const evaluate = () => { for (let i = 0; i <= TOOLBAR_FIT_MAX_STEPS + 1 && stepOnce(); i++) { /* next step */ } };
    // A fold changes the field's width. When the row moved, that change is deeper than the row
    // and the observer delivers it in the same frame; when only the field moved (typing put the
    // clear button beside it), the next step waits a frame, so no notification is left
    // undelivered ("ResizeObserver loop completed", the same as useTitleRowTight.ts).
    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      if (entries.some((e) => e.target === row)) { cancelAnimationFrame(frame); evaluate(); return; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(evaluate);
    });
    set(0);
    ro.observe(row);
    evaluate();
    return () => { ro.disconnect(); cancelAnimationFrame(frame); delete row.dataset.toolbarFold; };
  }, [rowRef, inputSelector, typingSelector, minPx, reservePx, enabled]);
}
