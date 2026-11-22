/**
 * Tag autocomplete popup — shows frequency-ranked vault tags when the user
 * types `#`. Inserts an atomic `tag` node (serializes to literal `#slug`).
 * Manual typing works before the backend `GET /tags` lands (empty list → only
 * the "Create" row). Same portal/keyboard shape as WikiLinkAutocomplete.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { TagTriggerState } from './extensions/tag-trigger';
import { normalizeTagName } from './extensions/tag-node';

export interface TagSuggestion { tag: string; count: number }

interface TagAutocompleteProps {
  editor: Editor;
  state: TagTriggerState & { phase: 'searching' };
  /** Frequency-ranked tags from GET /tags (may be empty before B3 lands). */
  tags: TagSuggestion[];
  onClose: () => void;
  /** Receives the normalized slug to insert as a tag node. */
  onSelect: (slug: string) => void;
}

export function TagAutocomplete({ editor, state, tags, onClose, onSelect }: TagAutocompleteProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const query = normalizeTagName(state.query);

  const filtered = useMemo(() => {
    if (!query) return tags.slice(0, 10);
    return tags.filter(t => t.tag.includes(query)).slice(0, 10);
  }, [tags, query]);

  const showCreate = query.length > 0 && !filtered.some(t => t.tag === query);
  const rowCount = filtered.length + (showCreate ? 1 : 0);

  useEffect(() => { setSelectedIdx(0); }, [filtered.length, showCreate]);

  useEffect(() => {
    try {
      const c = editor.view.coordsAtPos(state.range.from);
      const panelH = panelRef.current?.getBoundingClientRect().height || 180;
      const panelW = panelRef.current?.getBoundingClientRect().width || 240;
      const aboveTop = c.top - panelH - 4;
      const belowTop = c.bottom + 4;
      const top = Math.max(4, aboveTop >= 0 ? aboveTop : belowTop);
      const left = Math.max(4, Math.min(c.left, window.innerWidth - panelW - 8));
      setCoords({ left, top });
    } catch {
      setCoords(null);
    }
  }, [editor, state.range.from, filtered.length]);

  const choose = useCallback((idx: number) => {
    if (idx < filtered.length) onSelect(filtered[idx].tag);
    else if (showCreate) onSelect(query);
  }, [filtered, showCreate, query, onSelect]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSelectedIdx(i => Math.min(i + 1, Math.max(0, rowCount - 1))); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); choose(selectedIdx); return; }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [rowCount, selectedIdx, choose, onClose]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  if (!coords || rowCount === 0) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="notes-tag-panel"
      style={{ position: 'fixed', left: coords.left, top: coords.top, zIndex: 10001 }}
    >
      {filtered.map((t, i) => (
        <div
          key={t.tag}
          className={`notes-tag-item ${i === selectedIdx ? 'selected' : ''}`}
          onMouseEnter={() => setSelectedIdx(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(t.tag); }}
        >
          <span className="notes-tag-item-name">#{t.tag}</span>
          {t.count > 0 && <span className="badge badge-count notes-tag-item-count">{t.count}</span>}
        </div>
      ))}
      {showCreate && (
        <div
          className={`notes-tag-item notes-tag-create ${filtered.length === selectedIdx ? 'selected' : ''}`}
          onMouseEnter={() => setSelectedIdx(filtered.length)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(query); }}
        >
          <span className="notes-tag-item-name">Create #{query}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
