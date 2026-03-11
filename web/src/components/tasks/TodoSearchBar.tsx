/**
 * TodoSearchBar — search input for the TODO panel.
 * Renders between category tabs and filter toolbar.
 */

import { useRef, useEffect, useCallback } from 'react';

interface TodoSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  onClear: () => void;
  isSearching: boolean;
  resultCount?: number | null; // null = no server results yet
}

export function TodoSearchBar({
  query,
  onQueryChange,
  onClear,
  isSearching,
  resultCount,
}: TodoSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: Cmd+K or / to focus
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K (Mac) or Ctrl+K (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      // / key when no editable element is focused
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && !(document.activeElement as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClear();
      inputRef.current?.blur();
    }
  }, [onClear]);

  return (
    <div className="todo-search-bar">
      <span className="todo-search-icon">&#x1F50D;</span>
      <input
        ref={inputRef}
        type="text"
        className="todo-search-input"
        placeholder="Search tasks...  &#x2318;K"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {isSearching && <span className="todo-search-spinner" />}
      {query && !isSearching && resultCount != null && (
        <span className="todo-search-count">{resultCount}</span>
      )}
      {query && (
        <button className="todo-search-clear" onClick={onClear} title="Clear search (Esc)">
          &#x2715;
        </button>
      )}
    </div>
  );
}
