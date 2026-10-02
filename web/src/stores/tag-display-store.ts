/**
 * How a task's tags show (src/core/tag-display-rules.ts), for every surface that draws tag
 * pills. ONE copy per page: the rules are read once, kept in memory and in localStorage (so a
 * reload never flashes a hidden tag before the read answers), and read again when the server
 * says they changed (`task:tag-display-changed`) or the socket reconnects.
 *
 * A change heard while a read is in flight reads AGAIN once it lands: that read may have
 * started before the change. (A plugin reload takes its defaults back and sets them again; the
 * one read the first notice started answered between the two, with no plugin rules, and the
 * second notice was folded into it, so every open window showed the plugin's hidden ids.)
 */

import { useSyncExternalStore } from 'react';
import { apiGet, apiPut } from '@/api/client';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import {
  BUILTIN_TAG_DISPLAY_RULES,
  DEFAULT_TAG_DISPLAY_RULES,
  compileTagDisplay,
  type CompiledTagDisplay,
  type TagDisplay,
  type TagDisplayRule,
  type TagLinkRule,
} from '../../../src/core/tag-display-rules';

export type { TagDisplay, TagDisplayRule, TagLinkRule } from '../../../src/core/tag-display-rules';

const STORAGE_KEY = 'walnut:tag-display.v1';
const LINKS_STORAGE_KEY = 'walnut:tag-links.v1';
const PATH = '/api/v1/tasks/meta/tag-display';

interface Snapshot {
  rules: readonly TagDisplayRule[];
  /** What a tag's pill opens (an older server sends none). */
  links: readonly TagLinkRule[];
  compiled: CompiledTagDisplay;
  /** True once the server answered in this page. */
  loaded: boolean;
}

function snapshotOf(rules: readonly TagDisplayRule[], links: readonly TagLinkRule[], loaded: boolean): Snapshot {
  return { rules, links, compiled: compileTagDisplay(rules, links), loaded };
}

function readStored(): readonly TagDisplayRule[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (Array.isArray(parsed)) return parsed as TagDisplayRule[];
  } catch { /* storage unavailable or malformed: Walnut's own rules only */ }
  return [...BUILTIN_TAG_DISPLAY_RULES, ...DEFAULT_TAG_DISPLAY_RULES];
}

function readStoredLinks(): readonly TagLinkRule[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINKS_STORAGE_KEY) ?? 'null') as unknown;
    if (Array.isArray(parsed)) return parsed as TagLinkRule[];
  } catch { /* storage unavailable or malformed: no links until the read answers */ }
  return [];
}

let snapshot: Snapshot = snapshotOf(readStored(), readStoredLinks(), false);
const listeners = new Set<() => void>();
let wired = false;
let inflight: Promise<void> | null = null;
// A change was announced while a read was in flight: read once more when it lands.
let stale = false;
// Bumped by every write, so a read that started before it cannot put the old rules back.
let generation = 0;

function publish(rules: readonly TagDisplayRule[], links: readonly TagLinkRule[], loaded: boolean): void {
  snapshot = snapshotOf(rules, links, loaded);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
    localStorage.setItem(LINKS_STORAGE_KEY, JSON.stringify(links));
  } catch { /* the page still has them */ }
  for (const listener of listeners) listener();
}

export function loadTagDisplay(): Promise<void> {
  if (inflight) {
    stale = true;
    return inflight;
  }
  stale = false;
  const started = generation;
  inflight = apiGet<{ rules: TagDisplayRule[]; links?: TagLinkRule[] }>(PATH)
    .then((res) => {
      if (started === generation && Array.isArray(res?.rules)) publish(res.rules, Array.isArray(res.links) ? res.links : [], true);
    })
    .catch((err: unknown) => {
      // Keep the last known rules: a hidden tag must not reappear because one read failed.
      log.warn('tag-display', 'could not read the tag display rules', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      inflight = null;
      if (stale) void loadTagDisplay();
    });
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
  const links = snapshot.links;
  publish(display === null ? others : [...others, { pattern, display, source: 'user' }], links, snapshot.loaded);
  const mine = generation;
  try {
    const res = await apiPut<{ rules: TagDisplayRule[]; links?: TagLinkRule[] }>(PATH, { pattern, display });
    if (mine === generation && Array.isArray(res?.rules)) publish(res.rules, Array.isArray(res.links) ? res.links : links, true);
  } catch (err) {
    if (mine === generation) publish(before, links, snapshot.loaded);
    throw err;
  }
}

/**
 * The user's link for a tag or `<namespace>:*`: a template with `{value}`, `''` for no link
 * (over a plugin's), or null to remove the user's rule. Optimistic like setTagDisplay.
 */
export async function setTagLink(pattern: string, link: string | null): Promise<void> {
  generation++;
  const before = snapshot.links;
  const rules = snapshot.rules;
  const others = before.filter((rule) => !(rule.source === 'user' && rule.pattern === pattern));
  publish(rules, link === null ? others : [{ pattern, link, source: 'user' }, ...others], snapshot.loaded);
  const mine = generation;
  try {
    const res = await apiPut<{ rules: TagDisplayRule[]; links?: TagLinkRule[] }>(PATH, { pattern, link });
    if (mine === generation && Array.isArray(res?.rules)) publish(res.rules, Array.isArray(res.links) ? res.links : snapshot.links, true);
  } catch (err) {
    if (mine === generation) publish(rules, before, snapshot.loaded);
    throw err;
  }
}

/** Test seam: forget the page's copy. */
export function _resetTagDisplayStoreForTesting(): void {
  snapshot = snapshotOf([...BUILTIN_TAG_DISPLAY_RULES, ...DEFAULT_TAG_DISPLAY_RULES], [], false);
  generation = 0;
  inflight = null;
  stale = false;
}
