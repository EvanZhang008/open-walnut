import { useEffect, useState } from 'react';
import { fetchConfig, updateConfigKeys } from '@/api/config';
import { wsClient } from '@/api/ws';
import type { TaskbarLeaving, TaskbarSettings } from '@/pages/sessionTaskbar';
import { DEFAULT_TASKBAR_SETTINGS, taskbarSettingsOf } from '@/pages/sessionTaskbar';

/**
 * The taskbar's two switches (2026-11-10, the user: "add a setting for this ... have 2 otpions I
 * want to play around it"), Settings > General: `ui.taskbar_hide_recent_only` (no bar when it
 * would hold only Recent, default on) and `ui.taskbar_leaving` (where a session that leaves the
 * strip without a Minimize goes: 'recent', or 'chips' as before Recent existed). Kept in the
 * config, so every window and the Mac app read the same; applied at once, no reload. One cached
 * value, one config fetch, one `config:changed` subscription, the last read in localStorage, the
 * way useNextAfterComplete keeps its own.
 */

let cached: TaskbarSettings | null = null;
let inflight: Promise<void> | null = null;
let wsBound = false;
let lastSelfChange = 0;
const listeners = new Set<(v: TaskbarSettings) => void>();

// Our own write echoes back as config:changed ~2s later; ignore that window.
const SELF_CHANGE_COOLDOWN = 3000;
const LAST_KEY = 'walnut:taskbar-settings';

function lastRead(): TaskbarSettings {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? taskbarSettingsOf(JSON.parse(raw)) : DEFAULT_TASKBAR_SETTINGS;
  } catch { return DEFAULT_TASKBAR_SETTINGS; }
}

function publish(v: TaskbarSettings) {
  cached = v;
  try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  for (const l of listeners) l(v);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchConfig()
    .then((c) => publish(taskbarSettingsOf({ hideRecentOnly: c.ui?.taskbar_hide_recent_only, leaving: c.ui?.taskbar_leaving })))
    .catch(() => { /* keep whatever we have */ })
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

/** The values now, for code that runs outside render (the store's strip rule). */
export function taskbarSettingsNow(): TaskbarSettings {
  return cached ?? lastRead();
}

export function useTaskbarSettings(): TaskbarSettings {
  const [value, setValue] = useState<TaskbarSettings>(() => cached ?? lastRead());
  useEffect(() => {
    listeners.add(setValue);
    bindConfigChanges();
    if (cached === null) void load();
    else setValue(cached);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

function write(next: TaskbarSettings): void {
  publish(next);
  lastSelfChange = Date.now();
  // Only this key: a write that sends the section read earlier would put back a sibling
  // another window changed since (api/config.ts updateConfigKeys).
  updateConfigKeys('ui', { taskbar_hide_recent_only: next.hideRecentOnly, taskbar_leaving: next.leaving }).catch(() => {});
}

export function setTaskbarHideRecentOnly(v: boolean): void {
  write({ ...taskbarSettingsNow(), hideRecentOnly: v });
}

export function setTaskbarLeaving(v: TaskbarLeaving): void {
  write({ ...taskbarSettingsNow(), leaving: v });
}
