/**
 * Select text → every exact match tints (VS Code), on the DOM surfaces: the file
 * preview, its WYSIWYG editor, read-only code, the diff. CodeMirror does its own
 * (highlightSelectionMatches, hidden while it is not focused).
 *
 * The ONE painter of `walnut-selmatch`; tests/web/selection-match-ratchet.test.ts
 * fails on another. The paint lives exactly as long as a selection the user can
 * see: it goes the moment the selection collapses, and also when an EDITOR holding
 * the selection loses focus (2026-11-01, the user: "after I deselect, the highlight
 * stays"). A click on blank space outside an editor leaves its selection in the
 * document, unpainted, in WebKit and Chromium alike, so every match stayed tinted
 * around nothing the user had selected.
 */
import { useCallback, useEffect, useRef, type DependencyList } from 'react';
import { applyHighlights, HL_SELMATCH } from '@/utils/dom-text-search';

const MIN_CHARS = 3;
const MAX_CHARS = 200;
/** Wait for a drag to settle before scanning the whole body. */
const SETTLE_MS = 120;

/**
 * The selected text the matches are painted for, or null: none, too short or long,
 * more than one line, outside `root`, or in an editor that does not have focus.
 */
export function liveSelectionText(root: HTMLElement | null, sel: Selection | null, active: Element | null): string | null {
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const t = sel.toString().trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS || t.includes('\n')) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  if (!root.contains(node)) return null;
  const el = (node instanceof Element ? node : node.parentElement) as HTMLElement | null;
  if (el?.isContentEditable) {
    const editor = el.closest('[contenteditable]:not([contenteditable="false"])');
    if (!editor || !active || !editor.contains(active)) return null;
  }
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
    clearRef.current = applyHighlights(window, HL_SELMATCH, collectRef.current(root, text));
  }, [clear]);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      // The old paint goes at once; only the new scan waits for the drag to settle.
      clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, SETTLE_MS);
    };
    document.addEventListener('selectionchange', onChange);
    // Focus leaving (or coming back to) an editor changes whether its selection is
    // the user's, and fires no selectionchange.
    document.addEventListener('focusin', onChange);
    document.addEventListener('focusout', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('focusin', onChange);
      document.removeEventListener('focusout', onChange);
      window.clearTimeout(timer);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps name what it paints over
  }, [clear, refresh, ...deps]);
  /** Paint now (a mouseup that ends a drag), without the settle wait. */
  return refresh;
}
