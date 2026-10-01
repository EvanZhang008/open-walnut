/**
 * Which tags a task shows (src/core/tag-display-rules.ts), for every surface that draws tag
 * pills. ONE copy per page: the rules are read once, kept in memory and in localStorage (so a
 * reload never flashes a hidden tag before the read answers), and read again when the server
 * says they changed (`task:tag-display-changed`) or the socket reconnects.
 */

import { useSyncExternalStore } from 'react';
import { apiGet, apiPut } from '@/api/client';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import {
  BUILTIN_TAG_DISPLAY_RULES,
  compileTagDisplay,
  type CompiledTagDisplay,
  type TagDisplay,
  type TagDisplayRule,
} from '../../../src/core/tag-display-rules';

export type { TagDisplay, TagDisplayRule } from '../../../src/core/tag-display-rules';

const STORAGE_KEY = 'walnut:tag-display.v1';
const PATH = '/api/v1/tasks/meta/tag-display';

interface Snapshot {
  rules: readonly TagDisplayRule[];
  compiled: CompiledTagDisplay;
  /** True once the server answered in this page. */
  loaded: boolean;
}

function snapshotOf(rules: readonly TagDisplayRule[], loaded: boolean): Snapshot {
  return { rules, compiled: compileTagDisplay(rules), loaded };
}

function readStored(): readonly TagDisplayRule[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (Array.isArray(parsed)) return parsed as TagDisplayRule[];
  } catch { /* storage unavailable or malformed: Walnut's own rule only */ }
  return BUILTIN_TAG_DISPLAY_RULES;
}

let snapshot: Snapshot = snapshotOf(readStored(), false);
const listeners = new Set<() => void>();
let wired = false;
let inflight: Promise<void> | null = null;
// Bumped by every write, so a read that started before it cannot put the old rules back.
let generation = 0;

function publish(rules: readonly TagDisplayRule[], loaded: boolean): void {
  snapshot = snapshotOf(rules, loaded);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rules)); } catch { /* the page still has them */ }
  for (const listener of listeners) listener();
}

export function loadTagDisplay(): Promise<void> {
  if (inflight) return inflight;
  const started = generation;
  inflight = apiGet<{ rules: TagDisplayRule[] }>(PATH)
    .then((res) => {
      if (started === generation && Array.isArray(res?.rules)) publish(res.rules, true);
    })
    .catch((err: unknown) => {
      // Keep the last known rules: a hidden tag must not reappear because one read failed.
      log.warn('tag-display', 'could not read the tag display rules', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function wire(): void {
  if (wired) return;
  wired = true;
  wsClient.onEvent('task:tag-display-changed', () => { void loadTagDisplay(); });
  wsClient.onEvent('_ws:reconnected', () => { void loadTagDisplay(); });
  void loadTagDisplay();
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): Snapshot => snapshot;

/** The rules in force, compiled; re-renders when they change. */
export function useTagDisplay(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The user's rule for a tag or `<namespace>:*` (null removes it). Applied at once, then
 * confirmed by the server's answer; a refused write puts the rules back and rethrows.
 */
export async function setTagDisplay(pattern: string, display: TagDisplay | null): Promise<void> {
  generation++;
  const before = snapshot.rules;
  const others = before.filter((rule) => !(rule.source === 'user' && rule.pattern === pattern));
  publish(display === null ? others : [...others, { pattern, display, source: 'user' }], snapshot.loaded);
  const mine = generation;
  try {
    const res = await apiPut<{ rules: TagDisplayRule[] }>(PATH, { pattern, display });
    if (mine === generation && Array.isArray(res?.rules)) publish(res.rules, true);
  } catch (err) {
    if (mine === generation) publish(before, snapshot.loaded);
    throw err;
  }
}

/** Test seam: forget the page's copy. */
export function _resetTagDisplayStoreForTesting(): void {
  snapshot = snapshotOf(BUILTIN_TAG_DISPLAY_RULES, false);
  generation = 0;
  inflight = null;
}
