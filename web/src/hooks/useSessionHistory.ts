import { useState, useEffect, useRef } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import { perf } from '@/utils/perf-logger';
import { log } from '@/utils/log';
import type { SessionHistoryMessage } from '@/types/session';
import {
  trackSession,
  getHistoryCache,
  setHistoryCache,
} from '@/cache/session-cache';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  /** Phase 2 (SSH/full fetch) still in progress — true between Phase 1 completion and Phase 2 completion */
  phase2Pending: boolean;
  error: string | null;
  /** Index in messages[] where the fork boundary is (source messages end, forked messages start) */
  forkBoundaryIndex?: number;
  /** The most recent turn's delta (messages appended by the last refetch). Consumers
   *  use it as evidence to promote (remove) the matching streaming blocks — deletion
   *  is proven, never blind. Monotonic token `deltaSeq` lets consumers react to each
   *  new delta even when its contents repeat. */
  lastDelta: SessionHistoryMessage[];
  deltaSeq: number;
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
  const [forkBoundaryIndex, setForkBoundaryIndex] = useState<number | undefined>(undefined);
  const [lastDelta, setLastDelta] = useState<SessionHistoryMessage[]>([]);
  const [deltaSeq, setDeltaSeq] = useState(0);

  // Cursor = combined-message count the client has synced to. Advances on every
  // successful full/delta fetch; reset on session switch. Held in a ref so a
  // `version` bump (turn boundary) reuses it without re-running the initial load.
  const cursorRef = useRef(0);
  // messages[] mirror so the delta-append updater has the current base without a
  // stale closure (version-effect reads it synchronously).
  const messagesRef = useRef<SessionHistoryMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      setPhase2Pending(false);
      setError(null);
      setForkBoundaryIndex(undefined);
      cursorRef.current = 0;
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setError(null);
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
      fetchSessionHistory(sessionId, { since, signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          endP2(`+${result.messages.length} msgs (delta=${result.delta})`);
          if (result.delta) {
            // Incremental: append the new turn's messages.
            if (result.messages.length > 0) {
              const base = messagesRef.current;
              const merged = [...base, ...result.messages];
              // Consistency guard against duplication: the delta is server.messages.slice(since),
              // so a correct append yields exactly `cursor` messages. If it doesn't, our cached
              // prefix diverged from the server's current parse — this happens when a COMPACTION
              // rewrote history (the JSONL gains summary lines and the parse shifts), so `since`
              // no longer lines up with the same message boundary. Blindly appending then renders
              // the overlap TWICE (the "compact still shows old messages below" bug, client side).
              // On mismatch, re-fetch the FULL history to rebuild from a clean base instead.
              const expected = result.cursor ?? merged.length;
              if (result.cursor != null && merged.length !== expected) {
                log.warn('session-history', `delta merge length mismatch — rebuilding (had=${base.length} +delta=${result.messages.length} → ${merged.length}, server cursor=${expected})`, { sessionId });
                fetchSessionHistory(sessionId, { signal: controller.signal })
                  .then((full) => {
                    if (cancelled) return;
                    setMessages(full.messages);
                    setForkBoundaryIndex(full.forkBoundaryIndex);
                    cursorRef.current = full.cursor ?? full.messages.length;
                    setHistoryCache(sessionId, {
                      messages: full.messages,
                      forkBoundaryIndex: full.forkBoundaryIndex,
                      msgCount: full.cursor ?? full.messages.length,
                    });
                    setLastDelta(full.messages);
                    setDeltaSeq((s) => s + 1);
                  })
                  .catch(() => { /* keep current view; next turn retries */ });
                return;
              }
              setMessages(merged);
              setHistoryCache(sessionId, {
                messages: merged,
                forkBoundaryIndex: result.forkBoundaryIndex ?? forkBoundaryIndex,
                msgCount: result.cursor ?? merged.length,
              });
            }
            // Advance cursor even on an empty delta (nothing new yet — archive lagging).
            cursorRef.current = result.cursor ?? cursorRef.current;
            // Publish the delta (possibly empty) as promotion evidence for the consumer.
            setLastDelta(result.messages);
            setDeltaSeq((s) => s + 1);
          } else {
            // Server rebuilt (since out of range) → full replace.
            diagnoseOrdering('refetch-full', sid, result.messages);
            setMessages(result.messages);
            setForkBoundaryIndex(result.forkBoundaryIndex);
            cursorRef.current = result.cursor ?? result.messages.length;
            setHistoryCache(sessionId, {
              messages: result.messages,
              forkBoundaryIndex: result.forkBoundaryIndex,
              msgCount: result.cursor ?? result.messages.length,
            });
            setLastDelta(result.messages);
            setDeltaSeq((s) => s + 1);
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
      setLoading(false);
      // Offscreen column: show cache, skip the background SSH re-verify until visible.
      if (!enabled) return () => { cancelled = true; controller.abort(); };
      setPhase2Pending(true);

      const endP2 = perf.start(`session:full:${sid}`);
      fetchSessionHistory(sessionId, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          endP2(`${result.messages.length} msgs`);
          diagnoseOrdering('cache-verify', sid, result.messages);
          setHistoryCache(sessionId, {
            messages: result.messages,
            forkBoundaryIndex: result.forkBoundaryIndex,
            msgCount: result.cursor ?? result.messages.length,
          });
          cursorRef.current = result.cursor ?? result.messages.length;
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

    // Phase 1: Fast local read (streams file, ~1ms)
    const endP1 = perf.start(`session:streams:${sid}`);
    fetchSessionHistory(sessionId, { source: 'streams', signal: controller.signal })
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
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions)
        const endP2 = perf.start(`session:full:${sid}`);
        fetchSessionHistory(sessionId, { signal: controller.signal })
          .then((result) => {
            if (!cancelled) {
              endP2(`${result.messages.length} msgs`);
              diagnoseOrdering('P2:full', sid, result.messages);
              setMessages(result.messages);
              setForkBoundaryIndex(result.forkBoundaryIndex);
              cursorRef.current = result.cursor ?? result.messages.length;
              // Write to cache for next visit
              setHistoryCache(sessionId, {
                messages: result.messages,
                forkBoundaryIndex: result.forkBoundaryIndex,
                msgCount: result.cursor ?? result.messages.length,
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

  return { messages, loading, phase2Pending, error, forkBoundaryIndex, lastDelta, deltaSeq };
}
