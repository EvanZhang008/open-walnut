import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { hasAppUpdater } from '@/hooks/useAppUpdate';

function inDesktopApp(): boolean {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { walnutChrome?: unknown } } }).webkit?.messageHandlers;
  return hasAppUpdater() || !!handlers?.walnutChrome;
}

interface InstalledUpdate { available: boolean; token?: string | null; version?: string | null; restarting?: boolean; error?: string | null }

export function useInstalledAppUpdate() {
  const [update, setUpdate] = useState<InstalledUpdate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const posting = useRef(false);
  useEffect(() => {
    if (!inDesktopApp()) return;
    let alive = true;
    let checking = false;
    const check = async () => {
      if (checking || posting.current) return;
      checking = true;
      const current = generation.current;
      try {
        const result = await apiGet<InstalledUpdate>('/api/system/desktop-update', undefined, { timeoutMs: 8000 });
        if (alive && current === generation.current) {
          setUpdate(result);
          if (result.restarting) {
            inFlight.current = true;
            setPending(true);
          } else if (result.error && inFlight.current) {
            inFlight.current = false;
            setPending(false);
            setError(result.error);
          } else if (!inFlight.current || !result.available) {
            inFlight.current = false;
            setPending(false);
          }
        }
      } catch { /* Keep the last known installed update during a reconnect. */ }
      finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const restart = async () => {
    if (inFlight.current || pending || !update?.token) return;
    inFlight.current = true;
    generation.current++;
    posting.current = true;
    setPending(true);
    setError(null);
    try {
      await apiPost('/api/system/desktop-update/restart', { token: update.token }, { timeoutMs: 8000 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart Walnut. Try again.');
      inFlight.current = false;
      setPending(false);
    } finally {
      posting.current = false;
    }
  };
  return { update, pending, error, restart, clearError: () => setError(null) };
}
