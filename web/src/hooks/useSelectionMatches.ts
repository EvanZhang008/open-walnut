/**
 * Select text → every exact match tints (VS Code), on the DOM surfaces: the file
 * preview, its WYSIWYG editor, read-only code, the diff. CodeMirror does its own
 * (highlightSelectionMatches, hidden while it is not focused).
 *
 * This hook only says WHERE to look and WHAT matches; when the echo may show, and
 * the paint itself, belong to utils/selection-echo.ts, the one painter of the
 * selected-word echo for these surfaces and the page alike (2026-11-01: a second
 * painter of its own kept the page's echo on after the selection went).
 */
import { useCallback, useEffect, useRef, type DependencyList } from 'react';
import { HL_SELMATCH } from '@/utils/dom-text-search';
import { echoVisible, paintEcho, subscribeEcho } from '@/utils/selection-echo';

const MIN_CHARS = 3;
const MAX_CHARS = 200;
/** Wait for a drag to settle before scanning the whole body. */
const SETTLE_MS = 120;

/**
 * The selected text the matches are painted for, or null: none, too short or long,
 * more than one line, outside `root`, or one the user cannot see (selection-echo).
 */
export function liveSelectionText(root: HTMLElement | null, sel: Selection | null, active: Element | null): string | null {
  if (!root || !sel || !echoVisible(sel, active)) return null;
  const t = sel.toString().trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS || t.includes('\n')) return null;
  if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return null;
  return t;
}

export function useSelectionMatches(
  findRoot: () => HTMLElement | null,
  collect: (root: HTMLElement, text: string) => Range[],
  deps: DependencyList,
): () => void {
  const clearRef = useRef<(() => void) | null>(null);
  const findRef = useRef(findRoot);
  findRef.current = findRoot;
  const collectRef = useRef(collect);
  collectRef.current = collect;

  const clear = useCallback(() => {
    clearRef.current?.();
    clearRef.current = null;
  }, []);
  const refresh = useCallback(() => {
    clear();
    const root = findRef.current();
    const text = liveSelectionText(root, window.getSelection(), document.activeElement);
    if (!root || !text) return;
    clearRef.current = paintEcho(window, HL_SELMATCH, collectRef.current(root, text));
  }, [clear]);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      // The old paint goes at once; only the new scan waits for the drag to settle.
      clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, SETTLE_MS);
    };
    const unsubscribe = subscribeEcho(onChange);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps name what it paints over
  }, [clear, refresh, ...deps]);
  /** Paint now (a mouseup that ends a drag), without the settle wait. */
  return refresh;
}
