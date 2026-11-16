import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { updateSession } from '@/api/sessions';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { MicButton } from '../common/MicButton';
import { LinkifiedText } from '../common/LinkifiedText';
import { CollapsibleUrlEditor, type CollapsibleUrlEditorHandle } from '../common/CollapsibleUrlEditor';

/**
 * One reference note, shared by every session surface. It is the top band of the
 * composer card (ChatInput's `noteSlot`), so reading and editing are the same
 * element: a small "Note" label with its controls on one row, then the text in
 * the chat's own type. Edit in place; the autosave keeps the full text, links and
 * line breaks included. Closing the editor trims leading blank lines and trailing
 * whitespace. Empty notes use the Note pill.
 */

/** The text a closed note keeps: no blank lines before it, no whitespace after it. */
export function tidyNote(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

export interface SessionNoteState {
  note: string;
  hasNote: boolean;
  saveStatus: 'idle' | 'saving' | 'saved';
  handleChange: (value: string) => void;
  /** Save now, tidied (the editor closed). */
  finish: () => void;
}

export function useSessionNote(sessionId: string, initialNote?: string, onNoteChanged?: () => void): SessionNoteState {
  const [note, setNote] = useState(initialNote ?? '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedIndicatorRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSavedRef = useRef(initialNote ?? '');
  const noteRef = useRef(initialNote ?? '');
  noteRef.current = note;
  /** The value of the save in flight, so a second save of it is skipped. */
  const sendingRef = useRef<string | null>(null);
  /** Every value this hook sent for this session: the server's echo of one of them
   *  is not news, and must not replace what the user typed since. */
  const sentRef = useRef(new Set<string>());
  const sessionRef = useRef(sessionId);

  // Sync when the session changes, or when the note changed elsewhere.
  useEffect(() => {
    const next = initialNote ?? '';
    if (sessionRef.current === sessionId && sentRef.current.has(next)) {
      lastSavedRef.current = next;
      return;
    }
    sessionRef.current = sessionId;
    sentRef.current = new Set();
    setNote(next);
    lastSavedRef.current = next;
    setSaveStatus('idle');
  }, [sessionId, initialNote]);

  const saveNote = useCallback(async (value: string) => {
    if (value === lastSavedRef.current || value === sendingRef.current) return;
    sendingRef.current = value;
    sentRef.current.add(value);
    setSaveStatus('saving');
    try {
      await updateSession(sessionId, { human_note: value });
      lastSavedRef.current = value;
      setSaveStatus('saved');
      clearTimeout(savedIndicatorRef.current);
      savedIndicatorRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      onNoteChanged?.();
    } catch {
      sentRef.current.delete(value);
      setSaveStatus('idle');
    } finally {
      if (sendingRef.current === value) sendingRef.current = null;
    }
  }, [sessionId, onNoteChanged]);

  const handleChange = useCallback((value: string) => {
    setNote(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveNote(value), 1000);
  }, [saveNote]);

  const finish = useLeanCallback(() => {
    clearTimeout(debounceRef.current);
    // Opened and closed with no edit: nothing to write, not even the tidy-up.
    if (noteRef.current === lastSavedRef.current && sendingRef.current === null) return;
    const tidy = tidyNote(noteRef.current);
    if (tidy !== noteRef.current) setNote(tidy);
    void saveNote(tidy);
  }, [saveNote]);

  // Clear pending timers on unmount
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(savedIndicatorRef.current);
    };
  }, []);

  return { note, hasNote: note.trim().length > 0, saveStatus, handleChange, finish };
}

interface SessionNotesPartProps {
  noteState: SessionNoteState;
  /** Expansion is owned by the parent so the kebab "Notes" item, pill, and row stay in sync. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /**
   * Explicit "close" (not toggle). Blur-driven collapse MUST NOT toggle: a stray
   * blur racing a click would re-OPEN a just-closed editor (or close a just-opened
   * one — the 2026-07-30 "flashes open then shut" bug). Falls back to toggle.
   */
  onCollapse?: () => void;
}

/** Text-only "Note" pill next to btw — only rendered while NO note exists. */
export function SessionNotesPill({ noteState, expanded, onToggleExpanded }: SessionNotesPartProps) {
  if (noteState.hasNote) return null;
  return (
    <button
      className={`side-question-pill session-notes-pill${expanded ? ' is-open' : ''}`}
      onClick={onToggleExpanded}
      title="Add a session note"
    >
      <span>Note</span>
    </button>
  );
}

/**
 * Label budget for a link inside the note row. ≈ a long host + "/…/" + the last
 * path segment — short enough that one deploy link can't eat the row, long
 * enough to still say WHERE it goes and WHAT it is. The host is never
 * abbreviated (you must be able to see a link's destination).
 *
 * Shrinking is safe precisely BECAUSE the full URL is one click away: clicking
 * the note swaps in the textarea, which always holds the raw text verbatim.
 * Short to scan, full to edit.
 */
const NOTE_LINK_LABEL_MAX = 48;

/** Slim always-visible row once a note exists (or while composing a new one). */
export function SessionNotesBar({ noteState, expanded, onToggleExpanded, onCollapse }: SessionNotesPartProps) {
  const { note, hasNote, saveStatus, handleChange, finish } = noteState;
  const editorRef = useRef<CollapsibleUrlEditorHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = onCollapse ?? onToggleExpanded;
  const collapse = useLeanCallback(() => { finish(); close(); }, [finish, close]);

  // The collapsed view keeps the note's LINE STRUCTURE — a note is a checklist
  // ("1. … 2. … 3. …"), and folding it to one line destroyed the shape the user
  // typed. Each line is rendered separately so newlines survive visually; the
  // links are linkified inline within their own line, never lifted out.
  const lines = useMemo(() => tidyNote(note).split('\n'), [note]);

  // Focus the editor the moment it opens. No setTimeout: the old 50ms delay
  // left focus parked on <body> right after the collapsed row unmounted, which
  // is the window the blur-collapse race lived in.
  useEffect(() => {
    if (expanded) editorRef.current?.focus();
  }, [expanded]);

  // Collapse on POINTERDOWN OUTSIDE the card — not on blur. Blur cannot be
  // trusted here: expanding unmounts the focused collapsed row, which fires a
  // focusout with relatedTarget=null; whether that lands in the pre- or
  // post-expand render is browser timing, and in real Chrome it landed post-
  // expand and instantly closed the editor ("it just flashes", 2026-07-30).
  // An outside pointerdown has no such race: the opening click already ended
  // by the time this effect registers the listener.
  useEffect(() => {
    if (!expanded) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) collapse();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [expanded, collapse]);

  // No note and not composing → nothing (the pill is the entry point)
  if (!hasNote && !expanded) return null;

  const status = saveStatus === 'saving'
    ? <span className="session-notes-status">Saving…</span>
    : saveStatus === 'saved'
      ? <span className="session-notes-status session-notes-status-saved">Saved</span>
      : null;

  return (
    <div
      ref={cardRef}
      className={`session-notes${hasNote ? ' session-notes--has-note' : ''}${expanded ? ' is-editing' : ''}`}
      role="region"
      aria-label="Session note"
      // Keyboard escape hatches: Tab out to a REAL element → collapse (keyboard
      // parity with outside-click); Escape → collapse. relatedTarget=null blurs
      // (unmount race, window switch) deliberately do nothing — see above.
      onBlur={(e) => {
        if (expanded && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) collapse();
      }}
      onKeyDown={(e) => {
        if (expanded && e.key === 'Escape') { e.stopPropagation(); collapse(); }
      }}
    >
      <div className="session-notes-heading">
        <span className="session-notes-label">Note</span>
        <span className="session-notes-heading-actions">
          {status}
          {expanded && (
            <MicButton size="sm" onTranscribe={(text) => handleChange(note ? note + ' ' + text : text)} />
          )}
          <button type="button" className="session-notes-action" onClick={expanded ? collapse : onToggleExpanded}>
            {expanded ? 'Done' : 'Edit'}
          </button>
        </span>
      </div>
      {expanded ? (
        // Edit mode: everything is editable, but URLs display COLLAPSED (pill)
        // until the caret moves into them — then they expand to the full text
        // in place, and re-collapse when the caret leaves. The model text is
        // always verbatim; only the presentation shrinks.
        <div className="session-notes-body">
          <CollapsibleUrlEditor
            ref={editorRef}
            className="session-notes-textarea session-notes-editor"
            value={note}
            onChange={handleChange}
            placeholder="Write a note for this session…"
          />
        </div>
      ) : (
        // Not a <button>: an <a> inside a button is invalid HTML and browsers
        // won't dispatch the anchor's navigation. A role=button div keeps the
        // "click the row to edit" affordance while letting links live inside.
        <div
          className="session-notes-toggle"
          role="button"
          tabIndex={0}
          onClick={onToggleExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpanded(); }
          }}
          title={note}
        >
          <span className="session-notes-preview">
            {lines.map((line, i) => (
              <span className="session-notes-line" key={i}>
                <LinkifiedText text={line} max={NOTE_LINK_LABEL_MAX} />
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
