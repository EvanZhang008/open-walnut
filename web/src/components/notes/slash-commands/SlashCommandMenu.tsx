/**
 * Floating command list — Notion-style grouped insert-block menu.
 * Fuzzy-filters over name + aliases, renders group headers, keeps the active
 * row scrolled into view, and supports keyboard nav (ArrowUp/Down, Enter,
 * Escape). When the "/" is mid-sentence (not at block start) only inline
 * Reference commands are offered (§3.3 trigger split).
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { NoteSlashCommand, SlashCommandGroup } from './types';
import { NOTE_SLASH_COMMANDS, GROUP_LABELS } from './types';
import { EmptyState } from '@/components/common/EmptyState';

interface SlashCommandMenuProps {
  query: string;
  /** When false, only inline 'reference' commands are shown. */
  atBlockStart: boolean;
  onSelect: (cmd: NoteSlashCommand) => void;
  onClose: () => void;
}

/**
 * Subsequence fuzzy match: every char of `q` must appear in order in `text`.
 * Returns a score (lower = better: prefers contiguous + early matches) or null.
 */
function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let lastMatch = -1;
  for (const qc of q) {
    let found = -1;
    for (let i = ti; i < text.length; i++) {
      if (text[i] === qc) { found = i; break; }
    }
    if (found === -1) return null;
    // Penalize gaps between matched chars (favor contiguous runs).
    if (lastMatch >= 0) score += found - lastMatch - 1;
    score += found; // favor earlier matches
    lastMatch = found;
    ti = found + 1;
  }
  return score;
}

/** Best fuzzy score across the command's name + aliases (null if none match). */
function commandScore(q: string, cmd: NoteSlashCommand): number | null {
  const candidates = [cmd.name, ...cmd.aliases];
  let best: number | null = null;
  for (const c of candidates) {
    const s = fuzzyScore(q, c.toLowerCase());
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

export function SlashCommandMenu({ query, atBlockStart, onSelect, onClose }: SlashCommandMenuProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter + sort. Block commands only when at block start; reference always.
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const pool = NOTE_SLASH_COMMANDS.filter(
      cmd => atBlockStart || cmd.commandClass === 'reference',
    );
    if (!q) return pool;
    return pool
      .map(cmd => ({ cmd, score: commandScore(q, cmd) }))
      .filter((r): r is { cmd: NoteSlashCommand; score: number } => r.score !== null)
      .sort((a, b) => a.score - b.score)
      .map(r => r.cmd);
  }, [query, atBlockStart]);

  // Reset selection when filter changes
  useEffect(() => { setSelectedIdx(0); }, [query, atBlockStart]);

  // Keyboard handler — capture phase so we intercept before Tiptap
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
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

  // Keep the active row visible
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector('.notes-slash-item-active') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, filtered]);

  if (filtered.length === 0) {
    return (
      <div className="notes-slash-panel wn-overlay wn-menu">
        <EmptyState size="row" title="No matching commands" />
      </div>
    );
  }

  // Render with group headers (only when not actively typing a query — once the
  // user types, the flat fuzzy-ranked list reads better).
  const showGroups = query.trim().length === 0;
  let lastGroup: SlashCommandGroup | null = null;

  return (
    <div className="notes-slash-panel wn-overlay wn-menu" ref={listRef}>
      {filtered.map((cmd, i) => {
        const header = showGroups && cmd.group !== lastGroup
          ? <div key={`g-${cmd.group}`} className="notes-slash-group">{GROUP_LABELS[cmd.group]}</div>
          : null;
        lastGroup = cmd.group;
        return (
          <div key={cmd.name}>
            {header}
            <div
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
          </div>
        );
      })}
    </div>
  );
}
