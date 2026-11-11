import { useState, useEffect, useCallback, useRef } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchConfig, fetchFreshConfig, updateConfig } from '@/api/config';
import { useEvent } from './useWebSocket';
import { OwnWrites, rebaseOnto } from './config-rebase';

export function useSettingsConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  // The last of this page's writes the painted config reflects (see OwnWrites).
  const [configMark, setConfigMark] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // What the sections rendered with: a save's diff is measured against this.
  const baseRef = useRef<Config | null>(null);
  baseRef.current = config;
  const baseMarkRef = useRef(0);
  baseMarkRef.current = configMark;
  const own = useRef(new OwnWrites());
  // Reads can resolve out of order; only the newest one issued may paint, or an
  // older snapshot rolls the page back and a pick of the value it wrongly shows
  // is skipped as "no change".
  const readGen = useRef(0);
  const read = useCallback(async (): Promise<{ c: Config; mark: number } | null> => {
    const mine = ++readGen.current;
    const mark = own.current.mark();
    const c = await fetchConfig();
    return mine === readGen.current ? { c, mark } : null;
  }, []);
  const paint = useCallback((r: { c: Config; mark: number }, keepSame = false) => {
    setConfig((cur) => (keepSame && cur && JSON.stringify(cur) === JSON.stringify(r.c) ? cur : r.c));
    setConfigMark((m) => Math.max(m, r.mark));
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await read();
      if (r) paint(r);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [read, paint]);

  useEffect(() => { load(); }, [load]);

  // Another window or an agent changed config: show it. Only a real change
  // replaces the object, because every section re-syncs its local fields on a
  // new `config`, and our own save's echo must not reset what is being typed.
  useEvent('config:changed', () => {
    void read().then((r) => {
      if (r) paint(r, true);
    }).catch(() => { /* the next save or reload re-reads */ });
  });

  // Saves run one at a time: each rebases onto a read taken after the previous
  // write landed. Two in flight at once would both read the same config and the
  // later PUT would write the earlier one's field back (a token typed, then Add
  // model clicked before the blur save finished).
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Save a partial config (top-level key merge) and re-fetch. */
  const saveSection = useCallback((partial: Partial<Config>) => {
    const base = baseRef.current;
    const baseMark = baseMarkRef.current;
    const run = async () => {
      // Laid over the server's config as of now (never a shared answer a few seconds old),
      // measured against what the section saw plus this page's writes since it was painted.
      const seen = base ? own.current.seen(base, baseMark) : null;
      const payload = seen ? rebaseOnto(partial, seen, await fetchFreshConfig()) : partial;
      await updateConfig(payload);
      if (seen) own.current.wrote(partial, seen);
      const refreshed = await read();
      if (refreshed) paint(refreshed);
    };
    const done = queue.current.then(run, run);
    queue.current = done.catch(() => {});
    return done;
  }, [read, paint]);

  return { config, loading, error, saveSection, reload: load };
}
