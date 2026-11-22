/**
 * WikiLink Autocomplete popup — shows note suggestions when user types [[.
 * Positioned near the cursor, navigated via keyboard.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { WikiLinkState } from './WikiLinkExtension';
import type { NoteListItem } from '@/api/notes-v2';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';

interface WikiLinkAutocompleteProps {
  editor: Editor;
  state: WikiLinkState & { phase: 'searching' };
  notes: NoteListItem[];
  onClose: () => void;
  onSelect: (note: NoteListItem) => void;
  onCreateNew: (name: string) => void;
}

export function WikiLinkAutocomplete({
  editor,
  state,
  notes,
  onClose,
  onSelect,
  onCreateNew,
}: WikiLinkAutocompleteProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rangeRef = useRef(state.range);
  rangeRef.current = state.range;

  // Filter notes by query
  const filtered = useMemo(() => {
    const q = state.query.toLowerCase().trim();
    if (!q) return notes.slice(0, 10);
    return notes
      .filter(n => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, 10);
  }, [notes, state.query]);

  // Reset selection when results change
  useEffect(() => { setSelectedIdx(0); }, [filtered]);

  // Position the popup, clamped to viewport boundaries
  useEffect(() => {
    try {
      const c = editor.view.coordsAtPos(state.range.from);
      const panelH = panelRef.current?.getBoundingClientRect().height || 200;
      const panelW = panelRef.current?.getBoundingClientRect().width || 300;
      const aboveTop = c.top - panelH - 4;
      const belowTop = c.bottom + 4;
      const top = Math.max(4, aboveTop >= 0 ? aboveTop : belowTop);
      const left = Math.max(4, Math.min(c.left, window.innerWidth - panelW - 8));
      setCoords({ left, top });
    } catch {
      setCoords(null);
    }
  }, [editor, state.range.from, filtered]);

  // Select handler — declared before keyboard effect that depends on it
  const handleSelect = useCallback((idx: number) => {
    if (idx < filtered.length) {
      onSelect(filtered[idx]);
    } else {
      // "Create new" option
      const name = state.query.trim();
      if (name) onCreateNew(name);
    }
  }, [filtered, onSelect, onCreateNew, state.query]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.min(i + 1, filtered.length)); // +1 for "create new" option
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.max(i - 1, 0));
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(selectedIdx);
        return;
      }
    };

    // The `true` flag registers in the capture phase, which fires before the
    // bubble phase. This is essential because ProseMirror consumes keyboard
    // events during the bubble phase; listening in the bubble phase would mean
    // our handler never receives ArrowUp/ArrowDown/Enter/Tab when the
    // editor is focused.
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, selectedIdx, handleSelect]);

  // Escape and an outside press close. Focus stays in the editor (no Tab trap: Tab picks a row),
  // and the outside click goes through: a press on the toolbar or the text does what it says.
  useOverlayLayer({ open: true, onClose, refs: [panelRef], trapFocus: false, passOutsideClick: true });

  if (!coords) return null;

  const showCreateOption = state.query.trim().length > 0 &&
    !filtered.some(n => n.name.toLowerCase() === state.query.trim().toLowerCase());

  return createPortal(
    <div
      ref={panelRef}
      className="notes-wikilink-panel wn-overlay wn-menu"
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        zIndex: 'var(--z-menu)',
      }}
    >
      {filtered.length === 0 && !showCreateOption ? (
        <div className="notes-wikilink-empty">No notes found</div>
      ) : (
        <>
          {filtered.map((note, i) => (
            <div
              key={note.path}
              className={`notes-wikilink-item ${i === selectedIdx ? 'selected' : ''}`}
              ref={i === selectedIdx ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { onSelect(note); }}
            >
              <span className="notes-wikilink-name">{note.name}</span>
              {note.path !== `${note.name}.md` && (
                <span className="notes-wikilink-path">{note.path.replace(/\.md$/, '')}</span>
              )}
            </div>
          ))}
          {showCreateOption && (
            <div
              className={`notes-wikilink-item notes-wikilink-create ${filtered.length === selectedIdx ? 'selected' : ''}`}
              ref={filtered.length === selectedIdx ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseEnter={() => setSelectedIdx(filtered.length)}
              onClick={() => onCreateNew(state.query.trim())}
            >
              <span className="notes-wikilink-create-label">Create "{state.query.trim()}"</span>
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
