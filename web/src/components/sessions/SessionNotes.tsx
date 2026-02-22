import { useState, useRef, useEffect, useCallback } from 'react';
import { updateSession } from '@/api/sessions';

interface SessionNotesProps {
  sessionId: string;
  initialNote?: string;
  onNoteChanged?: () => void;
}

export function SessionNotes({ sessionId, initialNote, onNoteChanged }: SessionNotesProps) {
  const [note, setNote] = useState(initialNote ?? '');
  const [isExpanded, setIsExpanded] = useState(!!initialNote);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedIndicatorRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSavedRef = useRef(initialNote ?? '');

  // Sync when session changes
  useEffect(() => {
    setNote(initialNote ?? '');
    lastSavedRef.current = initialNote ?? '';
    setIsExpanded(!!initialNote);
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

  const handleChange = (value: string) => {
    setNote(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveNote(value), 1000);
  };

  // Save on unmount if pending
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(savedIndicatorRef.current);
    };
  }, []);

  const toggleExpand = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next) {
      // Focus textarea after expansion
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  };

  // Preview: first line of note, truncated
  const preview = note
    ? note.split('\n')[0].slice(0, 80) + (note.length > 80 ? '...' : '')
    : '';

  return (
    <div className="session-notes">
      <button className="session-notes-toggle" onClick={toggleExpand}>
        <span className="session-notes-arrow">{isExpanded ? '\u25BE' : '\u25B8'}</span>
        <span className="session-notes-label">Notes</span>
        {saveStatus === 'saving' && <span className="session-notes-status session-notes-status-saving">Saving...</span>}
        {saveStatus === 'saved' && <span className="session-notes-status session-notes-status-saved">Saved</span>}
        {!isExpanded && preview && (
          <span className="session-notes-preview">{preview}</span>
        )}
        {!isExpanded && !preview && (
          <span className="session-notes-placeholder">Add a note...</span>
        )}
      </button>
      {isExpanded && (
        <div className="session-notes-body">
          <textarea
            ref={textareaRef}
            className="session-notes-textarea"
            value={note}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Write session notes here... (supports plain text)"
            rows={4}
          />
        </div>
      )}
    </div>
  );
}
