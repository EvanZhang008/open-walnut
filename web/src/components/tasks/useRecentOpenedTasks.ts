/**
 * The Recent tab's rows: the tasks the person opened lately (utils/recent-opened.ts), newest
 * open first, as Task rows. A task the board list does not carry (finished over a week ago, one
 * opened from search) is read by id once, so an old task opened a minute ago is still there to
 * find; one the server no longer has is left out. While the tab is on screen its rows hold
 * their places (settledOrder): a new open comes in on top, the rest wait for the next visit.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { fetchTasksByIds } from '@/api/tasks';
import { settledOrder, useRecentOpened } from '@/utils/recent-opened';

export interface RecentOpenedRows {
  /** Newest open first. */
  tasks: Task[];
  /** When each was opened (ISO), for the row's "5m ago". */
  openedAt: ReadonlyMap<string, string>;
  /** The rows read by id, outside the board list: a click opens them by id. */
  outside: ReadonlySet<string>;
}

/** `active`: the tab is on screen; only then are unlisted tasks read. */
export function useRecentOpenedTasks(listed: readonly Task[], listLoading: boolean, active: boolean): RecentOpenedRows {
  const opens = useRecentOpened();
  const byId = useMemo(() => new Map(listed.map((t) => [t.id, t])), [listed]);
  const [read, setRead] = useState<ReadonlyMap<string, Task | null>>(() => new Map());

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
    fetchTasksByIds(ids).then((rows) => {
      if (cancelled) return;
      const got = new Map(rows.map((t) => [t.id, t]));
      setRead((prev) => {
        const next = new Map(prev);
        // An id the answer leaves out is gone (deleted): remembered as null, never asked again.
        for (const id of ids) next.set(id, got.get(id) ?? null);
        return next;
      });
    }).catch(() => { /* offline: asked again when the list changes */ });
    return () => { cancelled = true; };
  }, [missingKey]);

  // The order drawn while the tab stays on screen; dropped when it closes.
  const shownRef = useRef<string[] | null>(null);
  if (!active) shownRef.current = null;
  return useMemo(() => {
    const rows = new Map<string, Task>();
    const openedAt = new Map<string, string>();
    const outside = new Set<string>();
    for (const o of opens) {
      const listedTask = byId.get(o.id);
      const task = listedTask ?? read.get(o.id) ?? null;
      if (!task) continue;
      rows.set(task.id, task);
      openedAt.set(task.id, o.at);
      if (!listedTask) outside.add(task.id);
    }
    const order = active ? settledOrder(shownRef.current, [...rows.keys()]) : [...rows.keys()];
    if (active) shownRef.current = order;
    return { tasks: order.map((id) => rows.get(id)!), openedAt, outside };
  }, [opens, byId, read, active]);
}
