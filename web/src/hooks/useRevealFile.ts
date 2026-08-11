/**
 * useRevealFile — hand a LOCAL file/folder to the macOS desktop.
 *
 * Wraps POST /api/files/reveal with the one piece of state every caller needs:
 * whether the server can do it at all (`canReveal` — macOS console, not a cloud
 * replica). Menus/buttons hide themselves when false instead of offering an
 * action that always 400s. Remote (`host`) paths live on another machine, so
 * they're never revealable either.
 */
import { useCallback, useEffect, useState } from 'react';
import { revealLocalFile } from '@/api/files';
import { fetchCanRevealLocalFiles } from '@/api/config';
import { log } from '@/utils/log';

export function useRevealFile(host?: string): {
  canReveal: boolean;
  reveal: (path: string, mode: 'finder' | 'app') => void;
  error: string | null;
  clearError: () => void;
} {
  const [serverCan, setServerCan] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCanRevealLocalFiles().then((ok) => { if (!cancelled) setServerCan(ok); });
    return () => { cancelled = true; };
  }, []);

  const isRemote = !!host && host !== '__local__';
  const canReveal = serverCan && !isRemote;

  const reveal = useCallback((path: string, mode: 'finder' | 'app') => {
    setError(null);
    revealLocalFile(path, mode, host).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('file-reveal', 'reveal failed', { path, mode, host, error: msg });
      setError(msg);
    });
  }, [host]);

  return { canReveal, reveal, error, clearError: () => setError(null) };
}
