/**
 * A box's unsent words, kept in the draft store (utils/drafts.ts) under `key`.
 *
 *   const draft = useDraft(draftKey('question', sessionId, threadKey));
 *   <textarea data-draft-key={draft.key} value={draft.text} onChange={(e) => draft.setText(e.target.value)} />
 *   // after the send succeeded:
 *   draft.clear();
 *
 * Every change is written within DEBOUNCE_MS, and at once when the box unmounts,
 * moves to another key, or the page is about to reload or close. The element
 * carries `data-draft-key` so a reload's unsaved-work check knows its text is
 * kept, and so the ratchet can see the box is wired. A change made somewhere
 * else (another window or device) shows here when this box is not being typed in.
 *
 * `baseline` is the text that means "nothing unsaved" (an edit field's saved
 * value): the box starts from it when there is no draft, and text equal to it
 * is no draft.
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { discardedSince, draftSaveMark, isSentDraftCopy, markDraftSent, readDraft, subscribeDraft, writeDraft } from '@/utils/drafts';
import { DRAFT_FLUSH_EVENT, noteDraftWrite, type DraftFlushDetail } from '@/utils/unsaved-work';

const DEBOUNCE_MS = 300;

export interface DraftHandle {
  /** The key (null: this box keeps nothing yet, e.g. its object has no id). */
  key: string | null;
  text: string;
  setText: (next: SetStateAction<string>) => void;
  /**
   * Sent, or the person cleared it: the draft is gone and the box empties (to
   * `baseline`). Pass the key the sent words were read under (`draft.key` taken
   * before an await): only that draft goes, and the box empties only if it still
   * shows it, so a send that finishes after the box moved to another object
   * never wipes that object's words. With `sentText`, words typed in the box
   * while the send was on its way (the box no longer shows what was sent) stay.
   */
  clear: (sentKey?: string | null, sentText?: string) => void;
  /** Write the change still waiting on the debounce now. */
  flush: () => void;
}

function draftElements(key: string): Element[] {
  try { return Array.from(document.querySelectorAll(`[data-draft-key="${CSS.escape(key)}"]`)); } catch { return []; }
}

export function useDraft(key: string | null | undefined, opts: { baseline?: string } = {}): DraftHandle {
  const k = key || null;
  const baseline = opts.baseline ?? '';
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const load = (from: string | null) => (from && readDraft(from)) || baselineRef.current;

  const [text, setTextState] = useState(() => load(k));
  const textRef = useRef(text);
  textRef.current = text;
  const keyRef = useRef(k);
  const pending = useRef<{ key: string; text: string; mark: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The mark of the words last typed here (0: none), for the reload flush.
  const typedMark = useRef(0);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    // The owner discarded the draft after these words were typed, or they were
    // sent since (utils/drafts.ts).
    if (!p || discardedSince(p.key, p.mark) || isSentDraftCopy(p.key, p.text, p.mark)) return;
    writeDraft(p.key, p.text === baselineRef.current ? '' : p.text);
    noteDraftWrite();
  }, []);

  // Another key (the box now belongs to another object): the old one's words are
  // written there first, then this key's are read.
  useEffect(() => {
    if (keyRef.current === k) return;
    flush();
    keyRef.current = k;
    const next = load(k);
    textRef.current = next;
    setTextState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, flush]);

  // A baseline that changes under an untouched box (the saved value moved) is shown.
  useEffect(() => {
    const kk = keyRef.current;
    if (pending.current || (kk && readDraft(kk))) return;
    textRef.current = baseline;
    setTextState(baseline);
  }, [baseline]);

  useEffect(() => () => flush(), [flush]);

  const setText = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === 'function' ? (next as (prev: string) => string)(textRef.current) : next;
    textRef.current = value;
    setTextState(value);
    const kk = keyRef.current;
    if (!kk) return;
    typedMark.current = draftSaveMark();
    pending.current = { key: kk, text: value, mark: typedMark.current };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);

  const clear = useCallback((sentKey?: string | null, sentText?: string) => {
    const kk = keyRef.current;
    const target = sentKey === undefined ? kk : sentKey;
    // Every box of the key, and the server's copy, now leaves the sent words out.
    const sent = sentText ?? (target === kk ? textRef.current : '');
    if (target) markDraftSent(target, sent);
    if (sentText !== undefined && target === kk && textRef.current.trim() !== sentText.trim()) return;
    if (target) { writeDraft(target, ''); noteDraftWrite(); }
    if (target !== kk && sentKey !== undefined) return;
    clearTimeout(timer.current);
    pending.current = null;
    textRef.current = baselineRef.current;
    setTextState(baselineRef.current);
  }, []);

  // A reload or an app restart asks every box to save now; this one claims its elements.
  useEffect(() => {
    const onFlush = (e: Event) => {
      const kk = keyRef.current;
      const detail = (e as CustomEvent<DraftFlushDetail>).detail;
      if (!kk || !detail?.claims) return;
      if (pending.current) flush();
      const stored = readDraft(kk);
      const t = textRef.current;
      if (t !== baselineRef.current && stored !== t && !isSentDraftCopy(kk, t, typedMark.current)) { writeDraft(kk, t); noteDraftWrite(); }
      for (const element of draftElements(kk)) detail.claims.push({ element, key: kk, text: readDraft(kk) });
    };
    window.addEventListener(DRAFT_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(DRAFT_FLUSH_EVENT, onFlush);
  }, [flush]);

  // Typed in another window or on another device: shown while this box is not in use.
  useEffect(() => {
    if (!k) return;
    // Another box of this key that unmounted in the same commit (a card closing
    // as its compact twin comes back) wrote its words after this one's first
    // render read the store, and before this subscription: read it once more.
    const stored = load(k);  // eslint-disable-line react-hooks/exhaustive-deps -- reads the store now
    if (!pending.current && stored !== textRef.current) {
      const active = document.activeElement;
      if (!(active && active.getAttribute('data-draft-key') === k)) {
        textRef.current = stored;
        setTextState(stored);
      }
    }
    return subscribeDraft(k, (remote) => {
      if (pending.current) return;
      const active = document.activeElement;
      if (active && active.getAttribute('data-draft-key') === k) return;
      const next = remote || baselineRef.current;
      textRef.current = next;
      setTextState(next);
    });
  }, [k]);

  return { key: k, text, setText, clear, flush };
}

export interface DraftValueHandle<T> {
  key: string | null;
  value: T;
  setValue: (next: SetStateAction<T>) => void;
  /** Saved or cancelled: back to `baseline`, draft gone (same `sentKey` rule as useDraft). */
  clear: (sentKey?: string | null, sentText?: string) => void;
  /** The value differs from `baseline` (there is something unsaved). */
  dirty: boolean;
}

/**
 * A form's several fields as ONE draft (JSON under `key`), for a form that holds
 * its fields in one state object. `baseline` is the saved value (or the empty
 * form): the form starts from the draft when there is one, else from it, and a
 * value equal to it is no draft. Every field's element carries
 * `data-draft-key={form.key}`.
 */
export function useDraftValue<T>(key: string | null | undefined, baseline: T): DraftValueHandle<T> {
  const base = JSON.stringify(baseline) ?? '';
  const draft = useDraft(key, { baseline: base });
  const baseRef = useRef(baseline);
  baseRef.current = baseline;
  const parse = (text: string): T => {
    if (text === base) return baseRef.current;
    try { return JSON.parse(text) as T; } catch { return baseRef.current; }
  };
  const value = parse(draft.text);
  const { setText } = draft;
  const setValue = useCallback((next: SetStateAction<T>) => {
    setText((prevText) => {
      let prev: T;
      try { prev = JSON.parse(prevText) as T; } catch { prev = baseRef.current; }
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      return JSON.stringify(v) ?? '';
    });
  }, [setText]);
  return { key: draft.key, value, setValue, clear: draft.clear, dirty: draft.text !== base };
}

/**
 * For a box that writes its draft itself (writeDraft / writeDraftJson, at once):
 * a reload's unsaved-work check learns its elements are kept.
 */
export function useDraftClaim(key: string | null | undefined): void {
  useEffect(() => {
    if (!key) return;
    const onFlush = (e: Event) => {
      const detail = (e as CustomEvent<DraftFlushDetail>).detail;
      const stored = readDraft(key);
      if (!detail?.claims || !stored) return;
      for (const element of draftElements(key)) detail.claims.push({ element, key, text: stored });
    };
    window.addEventListener(DRAFT_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(DRAFT_FLUSH_EVENT, onFlush);
  }, [key]);
}
