/**
 * Dictation into a rich (TipTap) editor, with the composer's rules (ChatInput's
 * writeDictation, useBoxDictation for plain boxes):
 *
 *  - each live draft replaces the words the last one wrote, in place;
 *  - the final text replaces them too, and only then takes focus and the caret;
 *  - a refined final swaps in only while the words are still untouched;
 *  - a recording the editor was reset under, or whose words the user edited or a
 *    reload replaced, drops its late words.
 *
 * The span is held in document positions and follows every other transaction
 * (editor-dictation-core.ts), so typing elsewhere while speaking never corrupts it.
 *
 * History: drafts and refinements stay out of undo. The final text is written as
 * ONE undoable step over the place the dictation started, so a single undo takes
 * the whole dictation away instead of stepping back through every draft.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import {
  mapDictationSpan,
  planFirstWrite,
  spanText,
  takeBackDraft,
  writeDraft,
  writeFinal,
  writeRefine,
  type EditorDictationSpan,
} from './editor-dictation-core';

/** Meta key on this hook's own transactions: the spans as they stand after it. */
const DICTATION_META = 'walnutDictation';

interface OwnMeta {
  span: EditorDictationSpan | null;
  last: EditorDictationSpan | null;
}

export function useEditorDictation(editor: Editor | null) {
  // The words a draft wrote and still owns; the final words (a refine target).
  const spanRef = useRef<EditorDictationSpan | null>(null);
  const lastRef = useRef<EditorDictationSpan | null>(null);
  // A recording started here and not yet answered with its final text; and one
  // whose words must go nowhere (reset, or its draft was edited or replaced).
  const inFlight = useRef(false);
  const dropLate = useRef(false);
  // An editor nobody has put a caret in yet holds a selection at its very start:
  // dictation then goes to the end of the document, where a note continues.
  const everFocused = useRef(false);

  // Follow the spans through every transaction, appended ones included, in order.
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
      for (const tr of [transaction, ...appendedTransactions]) {
        const own = tr.getMeta(DICTATION_META) as OwnMeta | undefined;
        if (own) {
          spanRef.current = own.span;
          lastRef.current = own.last;
          continue;
        }
        if (!tr.docChanged) continue;
        if (spanRef.current) {
          spanRef.current = mapDictationSpan(spanRef.current, tr.mapping, tr.doc);
          // The draft was edited or replaced: writing the rest anywhere would
          // duplicate or clobber words, so this recording ends here.
          if (!spanRef.current && inFlight.current) dropLate.current = true;
        }
        if (lastRef.current) lastRef.current = mapDictationSpan(lastRef.current, tr.mapping, tr.doc);
      }
    };
    everFocused.current = editor.isFocused;
    const onFocus = () => { everFocused.current = true; };
    editor.on('transaction', onTransaction);
    editor.on('focus', onFocus);
    return () => {
      editor.off('transaction', onTransaction);
      editor.off('focus', onFocus);
      spanRef.current = null;
      lastRef.current = null;
    };
  }, [editor]);

  const dispatch = useCallback((tr: Transaction, meta: OwnMeta, history: boolean) => {
    tr.setMeta(DICTATION_META, meta);
    if (!history) tr.setMeta('addToHistory', false);
    editor!.view.dispatch(tr);
  }, [editor]);

  const anchorPos = useCallback(() => {
    if (!editor) return 0;
    return everFocused.current || editor.isFocused ? editor.state.selection.to : editor.state.doc.content.size;
  }, [editor]);

  const write = useCallback((words: string, isDraft: boolean) => {
    if (dropLate.current) {
      if (!isDraft) dropLate.current = false;
      return;
    }
    if (!isDraft) inFlight.current = false;
    if (!editor || editor.isDestroyed || !editor.isEditable) return;
    const span = spanRef.current;

    if (isDraft) {
      const tr = editor.state.tr;
      const next = writeDraft(tr, span, words, anchorPos());
      if (next) dispatch(tr, { span: next, last: lastRef.current }, false);
      return;
    }

    // Final text. Take the draft (and its padding) back out without a history
    // entry, then write the final words where it started as one undoable step.
    let place: { at: number; pre: string; post: string } | null;
    if (span) {
      const tr = editor.state.tr;
      const before = tr.doc;
      place = takeBackDraft(tr, span);
      dispatch(tr, { span: null, last: words ? lastRef.current : null }, false);
      // Nothing was said after all, or the take-back was refused (a plugin
      // filtered it): writing now would leave both the draft and the words.
      if (!words || (tr.docChanged && editor.state.doc === before)) return;
    } else {
      place = words ? planFirstWrite(editor.state.doc, anchorPos()) : null;
    }
    if (!place) return;
    const tr = editor.state.tr;
    const last = writeFinal(tr, place.at, place.pre, place.post, words);
    tr.setSelection(TextSelection.create(tr.doc, last.to));
    dispatch(tr, { span: null, last }, true);
    // A draft never moves focus (it would collapse a selection the user is
    // dictating about); the final text does, once it is there.
    requestAnimationFrame(() => { if (!editor.isDestroyed) editor.view.focus(); });
  }, [editor, dispatch, anchorPos]);

  const onRefine = useCallback((finalText: string, provisional: string): boolean => {
    const at = lastRef.current;
    if (!editor || editor.isDestroyed || !editor.isEditable) return false;
    if (!at || at.text !== provisional || spanRef.current) return false;
    if (spanText(editor.state.doc, at.from, at.to) !== provisional) return false;
    if (finalText === provisional) return true;
    // The caret at the words' end maps to the refined words' end by itself.
    const tr = editor.state.tr;
    dispatch(tr, { span: null, last: writeRefine(tr, at, finalText) }, false);
    return true;
  }, [editor, dispatch]);

  /** The mic was pressed to start a recording (not the press that stops one). */
  const started = useCallback(() => {
    inFlight.current = true;
    dropLate.current = false;
  }, []);

  /** The editor moved on (saved and closed, switched): no dictation owns any of
   *  it, and a recording still being transcribed must not land in it. */
  const reset = useCallback(() => {
    spanRef.current = null;
    lastRef.current = null;
    if (inFlight.current) dropLate.current = true;
    inFlight.current = false;
  }, []);

  /** The mic is idle again: a recording that ended without words (a failure)
   *  leaves nothing in flight, and nothing late is still owed to be dropped. */
  const settled = useCallback(() => {
    inFlight.current = false;
    dropLate.current = false;
  }, []);

  return {
    onDraft: useCallback((t: string) => write(t, true), [write]),
    onTranscribe: useCallback((t: string) => write(t, false), [write]),
    onRefine,
    started,
    reset,
    settled,
  };
}
