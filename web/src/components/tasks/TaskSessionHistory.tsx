/**
 * One session per task (2026-10-21): a task shows its ONE session, and the
 * sessions it held before that rule as a collapsed "Earlier sessions (N)" list
 * (`legacy_session_ids`, history only: those sessions no longer link to it).
 * Shared by the details popup (TaskDetailPane) and the /tasks/:id page.
 */
import { useEffect, useState } from 'react';
import type { SessionRecord, Task } from '@open-walnut/core';
import { fetchSession } from '@/api/sessions';
import { resolveTaskSessionId } from '@/utils/session-status';
import { SessionRow } from './TaskDetailRows';
import '@/styles/transfer.css';

type SessionFields = Pick<Task, 'session_id' | 'session_ids' | 'plan_session_id' | 'exec_session_id' | 'legacy_session_ids'>;

/**
 * The task's one session and the rest, newest last. `linked` are the ids the
 * server returned for the task (one, after the split); any id the task still
 * names besides its own session counts as earlier, so nothing is hidden while
 * an old row waits for its split.
 */
export function taskSessionLayout(task: SessionFields, linked: Iterable<string> = []): { primary: string | null; earlier: string[] } {
  const linkedIds = [...linked];
  const primary = resolveTaskSessionId(task as Task) ?? linkedIds[0] ?? null;
  const earlier = new Set<string>();
  for (const sid of [
    ...(task.legacy_session_ids ?? []),
    ...(task.session_ids ?? []),
    task.plan_session_id, task.exec_session_id,
    ...linkedIds,
  ]) {
    if (sid && sid !== primary) earlier.add(sid);
  }
  return { primary, earlier: [...earlier] };
}

/** "Earlier sessions (N)": collapsed; the records load when it opens. Each row opens its session. */
export function EarlierSessions({ ids, onOpen }: { ids: string[]; onOpen: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<Map<string, SessionRecord | null>>(new Map());
  const key = ids.join(',');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    for (const sid of ids) {
      if (records.has(sid)) continue;
      fetchSession(sid)
        .then((rec) => { if (!cancelled) setRecords((m) => new Map(m).set(sid, rec)); })
        .catch(() => { /* the row keeps its placeholder; reopening tries again */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  if (ids.length === 0) return null;
  return (
    <div className="tsh" data-testid="earlier-sessions">
      <button type="button" className="tsh-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tsh-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>
        Earlier sessions ({ids.length})
      </button>
      {open && (
        <div className="tsh-list">
          {ids.map((sid) => {
            const rec = records.get(sid);
            // A record that is gone (null) still gets a row that says so, and still opens.
            const shown = rec === null ? ({ claudeSessionId: sid, taskId: '', title: 'Session not found' } as unknown as SessionRecord) : rec;
            return (
              <SessionRow
                key={sid}
                sessionId={sid}
                record={shown}
                processStatus={rec?.process_status ?? 'stopped'}
                isPlan={rec?.mode === 'plan'}
                onOpen={onOpen}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
