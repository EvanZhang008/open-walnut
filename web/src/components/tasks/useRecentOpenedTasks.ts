/**
 * The Recent tab's rows: the tasks the person opened lately (utils/recent-opened.ts), newest
 * open first, as Task rows. A task the board list does not carry (finished over a week ago, one
 * opened from search) is read by id, so an old task opened a minute ago is still there to find;
 * one the server no longer has is left out. A row opened from the list itself keeps its place
 * while the tab stays on screen (`hold`, recentRowOrder).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { fetchTasksByIds } from '@/api/tasks';
import { useEvent } from '@/hooks/useWebSocket';
import { deletedTaskId } from '../../../../src/core/task-deleted-id';
import { recentRowOrder, useRecentOpened, type HeldRow, type RecentOpen } from '@/utils/recent-opened';

export interface RecentOpenedRows {
  /** Newest open first (a row opened from the list in its old place). */
  tasks: Task[];
  /** When each was opened (ISO), for the row's "5m ago". */
  openedAt: ReadonlyMap<string, string>;
  /** The rows read by id, outside the board list: a click opens them by id. */
  outside: ReadonlySet<string>;
  /** Call before opening a row from the list: it stays where it is until the tab is left. */
  hold: (taskId: string) => void;
}

const RETRY_MS = 30_000;

/** `active`: the tab is on screen; only then are unlisted tasks read. */
export function useRecentOpenedTasks(listed: readonly Task[], listLoading: boolean, active: boolean): RecentOpenedRows {
  const opens = useRecentOpened();
  const byId = useMemo(() => new Map(listed.map((t) => [t.id, t])), [listed]);
  const [read, setRead] = useState<ReadonlyMap<string, Task | null>>(() => new Map());
  const [retry, setRetry] = useState(0);

  // Ids neither listed nor read yet. Not while the list loads: then every id is missing.
  const missing = useMemo(
    () => (listLoading || !active ? [] : opens.map((o) => o.id).filter((id) => !byId.has(id) && !read.has(id))),
    [opens, byId, read, listLoading, active],
  );
  const missingKey = missing.join(',');
  useEffect(() => {
    if (!missingKey) return;
    const ids = missingKey.split(',');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetchTasksByIds(ids).then((rows) => {
      if (cancelled) return;
      const got = new Map(rows.map((t) => [t.id, t]));
      setRead((prev) => {
        const next = new Map(prev);
        // An id the answer leaves out is gone (deleted): remembered as null, never asked again.
        for (const id of ids) next.set(id, got.get(id) ?? null);
        return next;
      });
    }).catch(() => {
      // Offline: ask again in a while.
      if (!cancelled) timer = setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [missingKey, retry]);

  // A deleted task leaves the list: the board list drops it, and its read copy is forgotten so
  // the row never falls back to it.
  useEvent('task:deleted', (data) => {
    const id = deletedTaskId(data);
    if (id) setRead((prev) => (prev.get(id) === null ? prev : new Map(prev).set(id, null)));
  });

  // Rows opened from the list this visit (recentRowOrder lets one go when it is opened elsewhere).
  const heldRef = useRef(new Map<string, HeldRow>());
  if (!active && heldRef.current.size > 0) heldRef.current = new Map();
  const opensRef = useRef(opens);
  opensRef.current = opens;
  const hold = useCallback((taskId: string) => {
    // Held already (opened from the list before): it keeps its first place, for this click too.
    const h = heldRef.current.get(taskId);
    if (h) { h.clickedAt = Date.now(); return; }
    const at = opensRef.current.find((o) => o.id === taskId)?.at;
    if (at) heldRef.current.set(taskId, { before: at, clickedAt: Date.now() });
  }, []);

  return useMemo(() => {
    const rows = new Map<string, Task>();
    const openedAt = new Map<string, string>();
    const outside = new Set<string>();
    const shown: RecentOpen[] = [];
    for (const o of opens) {
      const listedTask = byId.get(o.id);
      const task = listedTask ?? read.get(o.id) ?? null;
      if (!task) continue;
      rows.set(task.id, task);
      openedAt.set(task.id, o.at);
      shown.push(o);
      if (!listedTask) outside.add(task.id);
    }
    const tasks = recentRowOrder(shown, heldRef.current).map((id) => rows.get(id)!);
    return { tasks, openedAt, outside, hold };
    // `active`: leaving the tab lets the held rows go.
  }, [opens, byId, read, hold, active]);
}
