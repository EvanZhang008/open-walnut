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
 * them back when the send was refused. An edit of one a send has claimed is
 * refused, and a record copy met meanwhile leaves it as claimed
 * (`mergeKeepingClaimed`): the words on their way are the ones it is stamped with.
 * A record copy that lacks something of ours (a stale window wrote over it) is
 * written again (`recordNeedsWrite`; our own write's echo matches, so it stops).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionPassageComment } from '@/types/session';
import type { SessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { editComment, isPending, markRemoved, markSent, mergeKeepingClaimed, pruneComments, recordNeedsWrite, settleSent } from '@/utils/passage-comments';
import { log } from '@/utils/log';

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Rewrites in a row over record copies that keep lacking ours, with no change of ours between: a guard, never reached when the echo matches. */
const MAX_ECHO_WRITES = 3;

function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const same = (a: readonly SessionPassageComment[], b: readonly SessionPassageComment[]) => JSON.stringify(a) === JSON.stringify(b);

/** What the store's add takes: the context's input, the page already turned into its question's head id. */
export type SessionCommentInput = Omit<Parameters<SessionCommentsApi['add']>[0], 'pageKey'> & { thread?: string };

export interface SessionCommentsStore extends Omit<SessionCommentsApi, 'add'> {
  add: (input: SessionCommentInput) => void;
  /** Waiting for the next send (and not claimed by one in flight). */
  pending: SessionPassageComment[];
  /** A send takes the pending ones (those `which` picks: the composer's own
   *  question in Tree Mode): nobody else will carry them. */
  claim: (which?: (c: SessionPassageComment) => boolean) => SessionPassageComment[];
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
  /** What each claimed item was when its send took it (id -> the item). */
  const claimedRef = useRef<Map<string, SessionPassageComment>>(new Map());
  /** The newest record copy seen, merged in again when a send gives its items back. */
  const lastRecord = useRef<SessionPassageComment[]>(serverList ?? []);
  const echoWrites = useRef(0);
  const [jump, setJump] = useState<SessionCommentsApi['jump']>(null);
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
        meetRecordRef.current(record.passageComments ?? []);
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
  const meetRecordRef = useRef<(record: SessionPassageComment[]) => void>(() => {});

  /** A record copy: merged in (claimed items as claimed); written over when it lacks ours. */
  const meetRecord = useCallback((record: SessionPassageComment[]) => {
    lastRecord.current = record;
    adopt(mergeKeepingClaimed(listRef.current, record, sendingRef.current));
    if (!recordNeedsWrite(listRef.current, record, Date.now(), sendingRef.current)) { echoWrites.current = 0; return; }
    if (echoWrites.current >= MAX_ECHO_WRITES) {
      log.warn('session', 'passage comments: the record keeps lacking ours, not writing again', { sessionId });
      return;
    }
    echoWrites.current += 1;
    log.info('session', 'passage comments: the record lacks ours, writing again', { sessionId });
    dirty.current = true;
  }, [adopt, sessionId]);
  meetRecordRef.current = meetRecord;

  const persist = useCallback((next: SessionPassageComment[]) => {
    echoWrites.current = 0;
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
    claimedRef.current = new Map();
    lastRecord.current = serverList ?? [];
    echoWrites.current = 0;
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
    meetRecord(serverList ?? []);
    flushRef.current();
  }, [serverList, loaded, meetRecord]);

  const add = useCallback(({ msgId, role, quote, text, comment, doc, thread }: SessionCommentInput) => {
    if (!msgId || !quote.exact.trim() || !text.trim()) return;
    const entry: SessionPassageComment = {
      id: newId(), msgId, role, quote, text, comment: comment.trim(), createdAt: new Date().toISOString(),
      ...(doc ? { doc } : {}),
      ...(thread ? { thread } : {}),
    };
    log.info('session', entry.comment ? 'passage comment added' : 'passage quote added', {
      sessionId, msgId, id: entry.id, chars: text.length, commentChars: entry.comment.length, docPath: doc?.path ?? null, thread: thread ?? null,
    });
    persist([...listRef.current, entry]);
  }, [persist, sessionId]);

  const remove = useCallback((id: string) => {
    if (!listRef.current.some((c) => c.id === id && !c.removedAt)) return;
    log.info('session', 'passage comment removed', { sessionId, id });
    persist(markRemoved(listRef.current, id, new Date().toISOString()));
  }, [persist, sessionId]);

  const update = useCallback((id: string, comment: string): boolean => {
    const words = comment.trim();
    const cur = listRef.current.find((c) => c.id === id);
    if (!cur || !isPending(cur) || cur.doc || sendingRef.current.has(id)) {
      log.info('session', 'passage comment edit refused', {
        sessionId, id, reason: !cur ? 'gone' : cur.removedAt ? 'removed' : cur.doc ? 'doc' : cur.sentAt ? 'sent' : 'sending',
      });
      return false;
    }
    if (cur.comment === words) return true;
    const next = editComment(listRef.current, id, words, new Date().toISOString());
    if (next === listRef.current) return false;
    log.info('session', 'passage comment edited', { sessionId, id, commentChars: words.length, wasQuote: !cur.comment });
    persist([...next]);
    return true;
  }, [persist, sessionId]);

  const claim = useCallback((which?: (c: SessionPassageComment) => boolean) => {
    const taken = listRef.current.filter((c) => isPending(c) && !sendingRef.current.has(c.id) && (!which || which(c)));
    if (!taken.length) return taken;
    for (const c of taken) { sendingRef.current.add(c.id); claimedRef.current.set(c.id, c); }
    setSending(new Set(sendingRef.current));
    return taken;
  }, []);

  const settle = useCallback((ids: readonly string[], accepted: boolean) => {
    if (!ids.length) return;
    const claimed = new Map(ids.flatMap((id) => {
      const c = claimedRef.current.get(id);
      return c ? [[id, c] as const] : [];
    }));
    for (const id of ids) { sendingRef.current.delete(id); claimedRef.current.delete(id); }
    setSending(new Set(sendingRef.current));
    if (accepted) {
      // The newest record copy merged in (a removal made elsewhere meanwhile stands),
      // then stamped sent on the words that went, whatever edit reached it meanwhile.
      persist(markSent(settleSent(listRef.current, lastRecord.current, claimed, sendingRef.current), new Set(ids), new Date().toISOString()));
      return;
    }
    // Given back: the newest record copy decides again (another window's edit made
    // meanwhile wins now), and a record that lost them while they were held gets them back.
    meetRecordRef.current(lastRecord.current);
    flushRef.current();
  }, [persist]);

  const requestJump = useCallback<SessionCommentsApi['requestJump']>((id, opts) => {
    setJump((prev) => ({
      id, seq: (prev?.seq ?? 0) + 1, at: Date.now(),
      ...(opts?.edit ? { edit: true } : {}), ...(opts?.origin ? { origin: opts.origin } : {}),
    }));
  }, []);

  const pending = useMemo(() => comments.filter((c) => isPending(c) && !sending.has(c.id)), [comments, sending]);
  const shown = useMemo(() => comments.filter((c) => !c.removedAt), [comments]);

  return useMemo<SessionCommentsStore>(
    () => ({ comments: shown, pending, add, update, remove, claim, settle, requestJump, jump, canComment: true }),
    [shown, pending, add, update, remove, claim, settle, requestJump, jump],
  );
}
