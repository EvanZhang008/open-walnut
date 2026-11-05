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
  /** Matches may still come (a search beyond the view is out): "…", not "No results". */
  searching?: boolean;
  /** Part of the search failed: none in what was searched is not "No results". */
  incomplete?: boolean;
}

/** The bar's outline icons, drawn like the app's other toolbar icons. */
function BarIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

export function FileSearchBar({
  query, caseSensitive, count, index, onQueryChange, onToggleCase, onNav, onClose,
  placeholder = 'Find in file', capped = false, searching = false, incomplete = false,
}: FileSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount — the bar only mounts when the user asked to search.
  useEffect(() => { inputRef.current?.select(); }, []);

  return (
    <div
      className="fv-search-bar"
      role="search"
      // A click on Aa or an arrow leaves the keys in the field (VS Code): WebKit
      // gives a clicked button no focus, so focus fell to the page body and
      // Escape or Enter after an arrow reached nothing.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element && e.target.closest('button'))) return;
        e.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
      }}
      // Escape from Aa or an arrow closes it too, not only from the field.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <input
        ref={inputRef}
        className="fv-search-input"
        data-no-draft="search"
        // Nothing found (and nothing still coming): the field says so in colour.
        data-empty={query && count === 0 && !searching && !incomplete ? 'true' : undefined}
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
        aria-label="Match case"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <span className="fv-search-count" aria-live="polite">
        {/* index 0 with matches = none chosen yet (the page find never picks one on its own). */}
        {query ? (count > 0
          ? (index ? `${index}/${count}${capped ? '+' : ''}` : `${count}${capped ? '+' : ''} ${count === 1 && !capped ? 'match' : 'matches'}`)
          : searching ? 'Searching\u2026' : incomplete ? 'None on screen' : 'No results') : ''}
      </span>
      <button type="button" className="fv-search-nav" onClick={() => onNav(-1)} disabled={!count} title="Previous match (⇧Enter)" aria-label="Previous match"><BarIcon d="M4 10l4-4 4 4" /></button>
      <button type="button" className="fv-search-nav" onClick={() => onNav(1)} disabled={!count} title="Next match (Enter)" aria-label="Next match"><BarIcon d="M4 6l4 4 4-4" /></button>
      <button type="button" className="fv-search-close" onClick={onClose} title="Close (Esc)" aria-label="Close search"><BarIcon d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></button>
    </div>
  );
}
