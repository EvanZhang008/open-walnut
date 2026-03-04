import { useState, useEffect } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import type { SessionHistoryMessage } from '@/types/session';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  error: string | null;
}

/**
 * Two-phase session history loading:
 * Phase 1: Read local streams file (~1ms) — instant display
 * Phase 2: Async fetch source of truth (may SSH, 3-5s) — silent update
 */
export function useSessionHistory(sessionId: string | null, version = 0): UseSessionHistoryReturn {
  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Phase 1: Fast local read (streams file, ~1ms)
    fetchSessionHistory(sessionId, { source: 'streams' })
      .then((msgs) => {
        if (cancelled) return;
        if (msgs.length > 0) setMessages(msgs);
        setLoading(false); // Always clear loading — even if empty, don't block on Phase 2
      })
      .catch(() => {
        // Phase 1 failure is non-critical — Phase 2 will still run
      })
      .finally(() => {
        if (cancelled) return;
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions)
        fetchSessionHistory(sessionId)
          .then((msgs) => {
            if (!cancelled) setMessages(msgs);
          })
          .catch((e: Error) => {
            if (!cancelled) setError(e.message);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      });

    return () => { cancelled = true; };
  }, [sessionId, version]);

  return { messages, loading, error };
}
