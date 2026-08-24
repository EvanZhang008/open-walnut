/**
 * Collapsible "Recent" group rendered directly UNDER the Bookmarks group in the
 * notes tree (Feature 4). Mirrors NotesBookmarksGroup's visual pattern.
 *
 * Source of truth: the SAME recents list the Cmd+K palette maintains
 * (`readRecents()` / `pushRecent()` in CommandPalette.tsx, localStorage key
 * `open-walnut-notes-recents`). We do NOT add a second store — NotesPage already
 * calls pushRecent(path) on every open, so this group just reads it.
 *
 * Collapse state reuses the tree's expanded-folders store via a sentinel key
 * (`__recent__`) so it persists alongside folder expansion (owned by the parent).
 * Entries whose file is not in the current tree are skipped (stale paths kept in
 * storage but not rendered).
 */

import { readRecents } from './CommandPalette';

/** Sentinel "path" used in the expanded-folders set to track this group's collapse state. */
export const RECENT_GROUP_KEY = '__recent__';
/** Cap rendered rows (recents store itself holds up to 8; we show up to 10). */
const MAX_SHOWN = 10;

/** Vault-relative path → display basename without the .md extension. */
function basenameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.md$/, '');
}

interface NotesRecentGroupProps {
  /** Set of note paths that exist in the current tree (used to skip stale recents). */
  existingPaths: Set<string>;
  /** Active path (highlights the matching row). */
  selectedPath: string | null;
  /** Open a note; `opts.newTab` (⌘/Ctrl-click) opens it in a new tab. */
  onSelect: (path: string, opts?: { newTab?: boolean }) => void;
  /** Whether the group is expanded (parent owns the persisted expanded-folders set). */
  expanded: boolean;
  /** Toggle the group's collapse state (flips RECENT_GROUP_KEY in the parent's set). */
  onToggle: () => void;
  /**
   * Right-click a row → the tree's own context menu. Without it the row falls
   * through to the browser's native menu (Look Up / Translate in the Mac app).
   */
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
}

export function NotesRecentGroup({ existingPaths, selectedPath, onSelect, expanded, onToggle, onContextMenu }: NotesRecentGroupProps) {
  // Only render recents that still resolve to a file in the current tree.
  const recents = readRecents().filter((p) => existingPaths.has(p)).slice(0, MAX_SHOWN);
  if (recents.length === 0) return null;

  return (
    <div className="notes-bookmarks-group notes-recent-group">
      <div className="notes-tree-item notes-bookmarks-header" onClick={onToggle}>
        <span className={`notes-tree-arrow ${expanded ? 'expanded' : ''}`}>
          <ChevronIcon />
        </span>
        <ClockGlyph />
        <span className="notes-tree-name">Recent</span>
        <span className="notes-bookmarks-count">{recents.length}</span>
      </div>
      {expanded && (
        <div className="notes-bookmarks-list">
          {recents.map((path) => (
            <div
              key={path}
              className={`notes-tree-item notes-tree-file notes-bookmark-row ${selectedPath === path ? 'selected' : ''}`}
              title={path}
              onClick={(e) => onSelect(path, { newTab: e.metaKey || e.ctrlKey })}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, path) : undefined}
            >
              <ClockGlyph />
              <span className="notes-tree-name">{basenameNoExt(path)}</span>
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

/** Clock glyph for the Recent group header + rows. */
function ClockGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="notes-tree-icon">
      <circle cx="8" cy="8" r="6" />
      <polyline points="8 4.5 8 8 10.5 9.5" />
    </svg>
  );
}
