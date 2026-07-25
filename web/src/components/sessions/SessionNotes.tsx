import { useState, useRef, useEffect, useCallback } from 'react';
import { updateSession } from '@/api/sessions';
import { MicButton } from '../common/MicButton';

/**
 * Session notes — minimal two-mode UI sharing one state (useSessionNote):
 *  - NO note  → a quiet text-only "Note" pill next to the btw pill (SessionNotesPill);
 *               clicking it opens the editor row.
 *  - HAS note → an always-visible slim row above the composer (SessionNotesBar):
 *               amber dot + first-line preview. Click to edit in place (auto-saves).
 * The pill hides once a note exists (the row takes over as the entry point).
 */

export interface SessionNoteState {
  note: string;
  hasNote: boolean;
  saveStatus: 'idle' | 'saving' | 'saved';
  handleChange: (value: string) => void;
}

export function useSessionNote(sessionId: string, initialNote?: string, onNoteChanged?: () => void): SessionNoteState {
  const [note, setNote] = useState(initialNote ?? '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedIndicatorRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSavedRef = useRef(initialNote ?? '');

  // Sync when session changes
  useEffect(() => {
    setNote(initialNote ?? '');
    lastSavedRef.current = initialNote ?? '';
    setSaveStatus('idle');
  }, [sessionId, initialNote]);

  const saveNote = useCallback(async (value: string) => {
    if (value === lastSavedRef.current) return;
    setSaveStatus('saving');
    try {
      await updateSession(sessionId, { human_note: value });
      lastSavedRef.current = value;
      setSaveStatus('saved');
      clearTimeout(savedIndicatorRef.current);
      savedIndicatorRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      onNoteChanged?.();
    } catch {
      setSaveStatus('idle');
    }
  }, [sessionId, onNoteChanged]);

  const handleChange = useCallback((value: string) => {
    setNote(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveNote(value), 1000);
  }, [saveNote]);

  // Clear pending timers on unmount
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(savedIndicatorRef.current);
    };
  }, []);

  return { note, hasNote: note.trim().length > 0, saveStatus, handleChange };
}

interface SessionNotesPartProps {
  noteState: SessionNoteState;
  /** Expansion is owned by the parent so the kebab "Notes" item, pill, and row stay in sync. */
  expanded: boolean;
  onToggleExpanded: () => void;
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

/** Slim always-visible row once a note exists (or while composing a new one). */
export function SessionNotesBar({ noteState, expanded, onToggleExpanded }: SessionNotesPartProps) {
  const { note, hasNote, saveStatus, handleChange } = noteState;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea when the editor opens
  useEffect(() => {
    if (expanded) {
      const t = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expanded]);

  // No note and not composing → nothing (the pill is the entry point)
  if (!hasNote && !expanded) return null;

  const status = saveStatus === 'saving'
    ? <span className="session-notes-status">Saving…</span>
    : saveStatus === 'saved'
      ? <span className="session-notes-status session-notes-status-saved">Saved</span>
      : null;

  return (
    <div
      className={`session-notes${hasNote ? ' session-notes--has-note' : ''}`}
      // Collapse when focus leaves the whole card (not on textarea→mic moves)
      onBlur={(e) => {
        if (expanded && !e.currentTarget.contains(e.relatedTarget as Node)) onToggleExpanded();
      }}
    >
      {expanded ? (
        <div className="session-notes-body">
          <textarea
            ref={textareaRef}
            className="session-notes-textarea"
            value={note}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Session note…"
            rows={3}
          />
          <div className="session-notes-side">
            {status}
            <MicButton size="sm" onTranscribe={(text) => handleChange(note ? note + ' ' + text : text)} />
          </div>
        </div>
      ) : (
        <button className="session-notes-toggle" onClick={onToggleExpanded} title={note}>
          <span className="session-notes-dot" aria-hidden="true" />
          <span className="session-notes-preview">{note.split('\n')[0]}</span>
          {status}
        </button>
      )}
    </div>
  );
}
