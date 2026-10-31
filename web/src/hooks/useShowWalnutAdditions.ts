import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';

/**
 * `ui.show_walnut_additions`: whether the session chat always shows what Walnut
 * added to a message (its notes in front of the words, its message hints, the
 * context it prepended). Default ON (2026-10-31, the user: "the user can see these
 * is better"); turned off, each message's footer has a "Walnut added" control that
 * shows them for that one message.
 *
 * One app-wide value read by every chat row: one cached value, one config fetch
 * and one `config:changed` subscription for the whole page (the useShowPriority
 * pattern).
 */

let cached: boolean | null = null;
let inflight: Promise<void> | null = null;
let wsBound = false;
let lastSelfChange = 0;
const listeners = new Set<(v: boolean) => void>();

// Our own write echoes back as config:changed ~2s later; ignore that window.
const SELF_CHANGE_COOLDOWN = 3000;

// The last value this browser read, so a person who turned it off never sees
// every chat's additions flash on while the config loads.
const LAST_KEY = 'walnut:show-walnut-additions';

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
    .then((c) => publish(c.ui?.show_walnut_additions !== false))
    .catch(() => { /* keep whatever we have; default stays shown */ })
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

/** Whether the chat always shows what Walnut added. Starts from the cached value (or the last one read here, or shown). */
export function useShowWalnutAdditions(): boolean {
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

/** Flip the flag: local echo to every mounted row first, then persist into the `ui` block. */
export function setShowWalnutAdditions(v: boolean): void {
  publish(v);
  lastSelfChange = Date.now();
  // updateConfig replaces the whole `ui` object, so merge into what is there.
  fetchConfig()
    .then((c) => updateConfig({ ui: { ...c.ui, show_walnut_additions: v } }))
    .catch(() => {});
}
