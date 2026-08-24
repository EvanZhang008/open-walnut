/**
 * Collapsible "Bookmarks" group rendered at the TOP of the notes tree (§2.6,
 * matches Obsidian's left-sidebar Bookmarks). Hidden when there are no favorited
 * notes. Each row opens the note via `onSelect` (funnels through NotesPage's
 * openInTab → active tab, or a new tab on ⌘/Ctrl-click) with a hover-× to
 * un-bookmark. Expand/collapse persists to localStorage.
 */

import { useState, useEffect } from 'react';
import { ICON_CLOSE } from '@/components/common/Icons';

const LS_BOOKMARKS_KEY = 'open-walnut-notes-bookmarks-expanded';

/** Vault-relative path → display basename without the .md extension. */
function basenameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.md$/, '');
}

interface NotesBookmarksGroupProps {
  /** Vault-relative paths (WITH .md) of bookmarked notes. */
  favoriteNotes: string[];
  /** Active path (highlights the matching row). */
  selectedPath: string | null;
  /** Open a note; `opts.newTab` (⌘/Ctrl-click) opens it in a new tab. */
  onSelect: (path: string, opts?: { newTab?: boolean }) => void;
  /** Un-bookmark a note (the inline × affordance). */
  onToggleFavorite: (path: string) => void;
  /**
   * Right-click a row → the tree's own context menu (Open in new tab, Rename,
   * Reveal in Finder, Copy path, Delete…). Without it the browser's native menu
   * takes the row, which in the Mac app means Look Up / Translate / Services.
   */
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
}

export function NotesBookmarksGroup({ favoriteNotes, selectedPath, onSelect, onToggleFavorite, onContextMenu }: NotesBookmarksGroupProps) {
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_BOOKMARKS_KEY) !== 'collapsed'; } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem(LS_BOOKMARKS_KEY, expanded ? 'expanded' : 'collapsed'); } catch { /* ignore */ }
  }, [expanded]);

  if (favoriteNotes.length === 0) return null;

  return (
    <div className="notes-bookmarks-group">
      <div className="notes-tree-item notes-bookmarks-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`notes-tree-arrow ${expanded ? 'expanded' : ''}`}>
          <ChevronIcon />
        </span>
        <BookmarkGlyph />
        <span className="notes-tree-name">Bookmarks</span>
        <span className="notes-bookmarks-count">{favoriteNotes.length}</span>
      </div>
      {expanded && (
        <div className="notes-bookmarks-list">
          {favoriteNotes.map((path) => (
            <div
              key={path}
              className={`notes-tree-item notes-tree-file notes-bookmark-row ${selectedPath === path ? 'selected' : ''}`}
              title={path}
              onClick={(e) => onSelect(path, { newTab: e.metaKey || e.ctrlKey })}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, path) : undefined}
            >
              <BookmarkGlyph />
              <span className="notes-tree-name">{basenameNoExt(path)}</span>
              <button
                className="notes-bookmark-remove"
                aria-label={`Remove bookmark ${basenameNoExt(path)}`}
                title="Remove bookmark"
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(path); }}
              >
                {ICON_CLOSE}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/** Filled bookmark glyph for the group header + rows. */
function BookmarkGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="notes-tree-icon">
      <path d="M3.5 2.5h9a1 1 0 0 1 1 1v10l-5.5-3-5.5 3v-10a1 1 0 0 1 1-1z" />
    </svg>
  );
}
