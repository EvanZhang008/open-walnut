import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';

/**
 * `ui.show_walnut_additions`: whether the session chat always shows what Walnut
 * added to a message (its notes in front of the words, its message hints, the
 * context it prepended). Default OFF: each message's footer then has a "Walnut
 * added" control that shows them for that one message (2026-10-29, the user:
 * hidden by default behind a "more", always visible for me).
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

function publish(v: boolean) {
  cached = v;
  for (const l of listeners) l(v);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchConfig()
    .then((c) => publish(c.ui?.show_walnut_additions === true))
    .catch(() => { /* keep whatever we have; default stays hidden */ })
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

/** Whether the chat always shows what Walnut added. Starts from the cached value (or hidden). */
export function useShowWalnutAdditions(): boolean {
  const [value, setValue] = useState<boolean>(cached ?? false);
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
