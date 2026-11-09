/**
 * The selected-word echo: select a word, every identical copy tints (VS Code).
 * Two surfaces echo, the page (PageFind, `walnut-page-selmatch`, any page,
 * plugin pages included) and the doc and diff views (useSelectionMatches,
 * `walnut-selmatch`), and both paint ONLY through `paintEcho` here, which owns the
 * one rule for when the echo may show (2026-11-01, the user, twice: "after I
 * deselect, the highlight stays", then on a plugin's problem page "it never
 * removes the highlight"). Each surface had its own painter and its own idea of
 * "deselected", so fixing one left the other tinting around a selection the user
 * no longer saw. tests/web/selection-match-ratchet.test.ts fails on a painter
 * that does not come through here.
 *
 * The echo shows only while the user can see the selection:
 *   - it is not collapsed;
 *   - focus is not in a field, an editor or a frame that does not hold it (a
 *     click into a frame leaves the page's selection in place, painted inactive);
 *   - a selection inside an editor shows only while that editor has focus;
 *   - a mouse press anywhere outside it ends it, even when the browser keeps the
 *     selection (a press on text that cannot be selected, an editor that takes
 *     the press itself), until the selection changes; a control that cancels its
 *     press to keep the selection (Copy, Comment) ends nothing.
 * Any of these turning false takes every echo paint off at once, whichever
 * surface painted it.
 */
import { applyHighlights, HL_SELMATCH } from './dom-text-search';
import { HL_PAGE_SELMATCH, rangesForQuery, SELMATCH_CAP, type FindIndex } from './page-find';

/** The echo's highlight names; only this module paints them. */
export const ECHO_HIGHLIGHTS = [HL_SELMATCH, HL_PAGE_SELMATCH] as const;
export type EchoName = (typeof ECHO_HIGHLIGHTS)[number];

const FIELD = 'input, textarea, select';

interface Mark { an: Node | null; ao: number; fn: Node | null; fo: number }
const markOf = (sel: Selection): Mark => ({ an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset });
const same = (a: Mark, b: Mark) => a.an === b.an && a.ao === b.ao && a.fn === b.fn && a.fo === b.fo;
/** The selection a press outside it ended (the browser may keep it all the same). */
let ended: Mark | null = null;

const isEditable = (el: Element | null): boolean => !!(el as HTMLElement | null)?.isContentEditable;

/** May the echo show for this selection, with focus on `active`? */
export function echoVisible(sel: Selection | null, active: Element | null): boolean {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  if (ended && same(ended, markOf(sel))) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return false;
  const doc = el.ownerDocument;
  // The user is somewhere else: a field, an editor, or a frame (a plugin's page)
  // that does not hold the selection.
  if (active && active !== doc.body && active !== doc.documentElement
    && (active.matches(FIELD) || isEditable(active) || active.tagName === 'IFRAME') && !active.contains(node)) return false;
  // A selection inside an editor is painted only while that editor has focus.
  if (isEditable(el)) {
    const editor = el.closest('[contenteditable]:not([contenteditable="false"])');
    if (!editor || !active || !editor.contains(active)) return false;
  }
  return true;
}

function pointInSelection(sel: Selection, x: number, y: number): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    // jsdom has no layout: no rects, so no press can be told to be on the selection.
    if (typeof range.getClientRects !== 'function') return true;
    for (const r of Array.from(range.getClientRects())) {
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
    }
  }
  return false;
}

/** A press on an element's own scrollbar (outside its client box) scrolls; it ends nothing. */
function onScrollbar(e: PointerEvent): boolean {
  const t = e.target;
  if (!(t instanceof Element) || t.clientWidth === 0) return false;
  // The root's box moves with the page's scroll; its client box is the viewport.
  if (t === t.ownerDocument.documentElement) return e.clientX > t.clientWidth || e.clientY > t.clientHeight;
  const box = t.getBoundingClientRect();
  return e.clientX - box.left - t.clientLeft > t.clientWidth || e.clientY - box.top - t.clientTop > t.clientHeight;
}

const painted = new Set<() => void>();
const listeners = new Set<() => void>();
let installed = false;
let shown = false;

/** Take every echo off when the selection is no longer the user's, and tell the
 *  surfaces when the selection changed or the echo's visibility flipped (only then:
 *  each one clears and repaints on a call, so a call on every press would blink). */
function check(selectionMoved: boolean): void {
  const visible = echoVisible(document.getSelection(), document.activeElement);
  if (!visible) for (const undo of [...painted]) undo();
  const flipped = visible !== shown;
  shown = visible;
  if (selectionMoved || flipped) for (const fn of [...listeners]) fn();
}

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const recheck = () => check(false);
  // A mouse press outside the selection ends it, unless the press was meant to keep
  // it: a control that acts on the selection (Copy, Comment, an editor's toolbar)
  // cancels its mousedown so the selection survives. That shows only after the
  // press's handlers ran, so decide a tick later. Touch and pen are left out: a
  // finger that starts a scroll keeps the selection on purpose, and a tap clears it.
  // The press is held only from its pointerdown to that tick: an event keeps its
  // target, and with it the whole subtree the target sat in, alive. Kept until the
  // next press, the last click on a column's Close button held the closed column's
  // DOM for the life of the page (session-column-close-releases-dom.spec.ts).
  let press: MouseEvent | null = null;
  let awaitingPress = false;
  document.addEventListener('mousedown', (e) => { if (awaitingPress) press = e; }, true);
  document.addEventListener('pointerdown', (e) => {
    const sel = document.getSelection();
    if (e.pointerType !== 'mouse' || onScrollbar(e)) return;
    if (!sel || sel.isCollapsed || !sel.rangeCount || pointInSelection(sel, e.clientX, e.clientY)) {
      // Back on the selection (a double click on the same word again): it is the
      // user's once more. Its selectionchange events may fold into one that reads
      // the very mark the old press left, so it would never clear `ended`.
      if (ended) { ended = null; recheck(); }
      return;
    }
    const mark = markOf(sel);
    press = null;
    awaitingPress = true;
    window.setTimeout(() => {
      const kept = e.defaultPrevented || !!press?.defaultPrevented;
      press = null;
      awaitingPress = false;
      if (kept) return;
      const now = document.getSelection();
      if (now && same(mark, markOf(now))) ended = mark;
      recheck();
    }, 0);
  }, true);
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (ended && !(sel && same(ended, markOf(sel)))) ended = null;
    check(true);
  });
  // Focus moving into or out of an editor changes whose selection the user sees,
  // and fires no selectionchange.
  document.addEventListener('focusin', recheck);
  document.addEventListener('focusout', recheck);
  // A click into a frame moves focus into another document: only the window hears it.
  window.addEventListener('blur', recheck);
  window.addEventListener('focus', recheck);
}

/** Run `fn` on every change that can show or hide the echo (it repaints or clears). */
export function subscribeEcho(fn: () => void): () => void {
  install();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The ONE echo painter: paints only while the selection may show, and is taken off
 *  with it. Returns the undo. */
export function paintEcho(win: Window, name: EchoName, ranges: readonly AbstractRange[]): () => void {
  install();
  const doc = win.document;
  if (!ranges.length || !echoVisible(doc.getSelection(), doc.activeElement)) return () => {};
  const undo = applyHighlights(win, name, ranges as Range[]);
  const done = () => { if (painted.delete(done)) undo(); };
  painted.add(done);
  return done;
}

/** The page echo: every exact (case-sensitive) visible copy of `needle` in `index`. */
export function paintSelectionMatches(index: FindIndex, needle: string): () => void {
  return paintEcho(window, HL_PAGE_SELMATCH, rangesForQuery(index, needle, true, SELMATCH_CAP).ranges);
}

/** Tests only. */
export function resetSelectionEcho(): void {
  for (const undo of [...painted]) undo();
  ended = null;
  shown = false;
}
