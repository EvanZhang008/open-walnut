import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';

/**
 * `ui.next_after_complete`: completing a task from its session column (or with mod+shift+D)
 * goes on to the next task that needs the person (pages/useColumnCompleteClose.ts). Default ON.
 * One app-wide value, kept the way useShowWalnutAdditions keeps its own: one cached value,
 * one config fetch, one `config:changed` subscription, the last read in localStorage.
 */

let cached: boolean | null = null;
let inflight: Promise<void> | null = null;
let wsBound = false;
let lastSelfChange = 0;
const listeners = new Set<(v: boolean) => void>();

// Our own write echoes back as config:changed ~2s later; ignore that window.
const SELF_CHANGE_COOLDOWN = 3000;
const LAST_KEY = 'walnut:next-after-complete';

function lastRead(): boolean {
  try { return localStorage.getItem(LAST_KEY) !== '0'; } catch { return true; }
}

function publish(v: boolean) {
  cached = v;
  try { localStorage.setItem(LAST_KEY, v ? '1' : '0'); } catch { /* private mode */ }
  for (const l of listeners) l(v);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchConfig()
    .then((c) => publish(c.ui?.next_after_complete !== false))
    .catch(() => { /* keep whatever we have; default stays on */ })
    .finally(() => { inflight = null; });
  return inflight;
}

function bindConfigChanges() {
  if (wsBound) return;
  wsBound = true;
  wsClient.onEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'ui') return;
    if (Date.now() - lastSelfChange < SELF_CHANGE_COOLDOWN) return;
    void load();
  });
}

/** The value now, for a handler that runs outside render. */
export function nextAfterCompleteNow(): boolean {
  return cached ?? lastRead();
}

export function useNextAfterComplete(): boolean {
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

export function setNextAfterComplete(v: boolean): void {
  publish(v);
  lastSelfChange = Date.now();
  // updateConfig replaces the whole `ui` object, so merge into what is there.
  fetchConfig()
    .then((c) => updateConfig({ ui: { ...c.ui, next_after_complete: v } }))
    .catch(() => {});
}
