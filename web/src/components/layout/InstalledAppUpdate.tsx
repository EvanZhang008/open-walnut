import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { hasAppUpdater } from '@/hooks/useAppUpdate';

function inDesktopApp(): boolean {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { walnutChrome?: unknown } } }).webkit?.messageHandlers;
  return hasAppUpdater() || !!handlers?.walnutChrome;
}

interface InstalledUpdate {
  available: boolean; token?: string | null; version?: string | null; restarting?: boolean; error?: string | null;
  /** How many app windows are open; the helper refuses more than one unless the restart is forced. */
  windows?: number;
}

/** A restart either ends this page or fails within seconds: look again soon while one is pending. */
const POLL_MS = 30_000;
const PENDING_POLL_MS = 2_000;

export function useInstalledAppUpdate() {
  const [update, setUpdate] = useState<InstalledUpdate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const posting = useRef(false);
  const lookSoon = useRef<() => void>(() => {});
  useEffect(() => {
    if (!inDesktopApp()) return;
    let alive = true;
    let checking = false;
    const check = async () => {
      if (checking || posting.current) return;
      checking = true;
      const current = generation.current;
      try {
        // `notice=1`: this page shows the update in the bottom notice. A page from
        // before that answer (its sidebar item) is told nothing, so an old window
        // shows only its own "Walnut updated · Reload" notice, which loads this one.
        const result = await apiGet<InstalledUpdate>('/api/system/desktop-update?notice=1', undefined, { timeoutMs: 8000 });
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
    // One chain of looks: a look asked for while one is running only shortens the next wait.
    let timer = 0;
    let looking = false;
    const loop = async () => {
      looking = true;
      await check();
      looking = false;
      if (alive) timer = window.setTimeout(() => { void loop(); }, inFlight.current ? PENDING_POLL_MS : POLL_MS);
    };
    lookSoon.current = () => {
      if (!alive || looking) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void loop(); }, PENDING_POLL_MS);
    };
    void loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  /** `force`: every window was checked (or the user chose to restart anyway), so the helper skips its window count. */
  // The latest answer, so a restart asked for while the page was checking uses its token.
  const latest = useRef<InstalledUpdate | null>(null);
  latest.current = update;
  const restart = async (force = false) => {
    const token = latest.current?.token;
    if (inFlight.current || !token) return;
    inFlight.current = true;
    generation.current++;
    posting.current = true;
    setPending(true);
    setError(null);
    try {
      await apiPost('/api/system/desktop-update/restart', { token, force }, { timeoutMs: 8000 });
      lookSoon.current();
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
