/**
 * The quick bar's Tasks and Notes modes (quickbar-modes.ts): what matches the words, as a list the
 * arrow keys walk and Enter opens (the bar's own keys reach it through the handle). Each row opens
 * an app path: a task's chat, a note in the Notes page.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { searchQuickNotes, searchQuickTasks } from '@/api/quick';
import { log } from '@/utils/log';
import { taskPath } from '@/utils/task-path';

export interface QuickResult { key: string; title: string; sub: string; to: string }

export interface QuickBarResultsHandle {
  /** Move the selection by `delta` rows (wraps). */
  move(delta: number): void;
  /** The selected row, for Enter. */
  chosen(): QuickResult | null;
}

/** How long typing settles before the search runs. */
const SETTLE_MS = 140;

export const QuickBarResults = forwardRef<QuickBarResultsHandle, {
  mode: 'tasks' | 'notes';
  query: string;
  onOpen: (result: QuickResult) => void;
}>(function QuickBarResults({ mode, query, onOpen }, ref) {
  const [rows, setRows] = useState<QuickResult[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'failed'>('idle');
  const [cursor, setCursor] = useState(0);
  // The words the rows were found for: Enter before the newest search answered opens nothing.
  const [rowsFor, setRowsFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setState('searching');
      const run = mode === 'tasks'
        ? searchQuickTasks(query, ctl.signal).then(({ tasks }) => tasks.map((task): QuickResult => ({
          key: task.id, title: task.title, sub: [task.project, task.stateLabel].filter(Boolean).join(' · '), to: taskPath(task.id),
        })))
        : searchQuickNotes(query, ctl.signal).then((notes) => notes.map((note): QuickResult => ({
          key: note.path, title: note.name, sub: note.meta,
          // Quotes too (encodeURIComponent keeps ' and the Mac app's links refuse it).
          to: `/notes?path=${encodeURIComponent(note.path).replace(/'/g, '%27')}`,
        })));
      run.then((next) => { setRows(next); setRowsFor(query); setCursor(0); setState('idle'); }).catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        log.warn('quickbar', 'search failed', { mode, error: err instanceof Error ? err.message : String(err) });
        setState('failed');
      });
    }, SETTLE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [mode, query]);

  useImperativeHandle(ref, () => ({
    move: (delta) => setCursor((c) => (rows.length ? (c + delta + rows.length) % rows.length : 0)),
    chosen: () => (rowsFor === query ? rows[cursor] ?? null : null),
  }), [rows, cursor, rowsFor, query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const empty = state === 'failed'
    ? 'Search did not answer. Type again to retry.'
    : state === 'searching' && rows.length === 0 ? 'Searching…'
      : mode === 'notes' && !query.trim() ? 'Type words from a note’s title or text.'
        : rows.length === 0 ? `No ${mode} match.` : null;

  return (
    <div className="qb-results" ref={listRef} role="listbox" aria-label={mode === 'tasks' ? 'Tasks' : 'Notes'} data-testid={`qb-results-${mode}`}>
      {empty && <div className="qb-results-empty">{empty}</div>}
      {rows.map((row, i) => (
        <button
          type="button"
          key={row.key}
          data-row={i}
          role="option"
          data-peek-row=""
          aria-selected={i === cursor}
          className={`qb-result${i === cursor ? ' qb-result-on' : ''}`}
          onMouseMove={() => setCursor(i)}
          onClick={() => onOpen(row)}
        >
          <span className={`qb-result-icon qb-result-icon-${mode}`} aria-hidden="true">{mode === 'tasks' ? <TaskGlyph /> : <NoteGlyph />}</span>
          <span className="qb-result-body">
            <span className="qb-result-title">{row.title}</span>
            {row.sub && <span className="qb-result-sub">{row.sub}</span>}
          </span>
          {i === cursor && <kbd className="qb-key">↵</kbd>}
        </button>
      ))}
    </div>
  );
});

function TaskGlyph() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>;
}

function NoteGlyph() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>;
}
