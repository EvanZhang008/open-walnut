/**
 * Note-link sub-panel for the slash command system.
 * Fuzzy-searches the vault note list and inserts an Obsidian-native [[Title]]
 * (plain text). A "Create" row lets the user link a not-yet-existing note —
 * the backend assigns the id on first save (NEVER an id in link text).
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { NoteListItem } from '@/api/notes-v2';

const MAX_RESULTS = 15;

interface NoteLinkPanelProps {
  notes: NoteListItem[];
  /** Receives the title/name to embed inside [[ ]]. */
  onSelect: (noteName: string) => void;
  onBack: () => void;
}

export function NoteLinkPanel({ notes, onSelect, onBack }: NoteLinkPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes.slice(0, MAX_RESULTS);
    return notes
      .filter(n => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [notes, query]);

  const showCreate = query.trim().length > 0 &&
    !results.some(n => n.name.toLowerCase() === query.trim().toLowerCase());

  // Total selectable rows = results + (create row?)
  const rowCount = results.length + (showCreate ? 1 : 0);

  useEffect(() => { setSelectedIdx(0); }, [query]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const choose = useCallback((idx: number) => {
    if (idx < results.length) {
      // Use display name (basename, no .md) for the bare [[Title]] form.
      onSelect(results[idx].name);
    } else if (showCreate) {
      onSelect(query.trim());
    }
  }, [results, showCreate, query, onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, Math.max(0, rowCount - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(selectedIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  }, [rowCount, selectedIdx, choose, onBack]);

  return (
    <div className="notes-slash-panel notes-task-search" onKeyDown={handleKeyDown}>
      <div className="notes-task-search-header">
        <button
          className="notes-task-search-back"
          onMouseDown={(e) => { e.preventDefault(); onBack(); }}
          title="Back to commands"
        >
          &larr;
        </button>
        <input
          data-no-draft="picker"
          ref={inputRef}
          className="notes-task-search-input"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Link to note..."
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="notes-task-search-list" ref={listRef}>
        {rowCount === 0 ? (
          <div className="notes-slash-empty">No notes found</div>
        ) : (
          <>
            {results.map((note, i) => (
              <div
                key={note.path}
                className={`notes-task-search-item ${i === selectedIdx ? 'notes-slash-item-active' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); onSelect(note.name); }}
              >
                <div className="notes-task-search-title">{note.name}</div>
                {note.path !== `${note.name}.md` && (
                  <div className="notes-task-search-meta">
                    <span className="notes-task-search-project">{note.path.replace(/\.md$/, '')}</span>
                  </div>
                )}
              </div>
            ))}
            {showCreate && (
              <div
                className={`notes-task-search-item ${results.length === selectedIdx ? 'notes-slash-item-active' : ''}`}
                onMouseEnter={() => setSelectedIdx(results.length)}
                onMouseDown={(e) => { e.preventDefault(); onSelect(query.trim()); }}
              >
                <div className="notes-task-search-title">Link new note "{query.trim()}"</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
