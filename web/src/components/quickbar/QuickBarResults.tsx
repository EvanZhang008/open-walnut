/**
 * The quick bar's Tasks and Notes modes (quickbar-modes.ts): what matches the words, as a list the
 * arrow keys walk and Enter opens (the bar's own keys reach it through the handle). Each row opens
 * an app path: a task's chat, a note in the Notes page.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { searchQuickNotes, searchQuickTasks } from '@/api/quick';
import { NoteGlyph, TaskGlyph } from './quickbar-glyphs';
import { log } from '@/utils/log';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
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

  const words = query.trim();
  const empty = state === 'failed'
    ? <UnavailableState size="row" role="presentation" testId="qb-results-empty" title="Search did not answer" hint="Type again to retry." />
    : state === 'searching' && rows.length === 0 ? <LoadingState size="row" role="presentation" testId="qb-results-empty" title={`Searching ${mode}…`} />
      : mode === 'notes' && !words ? <EmptyState size="row" role="presentation" testId="qb-results-empty" title="Search your notes" hint="Type words from a note’s title or text." />
        : rows.length === 0 ? <EmptyState size="row" role="presentation" testId="qb-results-empty" title={words ? `No ${mode} match \u2018${words}\u2019` : `No ${mode} to show`} /> : null;

  return (
    <div className="qb-results" ref={listRef} role="listbox" aria-label={mode === 'tasks' ? 'Tasks' : 'Notes'} data-testid={`qb-results-${mode}`}>
      {empty}
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
            <span className="qb-result-title wn-title">{row.title}</span>
            {row.sub && <span className="qb-result-sub">{row.sub}</span>}
          </span>
          {i === cursor && <kbd className="qb-key wn-key">↵</kbd>}
        </button>
      ))}
    </div>
  );
});
