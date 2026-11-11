import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSessionPlan, type SessionPlanResponse } from '@/api/sessions';

interface UseSessionPlanResult {
  plan: SessionPlanResponse | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch plan content from the API. */
  refresh: () => Promise<void>;
}

/**
 * Lazy-load plan content for a session.
 * Only fetches when shouldFetch is true (e.g. plan session or from_plan execution session).
 */
export function useSessionPlan(sessionId: string | undefined, shouldFetch: boolean): UseSessionPlanResult {
  // Keyed by session, so a switch never shows the old plan as the new session's.
  const [held, setHeld] = useState<{ sessionId: string; plan: SessionPlanResponse | null } | null>(null);
  const setPlanFor = useCallback((id: string, plan: SessionPlanResponse | null) => setHeld({ sessionId: id, plan }), []);
  const plan = held && held.sessionId === sessionId ? held.plan : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const doFetch = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSessionPlan(id);
      // Guard against stale response if sessionId changed during fetch
      if (sessionIdRef.current === id) {
        setPlanFor(id, result);
      }
    } catch (err) {
      if (sessionIdRef.current === id) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (sessionIdRef.current === id) {
        setLoading(false);
      }
    }
  }, [setPlanFor]);

  useEffect(() => {
    if (!sessionId || !shouldFetch) {
      setHeld(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSessionPlan(sessionId).then((result) => {
      if (cancelled) return;
      setPlanFor(sessionId, result);
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sessionId, shouldFetch, setPlanFor]);

  return { plan, loading, error, refresh: doFetch };
}
