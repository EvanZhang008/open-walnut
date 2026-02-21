import { useState, useEffect } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import type { SessionHistoryMessage } from '@/types/session';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  error: string | null;
}

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

    return () => { cancelled = true; };
  }, [sessionId, version]);

  return { messages, loading, error };
}
