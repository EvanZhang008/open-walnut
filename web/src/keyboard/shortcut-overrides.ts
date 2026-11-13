/**
 * The chords a person gave the commands (Settings > Keyboard shortcuts), per place:
 * `ui.shortcuts[<KeyEnv>][<CommandId>] = "Cmd+J"` ('' = no key). One app-wide value, kept the
 * way useNextAfterComplete keeps its own: one cached value, one config fetch, one
 * `config:changed` subscription, the last read in localStorage so the first key press after a
 * reload already uses it.
 */
import { useEffect, useState } from 'react';
import { fetchConfig, fetchFreshConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';
import { chordLabel, hasCommandModifier, normalizeChord } from './chords';
import { COMMANDS, COMMAND_IDS, RESERVED, chordsFor, commandDef, commandFor, type CommandId, type Overrides } from './commands';
import { detectKeyEnv, fixedChords, type KeyEnv } from './shortcuts';

export type AllOverrides = Partial<Record<KeyEnv, Overrides>>;

let cached: AllOverrides | null = null;
let inflight: Promise<void> | null = null;
let wsBound = false;
let lastSelfChange = 0;
const listeners = new Set<(v: AllOverrides) => void>();
const SELF_CHANGE_COOLDOWN = 3000;
const LAST_KEY = 'walnut:shortcuts';

/** Keeps only known commands and chords that parse, so a hand-edited config cannot break a key. */
export function cleanOverrides(raw: unknown): AllOverrides {
  const out: AllOverrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const env of ['mac-app', 'mac-browser', 'other'] as KeyEnv[]) {
    const per = (raw as Record<string, unknown>)[env];
    if (!per || typeof per !== 'object') continue;
    const clean: Overrides = {};
    for (const [id, chord] of Object.entries(per as Record<string, unknown>)) {
      if (!COMMAND_IDS.includes(id as CommandId) || typeof chord !== 'string') continue;
      if (chord === '') { clean[id as CommandId] = ''; continue; }
      const n = normalizeChord(chord);
      if (n) clean[id as CommandId] = n;
    }
    if (Object.keys(clean).length) out[env] = clean;
  }
  return out;
}

function lastRead(): AllOverrides {
  try { return cleanOverrides(JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')); } catch { return {}; }
}

function publish(v: AllOverrides) {
  cached = v;
  try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  for (const l of listeners) l(v);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchConfig()
    .then((c) => publish(cleanOverrides((c.ui as { shortcuts?: unknown } | undefined)?.shortcuts)))
    .catch(() => { /* keep what we have */ })
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

function all(): AllOverrides {
  if (cached === null) { cached = lastRead(); bindConfigChanges(); void load(); }
  return cached;
}

/** This place's chords now, for a key handler (outside render). */
export function overridesNow(env: KeyEnv = detectKeyEnv()): Overrides {
  return all()[env] ?? {};
}

/** The command this key press runs here, if any. */
export function commandAt(e: KeyboardEvent, env: KeyEnv = detectKeyEnv()): CommandId | null {
  return commandFor(e, env, overridesNow(env));
}

/** Does this key press run `id` here? */
export function isCommand(e: KeyboardEvent, id: CommandId): boolean {
  return commandAt(e) === id;
}

/** This place's chord labels for a command now ("⌘N"), for a hint or a title. */
export function commandLabel(id: CommandId, env: KeyEnv = detectKeyEnv()): string | null {
  const ch = chordsFor(id, env, overridesNow(env))[0];
  return ch ? chordLabel(ch, env !== 'other') : null;
}

export function useShortcutOverrides(env: KeyEnv): Overrides {
  const [value, setValue] = useState<AllOverrides>(() => all());
  useEffect(() => {
    listeners.add(setValue);
    bindConfigChanges();
    setValue(all());
    return () => { listeners.delete(setValue); };
  }, []);
  return value[env] ?? {};
}

/** Why `chord` cannot be `id`'s key here, or null when it can. */
export function chordConflict(id: CommandId, chord: string, env: KeyEnv, overrides: Overrides): string | null {
  const mac = env !== 'other';
  const label = chordLabel(chord, mac);
  if (!hasCommandModifier(chord)) return `${label} alone is typing: add ${mac ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'}.`;
  if (RESERVED[env].includes(chord)) {
    return env === 'mac-app' ? `${label} belongs to the Mac app's menus.` : `${label} belongs to the browser, which never hands it to the page.`;
  }
  const fixed = fixedChords(env).get(chord);
  if (fixed) return `${label} is already "${fixed}", which cannot change.`;
  const holder = COMMANDS.find((c) => c.id !== id && chordsFor(c.id, env, overrides).includes(chord))?.id;
  if (holder) return `${label} is already "${commandDef(holder).label}".`;
  return null;
}

/** Saves this place's chords. A save the server refuses puts the old ones back and throws. */
async function write(env: KeyEnv, next: Overrides): Promise<void> {
  const before = all();
  const nextAll: AllOverrides = { ...before };
  if (Object.keys(next).length) nextAll[env] = next; else delete nextAll[env];
  publish(nextAll);
  lastSelfChange = Date.now();
  try {
    // updateConfig replaces the whole `ui` object: merge into the server's own, read fresh, so a
    // setting changed a moment ago elsewhere is not written back over.
    const c = await fetchFreshConfig();
    const res = await updateConfig({ ui: { ...c.ui, shortcuts: nextAll } as typeof c.ui });
    if (!res?.ok) throw new Error('not saved');
  } catch (err) {
    publish(before);
    throw err;
  }
}

/** Give `id` this chord here. Resolves to the reason it was refused, or null once saved. */
export async function setCommandChord(id: CommandId, chord: string, env: KeyEnv): Promise<string | null> {
  const n = normalizeChord(chord);
  if (!n) return 'That key cannot be a shortcut.';
  const current = overridesNow(env);
  const why = chordConflict(id, n, env, current);
  if (why) return why;
  const next: Overrides = { ...current };
  // The default again: no override to keep.
  const def = commandDef(id).defaults[env];
  if (def.length === 1 && def[0] === n) delete next[id]; else next[id] = n;
  await write(env, next);
  return null;
}

/** Back to the default chord(s) for one command, or for all of them (`id` left out). One command's
 *  default another command took meanwhile is refused (resolves to the reason), never shared. */
export async function resetCommandChord(env: KeyEnv, id?: CommandId): Promise<string | null> {
  const current = overridesNow(env);
  const next: Overrides = { ...current };
  if (id) {
    delete next[id];
    for (const ch of commandDef(id).defaults[env]) {
      const holder = COMMANDS.find((c) => c.id !== id && chordsFor(c.id, env, next).includes(ch))?.id;
      if (holder) return `${chordLabel(ch, env !== 'other')} is now "${commandDef(holder).label}": give that one another key first.`;
    }
  } else for (const c of COMMANDS) delete next[c.id];
  await write(env, next);
  return null;
}

/** Tests: forget the cache. */
export function resetShortcutOverridesForTest(v: AllOverrides | null = null) {
  cached = v;
}
