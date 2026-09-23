import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchConfig, updateConfig } from '@/api/config';
import { useEvent } from './useWebSocket';
import { rebaseOnto } from './config-rebase';

export function useSettingsConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // What the sections rendered with: a save's diff is measured against this.
  const baseRef = useRef<Config | null>(null);
  baseRef.current = config;
  // Reads can resolve out of order; only the newest one issued may paint, or an
  // older snapshot rolls the page back and a pick of the value it wrongly shows
  // is skipped as "no change".
  const readGen = useRef(0);
  const read = useCallback(async (): Promise<Config | null> => {
    const mine = ++readGen.current;
    const c = await fetchConfig();
    return mine === readGen.current ? c : null;
  }, []);

  const load = useCallback(async () => {
    try {
      const c = await read();
      if (c) setConfig(c);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [read]);

  useEffect(() => { load(); }, [load]);

  // Another window or an agent changed config: show it. Only a real change
  // replaces the object, because every section re-syncs its local fields on a
  // new `config`, and our own save's echo must not reset what is being typed.
  useEvent('config:changed', () => {
    void read().then((fresh) => {
      if (!fresh) return;
      setConfig((cur) => (cur && JSON.stringify(cur) === JSON.stringify(fresh) ? cur : fresh));
    }).catch(() => { /* the next save or reload re-reads */ });
  });

  /** Save a partial config (top-level key merge) and re-fetch. */
  const saveSection = useCallback(async (partial: Partial<Config>) => {
    const base = baseRef.current;
    const payload = base ? rebaseOnto(partial, base, await fetchConfig()) : partial;
    await updateConfig(payload);
    const refreshed = await read();
    if (refreshed) setConfig(refreshed);
  }, [read]);

  return { config, loading, error, saveSection, reload: load };
}
