import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';

/**
 * `ui.show_priority` — whether the UI draws task priority at all (rows, cards,
 * detail views, kebab menus, filters, pickers). Default OFF: most people never
 * use the four-level priority, and every surface that showed it was one more
 * badge to read past. Priority stays stored and sortable regardless; this flag
 * only decides whether it is drawn.
 *
 * ONE app-wide value read by hundreds of rows, so the hook is deliberately not a
 * fetch-per-mount: the module owns a single cached value, a single config fetch
 * (deduped while in flight) and a single `config:changed` subscription. Each
 * mounted instance just subscribes to the cache. `setShowPriority` echoes the
 * new value to every instance before the config write lands, so the Settings
 * toggle flips the whole page in the same tick.
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
    .then((c) => publish(c.ui?.show_priority === true))
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

/** Whether task priority should be drawn. Starts from the cached value (or hidden). */
export function useShowPriority(): boolean {
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

/**
 * Same flag, but says 'unknown' until the first config read lands (the module
 * cache starts at null). For callers that must not DECIDE anything from the
 * "hidden" placeholder, like the draft parse, which would otherwise drop a
 * priority on a machine that shows it.
 */
export function useShowPriorityState(): boolean | 'unknown' {
  const [value, setValue] = useState<boolean | 'unknown'>(cached ?? 'unknown');
  useEffect(() => {
    listeners.add(setValue);
    bindConfigChanges();
    if (cached === null) void load();
    else setValue(cached);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

/** Flip the flag: local echo to every mounted instance first, then persist. */
export function setShowPriority(v: boolean): void {
  publish(v);
  lastSelfChange = Date.now();
  // Merge into the existing ui block so sibling keys (session_panels, …) survive:
  // updateConfig replaces the whole `ui` object, not individual sub-keys.
  fetchConfig()
    .then((c) => updateConfig({ ui: { ...c.ui, show_priority: v } }))
    .catch(() => {});
}

/** Test seam: reset the module cache so a test starts from "not fetched". */
export function _resetShowPriorityForTests(): void {
  cached = null;
  inflight = null;
  lastSelfChange = 0;
}
