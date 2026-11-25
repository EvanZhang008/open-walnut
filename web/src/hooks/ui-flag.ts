import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchConfig, updateConfigKeys } from '@/api/config';
import { wsClient } from '@/api/ws';

type UiFlagKey = { [K in keyof NonNullable<Config['ui']>]-?: NonNullable<NonNullable<Config['ui']>[K]> extends boolean ? K : never }[keyof NonNullable<Config['ui']>];

export interface UiFlag {
  /** The value, for a view; starts from the page's copy (or the last one read here, or the fallback). */
  use(): boolean;
  /** The same value outside a render, for a handler. */
  now(): boolean;
  /** Flip it: every mounted view first, then the one key in the `ui` block. */
  set(v: boolean): void;
}

/**
 * One switch of the `ui` block, kept app-wide: one cached value read by every row, one
 * config fetch (joined while it is out), one `config:changed` subscription, the last read in
 * localStorage so a value never flashes to its default while the config loads. Our own write
 * echoes back as `config:changed` about 2 s later; that window is ignored.
 *
 * `fallback`: the value while nothing was ever read here. `whenUnset`: what an unset key means,
 * when that is a fact of the server rather than a constant (read once with the config).
 */
export function createUiFlag(opts: {
  key: UiFlagKey;
  storageKey: string;
  fallback: boolean;
  whenUnset?: () => Promise<boolean>;
}): UiFlag {
  const { key, storageKey, fallback } = opts;
  let cached: boolean | null = null;
  let inflight: Promise<void> | null = null;
  let wsBound = false;
  let lastSelfChange = 0;
  const listeners = new Set<(v: boolean) => void>();
  const SELF_CHANGE_COOLDOWN = 3000;

  const lastRead = (): boolean => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === '1' ? true : v === '0' ? false : fallback;
    } catch { return fallback; }
  };
  const publish = (v: boolean) => {
    cached = v;
    try { localStorage.setItem(storageKey, v ? '1' : '0'); } catch { /* private mode */ }
    for (const l of listeners) l(v);
  };
  const load = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = fetchConfig()
      .then(async (c) => {
        const v = c.ui?.[key];
        publish(typeof v === 'boolean' ? v : opts.whenUnset ? await opts.whenUnset() : fallback);
      })
      .catch(() => { /* keep whatever we have */ })
      .finally(() => { inflight = null; });
    return inflight;
  };
  const bindConfigChanges = () => {
    if (wsBound) return;
    wsBound = true;
    wsClient.onEvent('config:changed', (data: unknown) => {
      const { key: changed } = (data ?? {}) as { key?: string };
      if (changed && changed !== 'ui') return;
      if (Date.now() - lastSelfChange < SELF_CHANGE_COOLDOWN) return;
      void load();
    });
  };

  function useFlag(): boolean {
    const [value, setValue] = useState<boolean>(() => cached ?? lastRead());
    useEffect(() => {
      listeners.add(setValue);
      bindConfigChanges();
      if (cached === null) void load();
      else setValue(cached);
      return () => { listeners.delete(setValue); };
    }, []);
    return value;
  }

  return {
    use: useFlag,
    now: () => cached ?? lastRead(),
    set(v: boolean) {
      publish(v);
      lastSelfChange = Date.now();
      // Only this key: a write that sends the section read earlier would put back a sibling
      // another window changed since (api/config.ts updateConfigKeys).
      updateConfigKeys('ui', { [key]: v } as Partial<NonNullable<Config['ui']>>).catch(() => {});
    },
  };
}
