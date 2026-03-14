import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchConfig, updateConfig } from '@/api/config';

export function useSettingsConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await fetchConfig();
      setConfig(c);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Save a partial config (top-level key merge) and re-fetch. */
  const saveSection = useCallback(async (partial: Partial<Config>) => {
    await updateConfig(partial);
    // Re-fetch to get the merged result
    const refreshed = await fetchConfig();
    setConfig(refreshed);
  }, []);

  return { config, loading, error, saveSection, reload: load };
}
