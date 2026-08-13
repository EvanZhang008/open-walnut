import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchSessionHistory, HISTORY_TAIL_LIMIT } from '@/api/sessions';
import { perf } from '@/utils/perf-logger';
import { log } from '@/utils/log';
import type { SessionHistoryMessage } from '@/types/session';
import {
  trackSession,
  getHistoryCache,
  setHistoryCache,
} from '@/cache/session-cache';
import { computeHistoryAnchor, collectUnsettledIds } from './history-anchor';
import { planDeltaMerge } from './history-merge';
import { visibleInterval } from '@/utils/page-visibility';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  /** Phase 2 (SSH/full fetch) still in progress — true between Phase 1 completion and Phase 2 completion */
  phase2Pending: boolean;
  error: string | null;
  /** Non-null when the rendered history is the server's LAST-GOOD parse (live
   *  read failed — SSH down / daemon timeout). Value = underlying reason.
   *  Content is shown; caller renders a degraded-connectivity banner. */
  stale: string | null;
  /** Index in messages[] where the fork boundary is (source messages end, forked messages start) */
  forkBoundaryIndex?: number;
  /** Messages that exist at the source but were NOT loaded (lazy tail load).
   *  0 = we hold the full history. */
  olderHidden: number;
  /** The payload was a BOUNDED window read (whale / cold tail-bounded read):
   *  older messages exist but their COUNT is unknown (`total` is the window
   *  length), so olderHidden stays 0 — show an uncounted "Load earlier". */
  olderWindowed: boolean;
  /** Fetch the full history (no tail limit) — call when the user wants to read
   *  past the lazy-loaded tail. Idempotent while in flight. */
  loadFullHistory: () => void;
}

/** Diagnostic: count user text messages and check if they're interleaved or bunched */
function diagnoseOrdering(phase: string, sid: string, msgs: SessionHistoryMessage[]): void {
  const userIndices: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user' && msgs[i].text?.trim()) userIndices.push(i);
  }
  if (userIndices.length === 0) {
    console.debug(`[session-history] ${phase} ${sid}: ${msgs.length} msgs, 0 user text msgs`);
    return;
  }
  // Check: are user messages bunched at the end?
  const lastAsst = msgs.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1);
  const usersAfterLastAsst = userIndices.filter(i => i > lastAsst).length;
  const bunched = usersAfterLastAsst > userIndices.length / 2;
  console.debug(
    `[session-history] ${phase} ${sid}: ${msgs.length} msgs, ${userIndices.length} user text, ` +
    `lastAsst@${lastAsst}, usersAfterLast=${usersAfterLastAsst}${bunched ? ' ⚠️ BUNCHED' : ' ✓ interleaved'}`
  );
}

/**
 * Two-phase session history loading:
 * Phase 1: Read local streams file (~1ms) — instant display
 * Phase 2: Async fetch source of truth (may SSH, 3-5s) — silent update
 *
 * When version > 0 (re-fetch after batch-completed), skip Phase 1 — go directly to Phase 2.
 * Phase 1 reads local streams for fast initial display; on re-fetch the client
 * already has messages rendered, so the fast-path just adds latency for no benefit.
 *
 * `enabled` (default true) gates the EXPENSIVE Phase 2 SSH fetch only. Pass
 * false for offscreen/restored-but-not-visible session columns so they render
 * instantly from the local streams/cache (Phase 1) without each firing a 20-30s
 * remote SSH history pull that would saturate the browser's ~5 HTTP/1.1 lanes
 * during the home fan-out. Flip it true when the column becomes visible to
 * trigger the full fetch. Default true preserves existing callers unchanged.
 */
export function useSessionHistory(sessionId: string | null, version = 0, enabled = true): UseSessionHistoryReturn {
  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [phase2Pending, setPhase2Pending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Server served its last-good parse because the live read failed (SSH down /
  // daemon timeout). Content renders; caller shows a degraded banner. Distinct
  // from `error` (which blanks the view when there's nothing to show).
  const [stale, setStale] = useState<string | null>(null);
  const [forkBoundaryIndex, setForkBoundaryIndex] = useState<number | undefined>(undefined);

  // Cursor = combined-message count the client has synced to. Advances on every
  // successful full/delta fetch; reset on session switch. Held in a ref so a
  // `version` bump (turn boundary) reuses it without re-running the initial load.
  const cursorRef = useRef(0);
  // messages[] mirror so the delta-append updater has the current base without a
  // stale closure (version-effect reads it synchronously).
  const messagesRef = useRef<SessionHistoryMessage[]>([]);
  messagesRef.current = messages;
  // Lazy tail load: how many messages exist BEFORE messages[0] at the source
  // (`?tail=` slice). cursor space includes them; planDeltaMerge gets this as
  // baseOffset so its length guard still adds up.
  const baseOffsetRef = useRef(0);
  const [olderHidden, setOlderHidden] = useState(0);
  const [olderWindowed, setOlderWindowed] = useState(false);
  // Adopt a full (possibly tail-sliced) payload's offset bookkeeping.
  // `windowed` = bounded window read: cursor === messages.length even though
  // older messages exist, so olderHidden computes to 0 — track the flag
  // separately so the UI still offers "Load earlier".
  const adoptOffset = (msgCount: number, cursor: number, windowed?: boolean) => {
    const offset = Math.max(0, cursor - msgCount);
    baseOffsetRef.current = offset;
    setOlderHidden(offset);
    setOlderWindowed(!!windowed);
  };

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      setPhase2Pending(false);
      setError(null);
      setStale(null);
      setForkBoundaryIndex(undefined);
      cursorRef.current = 0;
      baseOffsetRef.current = 0;
      setOlderHidden(0);
      setOlderWindowed(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setError(null);
    setStale(null);
    setForkBoundaryIndex(undefined);
    const sid = sessionId.substring(0, 8);

    // Track session so global cache accumulates its events in background
    trackSession(sessionId);

    // Re-fetch (version > 0): turn boundary. DELTA path — fetch only messages after
    // our cursor (a few KB, not the full 6.4MB), APPEND them (don't replace), and
    // publish the delta so the consumer promotes matching streaming blocks by
    // evidence. Skip Phase 1 (already have content). Offscreen columns skip entirely.
    if (version > 0) {
      if (!enabled) return () => { cancelled = true; controller.abort(); };
      setLoading(true);
      setPhase2Pending(true);
      const endP2 = perf.start(`session:delta:${sid}`);
      const since = cursorRef.current;
      // Identity anchor: `since` alone is not a safe split point — the server's
      // parsed array can shrink or slide (compact rewrite, subagent regrouping,
      // whale-session bounded tail), and slicing by a stale count drops the NEWEST
      // messages (inc-1785993576822). The anchor lets the server slice after a
      // specific message instead, and rebuild when it can't find it.
      const anchor = computeHistoryAnchor(messagesRef.current);
      // Re-ask for the rows we hold an unsettled copy of. The server can't infer these
      // (its own copy is already settled by now), so the client must name them.
      const reviseIds = collectUnsettledIds(messagesRef.current);
      fetchSessionHistory(sessionId, {
        since,
        anchorMsgId: anchor.anchorMsgId,
        anchorTail: anchor.anchorTail,
        reviseIds,
        // Bounds the fall-through only: an honored delta ignores tail; a DECLINED
        // delta (anchor lost) returns a full payload, which must not be multi-MB.
        tail: HISTORY_TAIL_LIMIT,
        signal: controller.signal,
      })
        .then((result) => {
          if (cancelled) return;
          endP2(`+${result.messages.length} msgs (delta=${result.delta})`);
          // A fetch that SUCCEEDED clears any previous failure. Without this the
          // error was only reset on session switch / version bump, so a single
          // transient answer (notably the startup-window "history unavailable")
          // stuck on screen for the life of the session even though every later
          // fetch was healthy.
          setError(null);
          if (result.delta) {
            // Fold the delta via the SHARED merge planner (history-merge.ts) —
            // session-cache uses the same function, so the two mirrors can't
            // drift apart again (drifted guards are how the sliding-window bug
            // survived undetected; inc-1785993576822).
            const plan = planDeltaMerge(messagesRef.current, result, cursorRef.current,
              { baseOffset: baseOffsetRef.current });
            if (plan.kind === 'rebuild') {
              log.warn('session-history', `delta merge inconsistent — rebuilding (${plan.reason}, had=${messagesRef.current.length} +delta=${result.messages.length})`, { sessionId });
              fetchSessionHistory(sessionId, { tail: HISTORY_TAIL_LIMIT, signal: controller.signal })
                .then((full) => {
                  if (cancelled) return;
                  // Stale rebuild would replace a fresher local view with the
                  // server's old parse AND corrupt the cursor — skip; the next
                  // healthy turn retries the rebuild.
                  if (full.stale) { setStale(full.staleReason ?? 'live read failed'); return; }
                  setStale(null);
                  setMessages(full.messages);
                  setForkBoundaryIndex(full.forkBoundaryIndex);
                  const fullCursor = full.cursor ?? full.messages.length;
                  cursorRef.current = fullCursor;
                  adoptOffset(full.messages.length, fullCursor, full.windowed);
                  setHistoryCache(sessionId, {
                    messages: full.messages,
                    forkBoundaryIndex: full.forkBoundaryIndex,
                    msgCount: fullCursor,
                    baseOffset: Math.max(0, fullCursor - full.messages.length),
                  });
                })
                .catch(() => { /* keep current view; next turn retries */ });
              return;
            }
            if (plan.kind === 'merged') {
              setMessages(plan.messages);
              setHistoryCache(sessionId, {
                messages: plan.messages,
                forkBoundaryIndex: result.forkBoundaryIndex ?? forkBoundaryIndex,
                msgCount: plan.cursor,
                baseOffset: baseOffsetRef.current,
              });
            }
            // Advance cursor even on an empty delta (nothing new yet — archive lagging).
            cursorRef.current = plan.cursor;
          } else {
            // Server rebuilt (since out of range) → full replace (tail-sliced).
            diagnoseOrdering('refetch-full', sid, result.messages);
            setMessages(result.messages);
            setForkBoundaryIndex(result.forkBoundaryIndex);
            const fullCursor = result.cursor ?? result.messages.length;
            cursorRef.current = fullCursor;
            adoptOffset(result.messages.length, fullCursor, result.windowed);
            setHistoryCache(sessionId, {
              messages: result.messages,
              forkBoundaryIndex: result.forkBoundaryIndex,
              msgCount: fullCursor,
              baseOffset: Math.max(0, fullCursor - result.messages.length),
            });
          }
        })
        .catch((e: Error) => {
          if (!cancelled) { endP2('error'); setError(e.message); }
        })
        .finally(() => {
          if (!cancelled) { setLoading(false); setPhase2Pending(false); }
        });
      return () => { cancelled = true; controller.abort(); };
    }

    // Initial load (version === 0): check cache first
    const cached = getHistoryCache(sessionId);
    if (cached) {
      // Cache hit → 0ms instant display, then background Phase 2 verification.
      setMessages(cached.messages);
      setForkBoundaryIndex(cached.forkBoundaryIndex);
      cursorRef.current = cached.msgCount;
      baseOffsetRef.current = cached.baseOffset ?? 0;
      setOlderHidden(cached.baseOffset ?? 0);
      setLoading(false);
      // Offscreen column: show cache, skip the background SSH re-verify until visible.
      if (!enabled) return () => { cancelled = true; controller.abort(); };
      setPhase2Pending(true);

      const endP2 = perf.start(`session:full:${sid}`);
      fetchSessionHistory(sessionId, { tail: HISTORY_TAIL_LIMIT, signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          endP2(`${result.messages.length} msgs`);
          setError(null); // successful fetch clears a previous failure (see above)
          // Degraded payload (live read failed, server sent its last-good
          // parse): our local cache is at least as fresh — keep it, surface
          // the banner, and leave cursor/cache untouched so recovery comes
          // from the next healthy fetch, not from stale data.
          if (result.stale) {
            setStale(result.staleReason ?? 'live read failed');
            return;
          }
          setStale(null);
          diagnoseOrdering('cache-verify', sid, result.messages);
          const fullCursor = result.cursor ?? result.messages.length;
          setHistoryCache(sessionId, {
            messages: result.messages,
            forkBoundaryIndex: result.forkBoundaryIndex,
            msgCount: fullCursor,
            baseOffset: Math.max(0, fullCursor - result.messages.length),
          });
          cursorRef.current = fullCursor;
          adoptOffset(result.messages.length, fullCursor, result.windowed);
          setMessages(result.messages);
          setForkBoundaryIndex(result.forkBoundaryIndex);
          // NOTE: turn-boundary block cleanup is driven by the version-bump delta
          // path (evidence-based), not here. A plain cache re-verify only refreshes
          // persisted content; streaming blocks are governed by session:result +
          // the next delta's promotion.
        })
        .catch((e: Error) => {
          if (!cancelled) { endP2('error'); setError(e.message); }
        })
        .finally(() => {
          if (!cancelled) setPhase2Pending(false);
        });

      return () => { cancelled = true; controller.abort(); };
    }

    // Cache miss → normal Phase 1 (streams) → Phase 2 (full)
    setLoading(true);
    setPhase2Pending(true);

    // Phase 1: Fast local read (streams file, ~1ms). Tail-sliced too — the
    // response has no cursor, so no offset bookkeeping; Phase 2 replaces it.
    const endP1 = perf.start(`session:streams:${sid}`);
    fetchSessionHistory(sessionId, { source: 'streams', tail: HISTORY_TAIL_LIMIT, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        endP1(`${result.messages.length} msgs`);
        diagnoseOrdering('P1:streams', sid, result.messages);
        if (result.messages.length > 0) {
          setMessages(result.messages);
        }
        if (result.forkBoundaryIndex != null) setForkBoundaryIndex(result.forkBoundaryIndex);
        setLoading(false); // Always clear loading — even if empty, don't block on Phase 2
      })
      .catch(() => {
        endP1('error');
      })
      .finally(() => {
        if (cancelled) return;
        // Offscreen column: Phase 1 (local streams) already gave instant
        // content; skip the expensive Phase 2 SSH fetch until visible.
        if (!enabled) { setPhase2Pending(false); return; }
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions).
        // Lazy: only the last HISTORY_TAIL_LIMIT messages — a whale session used
        // to pin one of the browser's 6 connections for 35-150s here.
        const endP2 = perf.start(`session:full:${sid}`);
        fetchSessionHistory(sessionId, { tail: HISTORY_TAIL_LIMIT, signal: controller.signal })
          .then((result) => {
            if (!cancelled) {
              endP2(`${result.messages.length} msgs`);
              setError(null); // successful fetch clears a previous failure (see above)
              diagnoseOrdering('P2:full', sid, result.messages);
              setMessages(result.messages);
              setForkBoundaryIndex(result.forkBoundaryIndex);
              // Degraded payload: render it (beats a blank screen) but do NOT
              // seed cursor/cache from it — its total is the server's stale
              // count and would corrupt the next ?since= delta.
              if (result.stale) {
                setStale(result.staleReason ?? 'live read failed');
                return;
              }
              setStale(null);
              const fullCursor = result.cursor ?? result.messages.length;
              cursorRef.current = fullCursor;
              adoptOffset(result.messages.length, fullCursor, result.windowed);
              // Write to cache for next visit
              setHistoryCache(sessionId, {
                messages: result.messages,
                forkBoundaryIndex: result.forkBoundaryIndex,
                msgCount: fullCursor,
                baseOffset: Math.max(0, fullCursor - result.messages.length),
              });
            }
          })
          .catch((e: Error) => {
            if (!cancelled) { endP2('error'); setError(e.message); }
          })
          .finally(() => {
            if (!cancelled) { setLoading(false); setPhase2Pending(false); }
          });
      });

    return () => { cancelled = true; controller.abort(); };
  }, [sessionId, version, enabled]);

  // Self-heal the "Showing cached history — Reconnecting…" banner.
  //
  // `stale` is set when a full fetch failed the live read (SSH/daemon down) and
  // the server served its last-good parse. It is otherwise ONLY cleared by the
  // next successful full fetch — but nothing triggers one for an IDLE remote
  // session: no turn boundary (no batch-completed), the browser WS never dropped
  // (so no `_ws:reconnected`), and the user hasn't switched sessions. So once the
  // host recovered in the background, the banner froze forever (it even keeps
  // showing the stale "Ns ago" from the last failed read).
  //
  // The banner literally says "Reconnecting…", so make it true: while stale,
  // retry a FULL fetch (never `?since=` — a delta read failure 502s and would
  // corrupt the cursor) on an interval. A healthy fetch adopts the fresh history
  // and clears the banner; a still-failing fetch degrades to stale again and we
  // keep waiting. Effect re-arms only when `stale` flips non-null → null → …,
  // so a persistent failure (e.g. bad SSH key) simply keeps polling every 10s.
  useEffect(() => {
    if (!sessionId || !stale || !enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    // 10s in prod; tests may shorten via window.__staleRetryMs to avoid a 10s wait.
    const retryMs = (typeof window !== 'undefined' && (window as unknown as { __staleRetryMs?: number }).__staleRetryMs) || 10_000;
    // visibleInterval: a hidden tab must not retry full history fetches every
    // 10s for hours (stale remote sessions are exactly the expensive fetch).
    const cancel = visibleInterval(() => {
      fetchSessionHistory(sessionId, { tail: HISTORY_TAIL_LIMIT, signal: controller.signal })
        .then((result) => {
          if (cancelled || result.stale) return; // still down — keep the banner, retry next tick
          // Live read recovered → adopt the fresh parse and drop the banner.
          setStale(null);
          setMessages(result.messages);
          setForkBoundaryIndex(result.forkBoundaryIndex);
          const fullCursor = result.cursor ?? result.messages.length;
          cursorRef.current = fullCursor;
          adoptOffset(result.messages.length, fullCursor, result.windowed);
          setHistoryCache(sessionId, {
            messages: result.messages,
            forkBoundaryIndex: result.forkBoundaryIndex,
            msgCount: fullCursor,
            baseOffset: Math.max(0, fullCursor - result.messages.length),
          });
        })
        .catch(() => { /* transient — keep the banner, retry next tick */ });
    }, retryMs);
    return () => { cancelled = true; controller.abort(); cancel(); };
  }, [sessionId, stale, enabled]);

  // "Show earlier" past the lazy tail: fetch the WHOLE history once, on demand.
  // The one deliberately unbounded fetch — user-initiated, so pinning a browser
  // connection for it is the user's explicit choice, not a background tax.
  const loadingFullRef = useRef(false);
  // olderWindowedRef mirrors the state for the guard below (a windowed payload
  // has baseOffset 0 — the count is unknown — yet older messages DO exist).
  const olderWindowedRef = useRef(false);
  olderWindowedRef.current = olderWindowed;
  const loadFullHistory = useCallback(() => {
    if (!sessionId || loadingFullRef.current
      || (baseOffsetRef.current === 0 && !olderWindowedRef.current)) return;
    loadingFullRef.current = true;
    setPhase2Pending(true);
    fetchSessionHistory(sessionId)
      .then((result) => {
        if (result.stale) return; // keep the tail view; banner path handles it
        setMessages(result.messages);
        setForkBoundaryIndex(result.forkBoundaryIndex);
        const fullCursor = result.cursor ?? result.messages.length;
        cursorRef.current = fullCursor;
        adoptOffset(result.messages.length, fullCursor, result.windowed);
        setHistoryCache(sessionId, {
          messages: result.messages,
          forkBoundaryIndex: result.forkBoundaryIndex,
          msgCount: fullCursor,
          baseOffset: Math.max(0, fullCursor - result.messages.length),
        });
      })
      .catch(() => { /* keep the tail view; user can retry */ })
      .finally(() => { loadingFullRef.current = false; setPhase2Pending(false); });
  }, [sessionId]);

  return { messages, loading, phase2Pending, error, stale, forkBoundaryIndex, olderHidden, olderWindowed, loadFullHistory };
}
