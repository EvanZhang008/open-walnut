/**
 * The team's task summaries (spec 6 item 4, G11). The Home task store holds the
 * minimal list projection (`fields=list` drops `summary`), so a card would show
 * no task summary until a WS echo carried one. This hook reads the summaries
 * of the team's tasks once with `GET /api/tasks?ids=...&slim=1` (100 ids per
 * read), and reads a task again when its `updated_at` in the store moves while
 * the store still has no summary for it. A summary the store does hold (a WS
 * echo) always wins: it is the newer one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';

const CHUNK = 100;
const DEBOUNCE_MS = 400;
/** The cards wait this long at most for their first summaries (R3-01); then they draw without. */
export const SUMMARY_WAIT_MS = 3_000;

interface Known { summary: string; updatedAt: string }

export interface TeamSummaries {
  /** Task id to summary ('' = read, the task has none). */
  map: ReadonlyMap<string, string>;
  /** Every team task's summary is known (or the wait ran out): the cards can draw at their final height. */
  ready: boolean;
}

/** Task id to summary for the given team ids. */
export function useTeamSummaries(ownerId: string, ids: readonly string[], byId: ReadonlyMap<string, Task>): TeamSummaries {
  const known = useRef(new Map<string, Known>());
  const inFlight = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => { known.current = new Map(); inFlight.current = new Set(); setTimedOut(false); setVersion((v) => v + 1); }, [ownerId]);

  // The ids to (re)read: never read, or moved in the store with no summary there.
  const want: string[] = [];
  let unknown = 0;
  for (const id of ids) {
    const t = byId.get(id);
    if (t && t.summary !== undefined) continue;
    // The list projection says when there is nothing to read.
    if (t && (t as { has_summary?: boolean }).has_summary === false) continue;
    const k = known.current.get(id);
    if (!k) unknown++;
    if (inFlight.current.has(id)) continue;
    if (!k || (t && (t.updated_at ?? '') !== k.updatedAt)) want.push(id);
  }
  const wantKey = want.join(',');
  // Latched per owner: a card that joins later (Add task, a new worker) never sends the board back to its skeletons.
  const wasReady = useRef('');
  const ready = wasReady.current === ownerId || unknown === 0 || timedOut;
  if (ready && ids.length > 0) wasReady.current = ownerId;
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => {
      log.warn('board', 'kanban summaries slow, cards drawn without them', { taskId: ownerId, waitMs: SUMMARY_WAIT_MS });
      setTimedOut(true);
    }, SUMMARY_WAIT_MS);
    return () => clearTimeout(t);
  }, [ready, ownerId]);

  useEffect(() => {
    if (!wantKey) return;
    const list = wantKey.split(',');
    // The first read goes at once (the cards wait for it, R3-01); a re-read after a store change waits a beat.
    const first = list.every((id) => !known.current.has(id));
    const timer = setTimeout(() => {
      // Keyed by the store's clock at ask time, so a store clock the server never echoes cannot loop.
      const askedAt = new Map(list.map((id) => [id, byId.get(id)?.updated_at ?? '']));
      for (const id of list) inFlight.current.add(id);
      const chunks: string[][] = [];
      for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
      const t0 = Date.now();
      void Promise.all(chunks.map((c) => apiGet<{ tasks: Task[] }>('/api/tasks', { ids: c.join(','), slim: '1' }, { priority: 'low' })
        .then((r) => r.tasks)
        .catch((err: unknown) => {
          log.warn('board', 'kanban task summaries not read', { taskId: ownerId, count: c.length, error: err instanceof Error ? err.message : String(err) });
          return [] as Task[];
        })))
        .then((parts) => {
          const got = parts.flat();
          const answered = new Map(got.map((t) => [t.id, t.summary ?? '']));
          // A task the server did not answer for is not asked again until it moves.
          for (const id of list) {
            inFlight.current.delete(id);
            known.current.set(id, { summary: answered.get(id) ?? known.current.get(id)?.summary ?? '', updatedAt: askedAt.get(id) ?? '' });
          }
          log.info('board', 'kanban task summaries read', { taskId: ownerId, count: got.length, ms: Date.now() - t0 });
          setVersion((v) => v + 1);
        });
    }, first ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wantKey, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const out = useRef<{ v: number; map: Map<string, string> }>({ v: -1, map: new Map() });
  if (out.current.v !== version) {
    const map = new Map<string, string>();
    for (const [id, k] of known.current) map.set(id, k.summary);
    out.current = { v: version, map };
  }
  const map = out.current.map;
  return useMemo(() => ({ map, ready }), [map, ready]);
}
