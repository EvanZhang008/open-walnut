import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionThreadAnchor, SessionThreadMeta, SessionThreadMetaPatch } from '@/types/session';
import type { ThreadMetaStage, ThreadMetaStore } from '@/components/sessions/thread-ui-contract';
import { indexMeta, mergeMetaPatch, sameMetaList, shouldAdoptServerMeta } from '@/utils/thread-meta';
import { log } from '@/utils/log';

/** Put back only the entries one write touched, keeping every other change that
 *  landed since (another write's optimistic entry, an adopted AI title). */
export function restoreEntries(current: SessionThreadMeta[], before: SessionThreadMeta[], heads: Set<string>): SessionThreadMeta[] {
  const prev = indexMeta(before);
  const out: SessionThreadMeta[] = [];
  for (const m of current) {
    if (!heads.has(m.headId)) { out.push(m); continue; }
    const was = prev.get(m.headId);
    if (was) out.push(was);
  }
  return out;
}

const stamp = (m: SessionThreadMeta): number => {
  const t = Date.parse(m.updatedAt);
  return Number.isFinite(t) ? t : 0;
};

/**
 * A write's response merged into what is already confirmed, ENTRY BY ENTRY:
 * PATCHes are not all on one chain (the drawer's lazy naming runs beside the
 * actions), so a response written before a Done can arrive after it. Per head,
 * the newer `updatedAt` wins (a tie goes to the response). An entry the response
 * lacks stays only when it is newer than everything in the response (written
 * after that response was produced); otherwise the server pruned it.
 */
export function mergeConfirmedMeta(local: readonly SessionThreadMeta[], incoming: readonly SessionThreadMeta[]): SessionThreadMeta[] {
  const mine = indexMeta(local);
  let newestIncoming = 0;
  for (const m of incoming) newestIncoming = Math.max(newestIncoming, stamp(m));
  const seen = new Set<string>();
  const out: SessionThreadMeta[] = [];
  for (const m of incoming) {
    seen.add(m.headId);
    const ours = mine.get(m.headId);
    out.push(ours && stamp(ours) > stamp(m) ? ours : m);
  }
  for (const m of local) {
    if (!seen.has(m.headId) && stamp(m) > newestIncoming) out.push(m);
  }
  return out;
}

/** Only the server knows whether a name will come (the AI gate): the optimistic
 *  copy never claims `Naming…`; the stored reply says `pending` or `unavailable`
 *  (C23: a gate-off session must never flash it). */
export function withoutPendingName(entry: SessionThreadMetaPatch): SessionThreadMetaPatch {
  if (entry.titleState !== 'pending') return entry;
  const { titleState: _drop, ...rest } = entry;
  return rest as SessionThreadMetaPatch;
}

/**
 * Per-question meta for one session: optimistic locally, persisted on the record
 * (`PATCH /api/sessions/:id { thread_meta }`, upsert by headId).
 *
 * The same shape as `useSessionThreads` (confirmed ref, in-flight count, adopt
 * guard, session-switch reset) with one difference: the server MERGES entries,
 * so a failure rolls back only the entries that write touched.
 */
export function useSessionThreadMeta(
  sessionId: string,
  serverMeta?: SessionThreadMeta[],
  serverAnchors?: SessionThreadAnchor[],
): ThreadMetaStore {
  const [list, setList] = useState<SessionThreadMeta[]>(serverMeta ?? []);
  const listRef = useRef<SessionThreadMeta[]>(serverMeta ?? []);
  const confirmed = useRef<SessionThreadMeta[]>(serverMeta ?? []);
  const inFlight = useRef(0);
  const wroteLocally = useRef(false);
  const anchorsRef = useRef<SessionThreadAnchor[] | undefined>(serverAnchors);
  anchorsRef.current = serverAnchors;
  /** The session on screen: a response for a previous one (the panel switched
   *  session in place while it was in flight) is never adopted. */
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const adopt = useCallback((next: SessionThreadMeta[]) => {
    listRef.current = next;
    setList(next);
  }, []);

  // Session switch: adopt the new session's list outright.
  useEffect(() => {
    inFlight.current = 0;
    wroteLocally.current = false;
    confirmed.current = serverMeta ?? [];
    adopt(serverMeta ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only; the effect below handles updates
  }, [sessionId]);

  useEffect(() => {
    if (inFlight.current > 0) return;
    const next = serverMeta ?? [];
    if (sameMetaList(next, confirmed.current)) return;
    if (!shouldAdoptServerMeta(next, confirmed.current, wroteLocally.current, anchorsRef.current ?? [])) {
      log.info('threads', 'ignoring a session record whose question meta is behind ours', {
        sessionId, ours: confirmed.current.length, theirs: next.length,
      });
      return;
    }
    confirmed.current = next;
    adopt(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId only labels the log line
  }, [serverMeta, adopt]);

  const settle = useCallback((record: { threadMeta?: SessionThreadMeta[] }, forSession: string) => {
    if (forSession !== sessionRef.current) {
      log.info('threads', 'dropping a question meta response for another session', { sessionId: sessionRef.current, from: forSession });
      return;
    }
    const next = mergeConfirmedMeta(confirmed.current, record.threadMeta ?? []);
    confirmed.current = next;
    // A later write still in flight keeps its optimistic entries on screen.
    if (inFlight.current === 0) adopt(next);
  }, [adopt]);

  const stage = useCallback((entries: SessionThreadMetaPatch[]): ThreadMetaStage => {
    const before = listRef.current;
    const heads = new Set(entries.map((e) => e.headId));
    adopt(mergeMetaPatch(before, entries.map(withoutPendingName), new Date().toISOString()));
    wroteLocally.current = true;
    inFlight.current += 1;
    let settled = false;
    const forSession = sessionId;
    const done = () => {
      if (settled) return false;
      settled = true;
      // A switch reset the count; a write of the old session must not eat the new one's.
      if (forSession === sessionRef.current) inFlight.current = Math.max(0, inFlight.current - 1);
      return true;
    };
    log.info('threads', 'meta write staged', { sessionId, headIds: [...heads] });
    return {
      body: { thread_meta: entries },
      confirm: (record) => { if (done()) settle(record, forSession); },
      rollback: () => {
        if (!done() || forSession !== sessionRef.current) return;
        log.warn('threads', 'meta write failed, rolling back', { sessionId, headIds: [...heads] });
        adopt(restoreEntries(listRef.current, before, heads));
      },
    };
  }, [sessionId, adopt, settle]);

  const patch = useCallback<ThreadMetaStore['patch']>(async (entries) => {
    if (entries.length === 0) return true;
    const staged = stage(entries);
    try {
      const record = await updateSession(sessionId, staged.body);
      staged.confirm(record);
      return true;
    } catch (err) {
      log.warn('threads', 'meta PATCH failed', { sessionId, error: String(err) });
      staged.rollback();
      return false;
    }
  }, [sessionId, stage]);

  const adoptRecord = useCallback<ThreadMetaStore['adoptRecord']>((record) => settle(record, sessionRef.current), [settle]);

  const index = useMemo(() => indexMeta(list), [list]);
  return useMemo(() => ({ list, index, patch, stage, adoptRecord }), [list, index, patch, stage, adoptRecord]);
}
