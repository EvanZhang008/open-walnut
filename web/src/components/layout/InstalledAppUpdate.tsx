import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { hasAppUpdater } from '@/hooks/useAppUpdate';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { hasUnsavedWork } from '@/utils/stale-assets';
import '@/styles/sidebar-app-update.css';

function inDesktopApp(): boolean {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { walnutChrome?: unknown } } }).webkit?.messageHandlers;
  return hasAppUpdater() || !!handlers?.walnutChrome;
}

interface InstalledUpdate { available: boolean; token: string | null; version: string | null; restarting?: boolean; error?: string | null }

export function InstalledAppUpdate() {
  const [update, setUpdate] = useState<InstalledUpdate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!inDesktopApp()) return;
    let alive = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await apiGet<InstalledUpdate>('/api/system/desktop-update', undefined, { timeoutMs: 8000 });
        if (alive) {
          setUpdate(result);
          if (result?.error && inFlight.current) {
            inFlight.current = false;
            setPending(false);
            setError(result.error);
          }
        }
      } catch { /* Keep the last known installed update during a reconnect. */ }
      finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if ((!update?.available || !update.token) && !error) return null;
  const restart = async () => {
    if (inFlight.current || !update?.token) return;
    if (hasUnsavedWork()) {
      setConfirming(false);
      setError('Save your edits and send or clear unsent messages before restarting.');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setConfirming(false);
    setError(null);
    try {
      await apiPost('/api/system/desktop-update/restart', { token: update.token }, { timeoutMs: 8000 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart Walnut. Try again.');
      inFlight.current = false;
      setPending(false);
    }
  };
  return <>
    {update?.available && <button type="button" className={`sidebar-link sidebar-app-update${pending ? ' is-pending' : ''}`}
      data-testid="installed-app-update" title="A new app build is installed. Restart to use it."
      aria-label={pending ? 'Restarting Walnut' : 'Restart to use new version'} aria-disabled={pending || undefined}
      onClick={() => { if (!pending) { setError(null); setConfirming(true); } }}>
      <svg className="app-update-icon" viewBox="0 0 22 22" aria-hidden="true"><circle className="app-update-glyph" cx="11" cy="11" r="8"/><path className="app-update-glyph" d="M11 10v6M11 6.5v.5"/></svg>
      <span className="sidebar-label">{pending ? 'Restarting…' : 'Restart to use new version'}</span>
    </button>}
    {confirming && <ConfirmDialog title="Restart to use the installed update?"
      message="Walnut will close and reopen with the new app. Running sessions keep going. Save edits and send or clear unsent messages first."
      confirmLabel="Restart Now" cancelLabel="Not Now" onCancel={() => setConfirming(false)} onConfirm={() => { void restart(); }} />}
    {error && <ConfirmDialog title="Could not restart Walnut" message={error} confirmLabel="OK" onCancel={() => setError(null)} onConfirm={() => setError(null)} />}
  </>;
}
