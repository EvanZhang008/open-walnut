/**
 * TodoSearchBar — search input for the TODO panel.
 * Renders between category tabs and filter toolbar.
 */

import { useRef, useEffect, useCallback, useState, startTransition } from 'react';
import { ICON_SEARCH } from '@/components/common/Icons';

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
  // Keep keystrokes urgent while the parent list update runs as interruptible work.
  const [draftQuery, setDraftQuery] = useState(query);

  const updateQuery = useCallback((nextQuery: string) => {
    setDraftQuery(nextQuery);
    startTransition(() => onQueryChange(nextQuery));
  }, [onQueryChange]);

  const clear = useCallback(() => {
    setDraftQuery('');
    startTransition(onClear);
  }, [onClear]);

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
      clear();
      inputRef.current?.blur();
    }
  }, [clear]);

  return (
    <div className="todo-search-bar">
      <span className="todo-search-icon">{ICON_SEARCH}</span>
      <input
        ref={inputRef}
        type="text"
        className="todo-search-input"
        placeholder="Search tasks...  &#x2318;K"
        value={draftQuery}
        onChange={(e) => updateQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {isSearching && <span className="todo-search-spinner" />}
      {draftQuery && resultCount != null && (
        <span className="todo-search-count" title={isSearching ? 'Quick results — refining…' : undefined}>{resultCount}</span>
      )}
      {draftQuery && (
        <button
          className="todo-search-clear"
          onClick={clear}
          title="Clear search (Esc)"
        >
          &#x2715;
        </button>
      )}
    </div>
  );
}
