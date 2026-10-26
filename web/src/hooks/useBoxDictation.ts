/**
 * Dictation into a plain text box (the question card's), with the composer's
 * rules (ChatInput's writeDictation): each live draft replaces the span the last
 * one wrote, the final text replaces it too and only then takes focus and the
 * caret, and a refined final swaps in only while the words are still untouched.
 */
import { useCallback, useRef, type RefObject } from 'react';

export interface DictationSpan { start: number; length: number }

/** Put `words` into `value`: over `span` when a dictation already owns one, else
 *  at `caret`, with a space on a side that touches other text. */
export function spliceDictation(value: string, caret: number, span: DictationSpan | null, words: string): { next: string; start: number } {
  if (span) return { next: value.slice(0, span.start) + words + value.slice(span.start + span.length), start: span.start };
  const pos = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  const pre = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const post = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  return { next: before + pre + words + post + after, start: pos + pre.length };
}

export function useBoxDictation(boxRef: RefObject<HTMLTextAreaElement | null>, text: string, setText: (t: string) => void) {
  // The recorder's callbacks outlive renders: read the box's text through a ref.
  const textRef = useRef(text);
  textRef.current = text;
  const spanRef = useRef<DictationSpan | null>(null);
  const lastRef = useRef<{ start: number; text: string } | null>(null);
  // A recording started here and not yet answered with its final text; and one
  // the box was reset under (a send, another question), whose late words go nowhere.
  const inFlight = useRef(false);
  const dropLate = useRef(false);

  const write = useCallback((words: string, isDraft: boolean) => {
    if (dropLate.current) {
      if (!isDraft) dropLate.current = false;
      return;
    }
    if (!isDraft) inFlight.current = false;
    const el = boxRef.current;
    const value = textRef.current;
    const { next, start } = spliceDictation(value, el?.selectionStart ?? value.length, spanRef.current, words);
    textRef.current = next;
    setText(next);
    if (isDraft) { spanRef.current = { start, length: words.length }; return; }
    spanRef.current = null;
    lastRef.current = { start, text: words };
    const caret = start + words.length;
    // The card sits inside the timeline's scroll box: focus must not move it.
    requestAnimationFrame(() => { el?.focus({ preventScroll: true }); el?.setSelectionRange(caret, caret); });
  }, [boxRef, setText]);

  const onRefine = useCallback((finalText: string, provisional: string): boolean => {
    const at = lastRef.current;
    const value = textRef.current;
    if (!at || at.text !== provisional || spanRef.current) return false;
    if (value.slice(at.start, at.start + provisional.length) !== provisional) return false;
    if (finalText === provisional) return true;
    const next = value.slice(0, at.start) + finalText + value.slice(at.start + provisional.length);
    textRef.current = next;
    setText(next);
    lastRef.current = { start: at.start, text: finalText };
    return true;
  }, [setText]);

  /** The mic was pressed to start a recording (not the press that stops one). */
  const started = useCallback(() => {
    inFlight.current = true;
    dropLate.current = false;
  }, []);

  /** The box was sent or moved to another question: no dictation owns any of it,
   *  and a recording still being transcribed must not land in it. */
  const reset = useCallback(() => {
    spanRef.current = null;
    lastRef.current = null;
    if (inFlight.current) dropLate.current = true;
    inFlight.current = false;
  }, []);

  return {
    onDraft: useCallback((t: string) => write(t, true), [write]),
    onTranscribe: useCallback((t: string) => write(t, false), [write]),
    onRefine,
    started,
    reset,
  };
}
