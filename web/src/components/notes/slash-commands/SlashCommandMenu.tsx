/**
 * Floating command list — shows available slash commands and supports
 * keyboard navigation (ArrowUp/Down, Enter to select, Escape to close).
 */

import { useState, useEffect } from 'react';
import type { NoteSlashCommand } from './types';
import { NOTE_SLASH_COMMANDS } from './types';

interface SlashCommandMenuProps {
  query: string;
  onSelect: (cmd: NoteSlashCommand) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ query, onSelect, onClose }: SlashCommandMenuProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Filter commands by query (text after "/")
  const filtered = NOTE_SLASH_COMMANDS.filter(cmd =>
    cmd.name.toLowerCase().startsWith(query.toLowerCase()),
  );

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Keyboard handler — capture phase so we intercept before Tiptap
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Don't intercept navigation keys when no results
      if (filtered.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => {
          if (filtered[i]) onSelect(filtered[i]);
          return i;
        });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, onSelect, onClose]);

  if (filtered.length === 0) {
    return (
      <div className="notes-slash-panel">
        <div className="notes-slash-empty">No matching commands</div>
      </div>
    );
  }

  return (
    <div className="notes-slash-panel">
      {filtered.map((cmd, i) => (
        <div
          key={cmd.name}
          className={`notes-slash-item ${i === selectedIdx ? 'notes-slash-item-active' : ''}`}
          onMouseEnter={() => setSelectedIdx(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
        >
          <span className="notes-slash-item-icon">{cmd.icon}</span>
          <div className="notes-slash-item-text">
            <span className="notes-slash-item-name">/{cmd.name}</span>
            <span className="notes-slash-item-desc">{cmd.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
