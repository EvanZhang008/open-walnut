/**
 * TodoSearchBar — search input for the TODO panel.
 * Renders between the project tabs and the filter toolbar.
 */

import { useRef, useEffect, useCallback, useState, startTransition } from 'react';
import { ICON_SEARCH } from '@/components/common/Icons';
import { log } from '@/utils/log';

/** A blur this soon after a keystroke, with no user gesture, was not the user's. */
const TYPING_GUARD_MS = 2000;

function describeElement(el: Element | null): string | null {
  if (!el) return null;
  const classes = [...el.classList].slice(0, 3).join('.');
  const column = el.closest('[data-session-id], [data-draft-id]');
  const owner = column?.getAttribute('data-session-id') ?? column?.getAttribute('data-draft-id');
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes ? `.${classes}` : ''}${owner ? ` in ${owner}` : ''}`;
}

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
  const reveal = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  // Keep keystrokes urgent while the parent list update runs as interruptible work.
  const [draftQuery, setDraftQuery] = useState(query);
  // Typing guard (2026-09-23, "I lost the cursor soon after typing"): while the
  // user is typing here, focus taken by code elsewhere (a column mounting, an
  // autofocus) comes back. A pointer press, Tab, Escape or a modifier shortcut is
  // the user moving on, and is never undone. Each restore logs where the focus
  // went, so the thief can be named from the log and fixed at its source.
  const lastTypedAtRef = useRef(0);
  const userMovedFocusRef = useRef(false);
  // One restore per keystroke: a component that keeps grabbing focus must not
  // turn this into a per-frame tug of war (or a log line per frame).
  const restoredAtRef = useRef(-1);
  useEffect(() => {
    const onPointerDown = () => { userMovedFocusRef.current = true; };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    lastTypedAtRef.current = performance.now();
    userMovedFocusRef.current = false;
    setDraftQuery(nextQuery);
    startTransition(() => onQueryChange(nextQuery));
  }, [onQueryChange]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const sinceTypedMs = Math.round(performance.now() - lastTypedAtRef.current);
    const typedAt = lastTypedAtRef.current;
    const stolen = !userMovedFocusRef.current && sinceTypedMs < TYPING_GUARD_MS && !document.hidden
      && restoredAtRef.current !== typedAt;
    if (!stolen) return;
    const to = describeElement(e.relatedTarget as Element | null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      const active = document.activeElement;
      // Not steals: the window losing focus (another app), and a click into an
      // iframe (its pointerdown never reaches this document).
      if (!el || !document.hasFocus() || active === el || active?.tagName === 'IFRAME' || userMovedFocusRef.current) return;
      const taker = describeElement(active);
      restoredAtRef.current = typedAt;
      el.focus({ preventScroll: true });
      log.info('todo-search', 'search input focus taken while typing; restored', { to, taker, sinceTypedMs });
    });
  }, []);

  const clear = useCallback(() => {
    setDraftQuery('');
    startTransition(onClear);
  }, [onClear]);

  // Keyboard shortcut: Cmd+K or / to focus
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const main = inputRef.current?.closest('.main-page');
      if (!main?.getClientRects().length) return;
      const ensureVisible = () => {
        if (inputRef.current?.closest('[inert]')) window.dispatchEvent(new CustomEvent('sidebar:toggle-todo'));
        reveal();
      };
      // Cmd+K (Mac) or Ctrl+K (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        ensureVisible();
        return;
      }
      // / key when no editable element is focused
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && !(document.activeElement as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        ensureVisible();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [reveal]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab' || e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) userMovedFocusRef.current = true;
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
        onBlur={handleBlur}
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
