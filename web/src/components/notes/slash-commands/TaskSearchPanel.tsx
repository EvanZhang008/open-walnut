/**
 * Task search panel for the slash command system.
 * Fuzzy-searches all tasks client-side (title + category + project).
 * Currently focused task in TodoPanel appears first in the results.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { Task } from '@open-walnut/core';

const MAX_RESULTS = 15;

interface TaskSearchPanelProps {
  tasks: Task[];
  focusedTaskId?: string;
  onSelect: (task: Task) => void;
  onBack: () => void;
}

export function TaskSearchPanel({ tasks, focusedTaskId, onSelect, onBack }: TaskSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  // Fuzzy filter + sort with focused task pinned at top
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    let pool = tasks;
    if (q) {
      pool = tasks.filter(t => {
        const haystack = `${t.title} ${t.category} ${t.project ?? ''}`.toLowerCase();
        return haystack.includes(q);
      });
    }

    // Sort: non-completed first, then title starts-with, then alphabetical
    pool = [...pool].sort((a, b) => {
      const aDone = a.status === 'done' ? 1 : 0;
      const bDone = b.status === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;

      if (q) {
        const aStarts = a.title.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.title.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
      }

      return a.title.localeCompare(b.title);
    });

    // Pin focused task at top (if it exists and matches query)
    if (focusedTaskId) {
      const focusedIdx = pool.findIndex(t => t.id === focusedTaskId);
      if (focusedIdx > 0) {
        const [focused] = pool.splice(focusedIdx, 1);
        pool.unshift(focused);
      }
    }

    return pool.slice(0, MAX_RESULTS);
  }, [tasks, query, focusedTaskId]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIdx]) onSelect(results[selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  }, [results, selectedIdx, onSelect, onBack]);

  return (
    <div className="notes-slash-panel notes-task-search" onKeyDown={handleKeyDown}>
      <div className="notes-task-search-header">
        <button
          className="notes-task-search-back"
          onMouseDown={(e) => { e.preventDefault(); onBack(); }}
          title="Back to commands"
        >
          &larr;
        </button>
        <input
          ref={inputRef}
          className="notes-task-search-input"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search tasks..."
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="notes-task-search-list" ref={listRef}>
        {results.length === 0 ? (
          <div className="notes-slash-empty">No tasks found</div>
        ) : (
          results.map((task, i) => {
            const phase = task.status === 'done' ? 'Done'
              : (task.phase && task.phase !== 'TODO') ? task.phase.replace(/_/g, ' ')
              : '';
            return (
              <div
                key={task.id}
                className={`notes-task-search-item ${i === selectedIdx ? 'notes-slash-item-active' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); onSelect(task); }}
              >
                <div className="notes-task-search-title">
                  {task.id === focusedTaskId && <span className="notes-task-search-pin" title="Currently selected task">&#x2605;</span>}
                  {task.title}
                </div>
                <div className="notes-task-search-meta">
                  <span className="notes-task-search-project">
                    {task.project && task.project !== task.category
                      ? `${task.category} / ${task.project}`
                      : task.category}
                  </span>
                  {phase && (
                    <span className={`notes-task-search-phase ${task.status === 'done' ? 'done' : ''}`}>
                      {phase}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
