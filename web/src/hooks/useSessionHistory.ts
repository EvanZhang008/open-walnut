import { useState, useEffect } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import { perf } from '@/utils/perf-logger';
import type { SessionHistoryMessage } from '@/types/session';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  /** Phase 2 (SSH/full fetch) still in progress — true between Phase 1 completion and Phase 2 completion */
  phase2Pending: boolean;
  error: string | null;
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
 */
export function useSessionHistory(sessionId: string | null, version = 0): UseSessionHistoryReturn {
  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [phase2Pending, setPhase2Pending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      setPhase2Pending(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setPhase2Pending(true);
    setError(null);
    const sid = sessionId.substring(0, 8);

    // Phase 1: Fast local read (streams file, ~1ms)
    const endP1 = perf.start(`session:streams:${sid}`);
    fetchSessionHistory(sessionId, { source: 'streams' })
      .then((msgs) => {
        if (cancelled) return;
        endP1(`${msgs.length} msgs`);
        diagnoseOrdering('P1:streams', sid, msgs);
        if (msgs.length > 0) setMessages(msgs);
        setLoading(false); // Always clear loading — even if empty, don't block on Phase 2
      })
      .catch(() => {
        endP1('error');
      })
      .finally(() => {
        if (cancelled) return;
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions)
        const endP2 = perf.start(`session:full:${sid}`);
        fetchSessionHistory(sessionId)
          .then((msgs) => {
            if (!cancelled) {
              endP2(`${msgs.length} msgs`);
              diagnoseOrdering('P2:full', sid, msgs);
              setMessages(msgs);
            }
          })
          .catch((e: Error) => {
            if (!cancelled) { endP2('error'); setError(e.message); }
          })
          .finally(() => {
            if (!cancelled) { setLoading(false); setPhase2Pending(false); }
          });
      });

    return () => { cancelled = true; };
  }, [sessionId, version]);

  return { messages, loading, phase2Pending, error };
}
