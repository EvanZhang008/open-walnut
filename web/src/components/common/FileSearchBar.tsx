/**
 * FileSearchBar — the in-file search chrome row (⌘F) shared by every file
 * render mode. Pure presentation: the owner (FileContentView) computes matches
 * against whichever surface is live (CodeMirror, markdown preview, WYSIWYG,
 * HTML iframe, read-only <pre>) and feeds {count, index} back down.
 */
import { useEffect, useRef } from 'react';

interface FileSearchBarProps {
  query: string;
  caseSensitive: boolean;
  count: number;
  /** 1-based index of the active match; 0 when there are none. */
  index: number;
  onQueryChange: (q: string) => void;
  onToggleCase: () => void;
  onNav: (dir: 1 | -1) => void;
  onClose: () => void;
  placeholder?: string;
  /** More matches exist than were counted. */
  capped?: boolean;
}

export function FileSearchBar({
  query, caseSensitive, count, index, onQueryChange, onToggleCase, onNav, onClose,
  placeholder = 'Find in file', capped = false,
}: FileSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount — the bar only mounts when the user asked to search.
  useEffect(() => { inputRef.current?.select(); }, []);

  return (
    <div className="fv-search-bar" role="search">
      <input
        ref={inputRef}
        className="fv-search-input"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // An IME's Enter confirms a candidate, it is not "next match" (WebKit
          // reports isComposing false on that keydown; keyCode 229 still says so).
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); onNav(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
      />
      <button
        type="button"
        className={`fv-search-case${caseSensitive ? ' active' : ''}`}
        onClick={onToggleCase}
        title="Match case"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <span className="fv-search-count" aria-live="polite">
        {/* index 0 with matches = none chosen yet (the page find never picks one on its own). */}
        {query ? (count > 0 ? `${index || '?'}/${count}${capped ? '+' : ''}` : 'No results') : ''}
      </span>
      <button type="button" className="fv-search-nav" onClick={() => onNav(-1)} disabled={!count} title="Previous match (⇧Enter)" aria-label="Previous match">↑</button>
      <button type="button" className="fv-search-nav" onClick={() => onNav(1)} disabled={!count} title="Next match (Enter)" aria-label="Next match">↓</button>
      <button type="button" className="fv-search-close" onClick={onClose} title="Close (Esc)" aria-label="Close search">✕</button>
    </div>
  );
}
