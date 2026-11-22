/**
 * WikiLinkDisambiguation — a small centered picker shown when a clicked bare
 * `[[Title]]` resolves to MORE THAN ONE note (the Obsidian 'ambiguous' case,
 * §2.2). The user picks which target to open. Resolution keys on the target's
 * path (id is display-only here); we never silently mis-resolve.
 */

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { NoteListItem } from '@/api/notes-v2';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface WikiLinkDisambiguationProps {
  /** The link text the user clicked. */
  target: string;
  /** The candidate notes that share this title/basename. */
  candidates: NoteListItem[];
  onPick: (note: NoteListItem) => void;
  onClose: () => void;
}

export function WikiLinkDisambiguation({ target, candidates, onPick, onClose }: WikiLinkDisambiguationProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  const pick = useCallback(
    (idx: number) => {
      const note = candidates[idx];
      if (note) onPick(note);
    },
    [candidates, onPick],
  );

  // Escape, the shared scroll lock and nesting: the editor lets Escape through (NotesEditor).
  useModalOverlay(onClose);

  // Keyboard: arrows to move, Enter to pick. Capture phase so the editor's own
  // keymap doesn't swallow the keys while it still holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.min(i + 1, candidates.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pick(selectedIdx);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [candidates.length, selectedIdx, pick]);

  return createPortal(
    <div className="notes-wikilink-disambig-overlay app-modal-overlay wn-scrim" onMouseDown={onClose}>
      <div
        className="notes-wikilink-disambig app-modal wn-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a note named ${target}`}
      >
        <div className="notes-wikilink-disambig-header wn-dialog-head">
          <span>Multiple notes named <strong>{target}</strong> — pick one:</span>
        </div>
        <div className="notes-wikilink-disambig-list">
          {candidates.map((note, i) => (
            <button
              key={note.path}
              type="button"
              className={`notes-wikilink-disambig-item ${i === selectedIdx ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => pick(i)}
            >
              <span className="notes-wikilink-disambig-name">{note.title || note.name}</span>
              <span className="notes-wikilink-disambig-path">{note.path.replace(/\.md$/, '')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
