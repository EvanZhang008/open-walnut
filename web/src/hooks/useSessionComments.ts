/**
 * The passage quotes and comments of one session: kept locally, persisted on the
 * session record (`PATCH /api/sessions/:id { passage_comments }`).
 *
 * Every copy of the list meets ours through `mergeComments` (a union by id where
 * sent and taken out are one-way stamps), so a stale read, a write from another
 * window, or a failed save never loses a comment, un-sends one or brings a removed
 * one back. What the user did locally is the truth until the record has it: a
 * failed save is retried, and a change made before the record loaded is written
 * once it has (a whole-list PATCH then would have replaced the record's list).
 *
 * A send claims the pending ones at once (`claim`), so a second send while the
 * first is in flight cannot carry them again; `settle` marks them sent, or gives
 * them back when the send was refused.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionPassageComment } from '@/types/session';
import type { SessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { isPending, markRemoved, markSent, mergeComments, pruneComments } from '@/utils/passage-comments';
import { log } from '@/utils/log';

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const same = (a: readonly SessionPassageComment[], b: readonly SessionPassageComment[]) => JSON.stringify(a) === JSON.stringify(b);

export interface SessionCommentsStore extends SessionCommentsApi {
  /** Waiting for the next send (and not claimed by one in flight). */
  pending: SessionPassageComment[];
  /** A send takes the pending ones: nobody else will carry them. */
  claim: () => SessionPassageComment[];
  /** The send with `ids` was accepted (they become marks) or refused (they wait again). */
  settle: (ids: readonly string[], accepted: boolean) => void;
}

export function useSessionComments(
  sessionId: string,
  serverList: SessionPassageComment[] | undefined,
  /** The session record has been read: before that a write would replace its list. */
  loaded: boolean,
): SessionCommentsStore {
  const [comments, setComments] = useState<SessionPassageComment[]>(serverList ?? []);
  const listRef = useRef<SessionPassageComment[]>(serverList ?? []);
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const sendingRef = useRef<Set<string>>(new Set());
  const [jump, setJump] = useState<{ id: string; seq: number } | null>(null);
  // One write at a time; `dirty` = local changes the record does not have yet.
  const writing = useRef(false);
  const dirty = useRef(false);
  const attempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped on a session switch: an answer for the old session is dropped.
  const generation = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const adopt = useCallback((next: SessionPassageComment[]) => {
    if (same(next, listRef.current)) return;
    listRef.current = next;
    setComments(next);
  }, []);

  const flush = useCallback(() => {
    if (writing.current || !dirty.current || !loadedRef.current) return;
    writing.current = true;
    dirty.current = false;
    const gen = generation.current;
    const body = pruneComments(listRef.current, Date.now());
    updateSession(sessionId, { passage_comments: body })
      .then((record) => {
        if (gen !== generation.current) return;
        attempt.current = 0;
        // The record's answer may hold another window's entries: merged in, never replacing ours.
        adopt(mergeComments(listRef.current, record.passageComments ?? []));
      })
      .catch((err) => {
        if (gen !== generation.current) return;
        dirty.current = true;
        const wait = RETRY_MS[Math.min(attempt.current, RETRY_MS.length - 1)]!;
        attempt.current += 1;
        log.warn('session', 'passage comments save failed, retrying', { sessionId, error: String(err), retryInMs: wait });
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => flushRef.current(), wait);
      })
      .finally(() => {
        if (gen !== generation.current) return;
        writing.current = false;
        if (dirty.current && attempt.current === 0) flushRef.current();
      });
  }, [sessionId, adopt]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const persist = useCallback((next: SessionPassageComment[]) => {
    adopt(next);
    dirty.current = true;
    flushRef.current();
  }, [adopt]);

  // Session switch: start from the new record; nothing of the old one carries over.
  useEffect(() => {
    generation.current += 1;
    writing.current = false;
    dirty.current = false;
    attempt.current = 0;
    clearTimeout(retryTimer.current);
    sendingRef.current = new Set();
    setSending(new Set());
    listRef.current = serverList ?? [];
    setComments(serverList ?? []);
    setJump(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only; the effect below follows the record
  }, [sessionId]);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  // Every record copy is merged in; a change made before the record loaded is written now.
  useEffect(() => {
    if (!loaded) return;
    adopt(mergeComments(listRef.current, serverList ?? []));
    flushRef.current();
  }, [serverList, loaded, adopt]);

  const add = useCallback<SessionCommentsApi['add']>(({ msgId, role, quote, text, comment }) => {
    if (!msgId || !quote.exact.trim() || !text.trim()) return;
    const entry: SessionPassageComment = {
      id: newId(), msgId, role, quote, text, comment: comment.trim(), createdAt: new Date().toISOString(),
    };
    log.info('session', entry.comment ? 'passage comment added' : 'passage quote added', {
      sessionId, msgId, id: entry.id, chars: text.length, commentChars: entry.comment.length,
    });
    persist([...listRef.current, entry]);
  }, [persist, sessionId]);

  const remove = useCallback((id: string) => {
    if (!listRef.current.some((c) => c.id === id && !c.removedAt)) return;
    log.info('session', 'passage comment removed', { sessionId, id });
    persist(markRemoved(listRef.current, id, new Date().toISOString()));
  }, [persist, sessionId]);

  const claim = useCallback(() => {
    const taken = listRef.current.filter((c) => isPending(c) && !sendingRef.current.has(c.id));
    if (!taken.length) return taken;
    for (const c of taken) sendingRef.current.add(c.id);
    setSending(new Set(sendingRef.current));
    return taken;
  }, []);

  const settle = useCallback((ids: readonly string[], accepted: boolean) => {
    if (!ids.length) return;
    for (const id of ids) sendingRef.current.delete(id);
    setSending(new Set(sendingRef.current));
    if (accepted) persist(markSent(listRef.current, new Set(ids), new Date().toISOString()));
  }, [persist]);

  const requestJump = useCallback((id: string) => {
    setJump((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const pending = useMemo(() => comments.filter((c) => isPending(c) && !sending.has(c.id)), [comments, sending]);
  const shown = useMemo(() => comments.filter((c) => !c.removedAt), [comments]);

  return useMemo<SessionCommentsStore>(
    () => ({ comments: shown, pending, add, remove, claim, settle, requestJump, jump, canComment: true }),
    [shown, pending, add, remove, claim, settle, requestJump, jump],
  );
}
