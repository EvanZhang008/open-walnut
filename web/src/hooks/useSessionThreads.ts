import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionThreadAnchor } from '@/types/session';
import type { ComposerThreadAnchor } from '@/utils/thread-tree';
import { log } from '@/utils/log';

/** One anchor per user message, so the msgId IS the row identity. */
export function anchorKeyOf(anchor: SessionThreadAnchor): string {
  return anchor.msgId;
}

/**
 * Should the record's copy of the anchor list replace ours? Same rule as
 * `shouldAdoptServerPins`, for the same measured reason: the panel's fetch queue
 * routinely holds tens of requests, so a `GET /api/sessions/:id` issued before an
 * anchor write resolves AFTER it and arrives without that anchor. Adopting it
 * would drop the thread the user is typing into.
 *
 * A list that ADDS anchors (another tab, another device) is still adopted; one
 * that only removes them waits for a reload.
 */
export function shouldAdoptServerAnchors(
  server: SessionThreadAnchor[],
  confirmed: SessionThreadAnchor[],
  wroteLocally: boolean,
): boolean {
  if (!wroteLocally) return true;
  const keys = new Set(server.map(anchorKeyOf));
  return confirmed.every((a) => keys.has(anchorKeyOf(a)));
}

/** Same list, entry for entry. O(n) over a few hundred small records, instead of
 *  two JSON.stringify passes on every record refetch. */
export function sameAnchorList(a: SessionThreadAnchor[], b: SessionThreadAnchor[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.msgId !== y.msgId || x.parent !== y.parent || x.source !== y.source || x.at !== y.at) return false;
    if ((x.quote?.exact ?? '') !== (y.quote?.exact ?? '')) return false;
    if ((x.quote?.prefix ?? '') !== (y.quote?.prefix ?? '')) return false;
    if ((x.quote?.suffix ?? '') !== (y.quote?.suffix ?? '')) return false;
  }
  return true;
}

export interface SessionThreadsStore {
  anchors: SessionThreadAnchor[];
  /** Record (or replace) the anchor for one user message. */
  add: (anchor: SessionThreadAnchor) => void;
  /** Drop the anchor for one user message — that turn returns to the top level. */
  remove: (msgId: string) => void;
}

/**
 * Thread anchors for one session: optimistic locally, persisted on the session
 * record (`PATCH /api/sessions/:id { thread_anchors }`).
 *
 * A near-copy of `useSessionPins` on purpose — same list-on-the-record storage,
 * same adoption guards, same revert-on-failure. Anchoring is part of a SEND, so a
 * round trip may not sit between the gesture and the UI reacting; and the server
 * answer carries nothing the client did not already know, because the client owns
 * the list.
 */
export function useSessionThreads(
  sessionId: string,
  serverAnchors?: SessionThreadAnchor[],
): SessionThreadsStore {
  const [anchors, setAnchors] = useState<SessionThreadAnchor[]>(serverAnchors ?? []);
  // Newest list, for two writes landing in one render (a send + a rail pick).
  const listRef = useRef<SessionThreadAnchor[]>(serverAnchors ?? []);
  const confirmed = useRef<SessionThreadAnchor[]>(serverAnchors ?? []);
  const inFlight = useRef(0);
  const wroteLocally = useRef(false);

  const adopt = useCallback((next: SessionThreadAnchor[]) => {
    listRef.current = next;
    setAnchors(next);
  }, []);

  // Session switch: adopt the new session's list outright (never carry anchors across).
  useEffect(() => {
    inFlight.current = 0;
    wroteLocally.current = false;
    confirmed.current = serverAnchors ?? [];
    adopt(serverAnchors ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only; the effect below handles updates
  }, [sessionId]);

  useEffect(() => {
    if (inFlight.current > 0) return;
    const next = serverAnchors ?? [];
    if (sameAnchorList(next, confirmed.current)) return;
    if (!shouldAdoptServerAnchors(next, confirmed.current, wroteLocally.current)) {
      log.info('session', 'ignoring a session record whose thread anchors are behind ours', {
        sessionId, ours: confirmed.current.length, theirs: next.length,
      });
      return;
    }
    confirmed.current = next;
    adopt(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId only labels the log line
  }, [serverAnchors, adopt]);

  const persist = useCallback((next: SessionThreadAnchor[]) => {
    adopt(next);
    wroteLocally.current = true;
    inFlight.current += 1;
    updateSession(sessionId, { thread_anchors: next })
      .then(() => { confirmed.current = next; })
      .catch((err) => {
        log.warn('session', 'thread anchor save failed — reverting', { sessionId, error: String(err) });
        adopt(confirmed.current);
      })
      .finally(() => { inFlight.current = Math.max(0, inFlight.current - 1); });
  }, [sessionId, adopt]);

  const add = useCallback((anchor: SessionThreadAnchor) => {
    if (!anchor.msgId || !anchor.parent) return;
    const current = listRef.current;
    persist([...current.filter((a) => a.msgId !== anchor.msgId), anchor]);
  }, [persist]);

  const remove = useCallback((msgId: string) => {
    const current = listRef.current;
    if (!current.some((a) => a.msgId === msgId)) return;
    persist(current.filter((a) => a.msgId !== msgId));
  }, [persist]);

  return useMemo(() => ({ anchors, add, remove }), [anchors, add, remove]);
}

/** sessionStorage key for the composer's sticky anchor. Per TAB, deliberately:
 *  "what I am currently asking about" is a property of this window's composer,
 *  not of the account, and it must not leak into a second tab's draft. */
function composerAnchorKey(sessionId: string): string {
  return `walnut:thread-anchor:${sessionId}`;
}

function readComposerAnchor(sessionId: string): ComposerThreadAnchor | null {
  try {
    const raw = sessionStorage.getItem(composerAnchorKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComposerThreadAnchor;
    if (!parsed || typeof parsed.parent !== 'string' || !parsed.parent) return null;
    return parsed;
  } catch { return null; }
}

/**
 * The composer's sticky anchor, remembered per session for this tab: a reload
 * mid-question must not silently drop the thread and send the follow-up to the
 * top level.
 */
export function useComposerThreadAnchor(sessionId: string): {
  composerAnchor: ComposerThreadAnchor | null;
  setComposerAnchor: (anchor: ComposerThreadAnchor | null) => void;
} {
  const [composerAnchor, setState] = useState<ComposerThreadAnchor | null>(() => readComposerAnchor(sessionId));

  // Session switch: load THAT session's anchor (never carry one across).
  useEffect(() => { setState(readComposerAnchor(sessionId)); }, [sessionId]);

  const setComposerAnchor = useCallback((anchor: ComposerThreadAnchor | null) => {
    setState(anchor);
    try {
      if (anchor) sessionStorage.setItem(composerAnchorKey(sessionId), JSON.stringify(anchor));
      else sessionStorage.removeItem(composerAnchorKey(sessionId));
    } catch { /* private browsing — the chip just forgets on reload */ }
  }, [sessionId]);

  return { composerAnchor, setComposerAnchor };
}

export type SessionViewMode = 'linear' | 'tree';

function viewModeKey(sessionId: string): string {
  return `walnut:session-view:${sessionId}`;
}

function readViewMode(sessionId: string): SessionViewMode {
  try {
    return localStorage.getItem(viewModeKey(sessionId)) === 'tree' ? 'tree' : 'linear';
  } catch { return 'linear'; }
}

/** Linear (the timeline) vs tree (the node view), remembered per session across
 *  reloads — a per-session reading preference, not a global mode. */
export function useSessionViewMode(sessionId: string): {
  viewMode: SessionViewMode;
  setViewMode: (mode: SessionViewMode) => void;
} {
  const [viewMode, setState] = useState<SessionViewMode>(() => readViewMode(sessionId));

  // Session switch: read THAT session's preference.
  useEffect(() => { setState(readViewMode(sessionId)); }, [sessionId]);

  const setViewMode = useCallback((mode: SessionViewMode) => {
    setState(mode);
    try { localStorage.setItem(viewModeKey(sessionId), mode); } catch { /* private browsing */ }
  }, [sessionId]);

  return { viewMode, setViewMode };
}
