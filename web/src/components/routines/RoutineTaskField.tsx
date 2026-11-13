/**
 * The task a session routine runs in, picked by its title (2026-11-04, a review: the
 * error says "Point it at an open task with Edit", and Edit offered only a raw task id
 * field). Shows the chosen task by title and project, says when it is complete, and
 * finds open tasks by title once the person asks to change it (the list stays closed
 * until then, so the rest of the form is not pushed down). The id is still what is saved.
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';

interface TaskHit {
  id: string;
  title: string;
  project?: string;
  phase?: string;
}

const SEARCH_DELAY_MS = 250;
const LIMIT = '8';

async function findTasks(params: Record<string, string>, signal: AbortSignal): Promise<TaskHit[]> {
  const res = await apiGet<{ tasks?: TaskHit[] }>('/api/tasks', { fields: 'list', limit: LIMIT, ...params }, { signal, quietStatuses: [404] });
  return (res.tasks ?? []).map((t) => ({ id: t.id, title: t.title, project: t.project, phase: t.phase }));
}

export function RoutineTaskField({ id, value, onChange }: { id: string; value: string; onChange: (taskId: string) => void }) {
  const [current, setCurrent] = useState<TaskHit | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TaskHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Open from the start only when there is no task yet, or the current one is gone.
  const [choosing, setChoosing] = useState(false);
  const picked = useRef<Map<string, TaskHit>>(new Map());

  // The chosen task, by its id (a pick from the list is already known).
  useEffect(() => {
    const taskId = value.trim();
    if (!taskId) { setCurrent(null); return; }
    const known = picked.current.get(taskId);
    if (known) { setCurrent(known); return; }
    const ctrl = new AbortController();
    setCurrent(undefined);
    findTasks({ ids: taskId }, ctrl.signal)
      .then((found) => setCurrent(found[0] ?? null))
      .catch(() => { if (!ctrl.signal.aborted) setCurrent(null); });
    return () => ctrl.abort();
  }, [value]);

  // Open tasks whose title holds what was typed; the latest edited ones while empty.
  const listing = choosing || !value.trim() || current === null;
  useEffect(() => {
    if (!listing) return;
    const ctrl = new AbortController();
    const q = query.trim();
    setSearching(true);
    const t = setTimeout(() => {
      findTasks({ completion: 'todo,in_progress', sort: 'updated_desc', ...(q ? { q } : {}) }, ctrl.signal)
        .then((found) => { setHits(found); setSearching(false); })
        .catch(() => { if (!ctrl.signal.aborted) { setHits([]); setSearching(false); } });
    }, q ? SEARCH_DELAY_MS : 0);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, listing]);

  const complete = current?.phase === 'COMPLETE';
  const choices = (hits ?? []).filter((h) => h.id !== value.trim());

  return (
    <div className="routine-task-field">
      <div className={`routine-task-current${complete ? ' complete' : ''}`} data-testid="routine-task-current">
        {current === undefined && value.trim() ? (
          <span className="text-muted">Looking up the task…</span>
        ) : current ? (
          <>
            <span className="routine-task-current-title">{current.title}</span>
            <span className="routine-task-current-meta">
              {current.project || 'Inbox'}
              {complete && <span className="routine-task-complete"> · complete: pick an open task with Change task</span>}
            </span>
          </>
        ) : value.trim() ? (
          <span className="routine-task-complete">No task has the id {value.trim()}: pick one below</span>
        ) : (
          <span className="text-muted">No task chosen yet</span>
        )}
      </div>
      {!listing && (
        <button type="button" id={`${id}-change`} className="btn btn-sm routine-task-change" onClick={() => setChoosing(true)}>
          Change task
        </button>
      )}
      {listing && (<>
      <input
        id={id}
        autoFocus={choosing}
        type="search"
        className="routine-task-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find an open task by its title"
        aria-label="Find an open task by its title"
        autoComplete="off"
      />
      <ul className="routine-task-hits" aria-label="Open tasks" data-testid="routine-task-hits">
        {choices.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              className="routine-task-hit"
              onClick={() => { picked.current.set(h.id, h); onChange(h.id); setQuery(''); setChoosing(false); }}
            >
              <span className="routine-task-hit-title">{h.title}</span>
              <span className="routine-task-hit-project">{h.project || 'Inbox'}</span>
            </button>
          </li>
        ))}
        {hits && choices.length === 0 && !searching && (
          <li className="routine-task-none text-muted">{query.trim() ? 'No open task has that in its title.' : 'No open tasks.'}</li>
        )}
      </ul>
      </>)}
    </div>
  );
}
