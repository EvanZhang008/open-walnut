import { useEffect, useState } from 'react';
import { apiGet } from '@/api/client';
import type { SessionMode } from '@open-walnut/core';

/** A preview belongs to its host and folder. A late answer never labels another draft. */
export function useClaudeLaunchMode(host: string | null | undefined, cwd: string | undefined, enabled: boolean): SessionMode {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const reload = () => setNonce(n => n + 1);
    window.addEventListener('walnut:claude-default-mode-changed', reload);
    window.addEventListener('focus', reload);
    return () => { window.removeEventListener('walnut:claude-default-mode-changed', reload); window.removeEventListener('focus', reload); };
  }, []);
  const [mode, setMode] = useState<SessionMode>('default');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setMode('default');
    apiGet<{ mode: SessionMode }>('/api/engines/claude/launch-mode', {
      host: host || '__local__', ...(cwd ? { cwd } : {}),
    }, { signal: controller.signal, timeoutMs: 7000 }).then(result => {
      if (!controller.signal.aborted && ['plan', 'default', 'dontAsk', 'accept', 'auto', 'bypass'].includes(result.mode)) setMode(result.mode);
    }).catch(() => {});
    return () => controller.abort();
  }, [host, cwd, enabled, nonce]);
  return mode;
}
