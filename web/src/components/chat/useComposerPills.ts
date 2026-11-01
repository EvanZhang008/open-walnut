/**
 * The composer's pills as one unit for the keys and the caret (composer-ref-pills.ts
 * draws them, ComposerRefLayer paints them).
 *
 *   Backspace right after a pill / Delete right before it → the whole reference goes,
 *     through the browser's own edit so Cmd/Ctrl+Z brings it back
 *   ← / → at its edge → the caret steps over it
 *   the caret landing inside its words (a click, a tap, ↑/↓, Home/End) → its nearer edge
 *
 * A reference is never edited letter by letter: a stranded `@[Fix the thin` is no
 * longer a token, and the message would lose the reference.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';
import { cutSpan, type RefTable } from './composer-refs';
import { composerSegments, hasPills, pillAt, type ComposerSegment } from './composer-ref-pills';

export interface ComposerPills {
  segments: readonly ComposerSegment[];
  on: boolean;
  /** Handles the key when it acts on a pill; false leaves it to the browser. */
  onKey: (e: KeyboardEvent) => boolean;
}

export function useComposerPills(a: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  table: RefTable;
  /** The `@query` being typed, never a pill. */
  active: { start: number; end: number } | null;
  /** The file references the picker wrote (a path typed by hand stays text). */
  pickedFiles: ReadonlySet<string>;
  /** When the browser refuses the edit: write the cut text the composer's own way. */
  writeCut: (cut: { text: string; caret: number }) => void;
}): ComposerPills {
  const { textareaRef, value, table, active, pickedFiles } = a;
  const segments = useMemo(
    () => composerSegments(value, table, { active, files: pickedFiles }),
    // The picked set changes only together with the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, table, active?.start, active?.end],
  );
  const segRef = useRef(segments);
  segRef.current = segments;
  const writeCutRef = useRef(a.writeCut);
  writeCutRef.current = a.writeCut;

  useEffect(() => {
    const onSelection = () => {
      const el = textareaRef.current;
      if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) return;
      const pill = pillAt(segRef.current, el.selectionStart, 'inside');
      if (!pill) return;
      const to = el.selectionStart - pill.start < pill.end - el.selectionStart ? pill.start : pill.end;
      el.setSelectionRange(to, to);
    };
    // Engines differ on where selectionchange fires for a textarea (the element, the
    // document, or both) and when; the pointer and key ends are the sure paths. A tap
    // places the caret after touchend, so that one waits a tick.
    const el = textareaRef.current;
    const onTouchEnd = () => { setTimeout(onSelection, 0); };
    document.addEventListener('selectionchange', onSelection);
    el?.addEventListener('selectionchange', onSelection);
    el?.addEventListener('mouseup', onSelection);
    el?.addEventListener('keyup', onSelection);
    el?.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      el?.removeEventListener('selectionchange', onSelection);
      el?.removeEventListener('mouseup', onSelection);
      el?.removeEventListener('keyup', onSelection);
      el?.removeEventListener('touchend', onTouchEnd);
    };
  }, [textareaRef]);

  const onKey = (e: KeyboardEvent): boolean => {
    const el = textareaRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
      const pill = pillAt(segRef.current, caret, e.key === 'ArrowLeft' ? 'before' : 'after');
      if (!pill) return false;
      e.preventDefault();
      const to = e.key === 'ArrowLeft' ? pill.start : pill.end;
      el.setSelectionRange(to, to);
      return true;
    }
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    // Any Backspace (Option/Ctrl+Backspace included) next to a pill takes all of it.
    const pill = pillAt(segRef.current, caret, e.key === 'Backspace' ? 'before' : 'after');
    if (!pill) return false;
    e.preventDefault();
    removeSpan(el, pill.start, pill.end, writeCutRef.current);
    return true;
  };

  return { segments, on: hasPills(segments), onKey };
}

/**
 * Remove `[start, end)` the way cutSpan does (the gap it leaves collapses to one space),
 * as the browser's own edit, so it lands in the undo history and fires the input event
 * every other edit fires. Falls back to `writeCut` when the browser refuses it.
 */
function removeSpan(el: HTMLTextAreaElement, start: number, end: number, writeCut: (cut: { text: string; caret: number }) => void): void {
  const text = el.value;
  const head = text.slice(0, start);
  const tail = text.slice(end);
  let to = end;
  let insert = '';
  if (head === '' || /\s$/.test(head)) to = end + (tail.match(/^[ \t]*/)?.[0].length ?? 0);
  else if (tail !== '' && !/^\s/.test(tail)) insert = ' ';
  el.setSelectionRange(start, to);
  let done = false;
  try {
    done = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
  } catch { done = false; }
  if (!done || el.value === text) {
    el.value = text;
    writeCut(cutSpan(text, start, end));
  }
}
