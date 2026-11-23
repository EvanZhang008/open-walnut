/**
 * Where held notices wait (held-notices.ts): in memory AND on disk, so a restart never drops what
 * still waits for a session's next message (2026-11-21: three task_send wake=false notes from a lead
 * to one task, held in memory only, were lost to deploys within minutes, nobody was told, and
 * op_result kept answering "applied, delivery held").
 *
 * WALNUT_HOME/cache/held-notices.json (cache/: git sync leaves it out, it is queue state):
 *   { version: 1,
 *     sessions: { <session id>: { <key>: { text, at, whileOpen?, parts?, dropped? } } },
 *     fates:    { <message id>: { state: 'delivered' | 'dropped', at, sid, why?, row? } } }
 * Only the server opens it (openStore, at boot on the leader): a process that never opened it
 * keeps its notices in memory as before and never writes the file. A missing file, or one in a
 * shape this version does not read (an older or a newer release's, set aside first), reads as empty.
 *
 * Notices a message took (pendingHeldNotices) stay in the file until that message is stored, so a
 * restart in between sends them again instead of losing them. A note's fate, by its message id, is
 * kept FATE_KEEP_MS for op_result. A folded notice's render function is not stored: the next part
 * held under its key renders every part again, restored ones included.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

/** A held notice older than this is dropped unread: the live list has moved on. */
export const HOLD_MAX_MS = 3 * 24 * 60 * 60_000;
/** Most parts one folded notice keeps; older ones are dropped (the newest say where things stand). */
export const FOLD_PARTS_MAX = 12;
/** How long a note's fate is kept for op_result (its call's writes stay in the ledger 30 days). */
export const FATE_KEEP_MS = 7 * 24 * 60 * 60_000;
const FATES_MAX = 2_000;
const VERSION = 1;

export interface Held {
  text: string;
  at: number;
  /** Request ids (rq-…): the notice is still worth telling while any of them is unanswered. */
  whileOpen?: string[];
  /** A folded notice (holdFoldedNotice): every part held under its key, oldest first. */
  parts?: unknown[];
  /** Older parts FOLD_PARTS_MAX pushed out: the notice says how many. */
  dropped?: number;
  /** How the parts read as one notice. In memory only: never stored. */
  render?: (parts: unknown[], dropped: number) => string;
}

/** What became of a note that waited (op_result reads it by the note's message id). */
export interface NoteFate {
  state: 'delivered' | 'dropped';
  at: number;
  /** The session it waited for. */
  sid: string;
  /** Dropped: why. */
  why?: string;
  /** Delivered: the queued message it rode. */
  row?: string;
}

/** Notices a message took, until it says it carried them (markTold) or did not (release). */
export interface Taken { sid: string; at: number; entries: Array<[string, Held]> }

/** What a part of a folded notice may say about itself (a quiet note's do: quiet-notes.ts). */
export interface PartMeta { at?: number; mid?: string; from?: string; task?: string; title?: string }

export const held = new Map<string, Map<string, Held>>();
export const taken = new Map<number, Taken>();
const fates = new Map<string, NoteFate>();

let opened = false;
/** False for a boot that could not read the file: it never writes it (openStore). */
let writable = true;
let loading: Promise<void> | null = null;
let loaded = false;
/** Bumped by a test reset: a write or load of an older generation does nothing. */
let generation = 0;
let writeChain: Promise<void> = Promise.resolve();
let queuedWrite: Promise<void> | null = null;

function storeFile(): string {
  return path.join(WALNUT_HOME, 'cache', 'held-notices.json');
}

export function metaOf(part: unknown): PartMeta {
  return part && typeof part === 'object' ? part as PartMeta : {};
}

export function slotOf(sid: string): Map<string, Held> {
  const slot = held.get(sid) ?? new Map<string, Held>();
  held.set(sid, slot);
  return slot;
}

/**
 * Store a folded notice of `all` parts under `key`, the newest FOLD_PARTS_MAX kept. Returns the
 * parts pushed out (the caller records them dropped). Without a render (two restored halves meeting)
 * the two texts are kept side by side.
 */
export function setFolded(
  slot: Map<string, Held>, key: string, all: unknown[], droppedBefore: number,
  render: Held['render'], at: number, olderText?: string,
): unknown[] {
  const parts = all.slice(-FOLD_PARTS_MAX);
  const out = all.slice(0, all.length - parts.length);
  const dropped = droppedBefore + out.length;
  const text = render ? render(parts, dropped) : [olderText, slot.get(key)?.text].filter(Boolean).join('\n\n');
  slot.set(key, { text, at, parts, dropped, ...(render ? { render } : {}) });
  return out;
}

/**
 * Put `older` back under `key`: a newer plain notice of the same key wins; a folded one keeps both
 * parts' lists, oldest first, each note (by its message id) once. Returns the parts pushed out.
 */
export function mergeOlder(slot: Map<string, Held>, key: string, older: Held): unknown[] {
  const cur = slot.get(key);
  if (!cur) { slot.set(key, older); return []; }
  if (!older.parts || !cur.parts) return [];
  const ids = new Set(cur.parts.map((p) => metaOf(p).mid).filter(Boolean));
  const kept = older.parts.filter((p) => { const mid = metaOf(p).mid; return !mid || !ids.has(mid); });
  return setFolded(slot, key, [...kept, ...cur.parts], (older.dropped ?? 0) + (cur.dropped ?? 0),
    cur.render ?? older.render, Math.max(cur.at, older.at), cur.render ?? older.render ? undefined : older.text);
}

// ── fates ──

export function recordFate(mid: string, fate: NoteFate): void {
  fates.delete(mid);
  fates.set(mid, fate);
  while (fates.size > FATES_MAX) fates.delete(fates.keys().next().value as string);
}

export function fateOf(mid: string): NoteFate | undefined {
  return fates.get(mid);
}

export function pruneFates(now = Date.now()): boolean {
  let changed = false;
  for (const [mid, f] of fates) if (now - f.at > FATE_KEEP_MS) { fates.delete(mid); changed = true; }
  return changed;
}

/** Where a note with this message id waits now, or null. */
export function waitingNote(mid: string): { sid: string; key: string; at: number } | null {
  const find = (sid: string, entries: Iterable<[string, Held]>) => {
    for (const [key, v] of entries) {
      const part = v.parts?.find((p) => metaOf(p).mid === mid);
      if (part) return { sid, key, at: metaOf(part).at ?? v.at };
    }
    return null;
  };
  for (const [sid, slot] of held) { const hit = find(sid, slot); if (hit) return hit; }
  for (const t of taken.values()) { const hit = find(t.sid, t.entries); if (hit) return hit; }
  return null;
}

// ── the file ──

function validHeld(v: unknown): Held | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.text !== 'string' || typeof e.at !== 'number' || !Number.isFinite(e.at)) return null;
  const whileOpen = Array.isArray(e.whileOpen) ? e.whileOpen.filter((x): x is string => typeof x === 'string') : [];
  return {
    text: e.text, at: e.at,
    ...(whileOpen.length ? { whileOpen } : {}),
    ...(Array.isArray(e.parts) ? { parts: e.parts } : {}),
    ...(typeof e.dropped === 'number' && e.dropped > 0 ? { dropped: e.dropped } : {}),
  };
}

function validFate(v: unknown): NoteFate | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if ((f.state !== 'delivered' && f.state !== 'dropped') || typeof f.at !== 'number' || typeof f.sid !== 'string') return null;
  return {
    state: f.state, at: f.at, sid: f.sid,
    ...(typeof f.why === 'string' ? { why: f.why } : {}), ...(typeof f.row === 'string' ? { row: f.row } : {}),
  };
}

/** The file's notices and fates, or null when it is not a file this version reads. */
function parseFile(raw: string): { sessions: Array<[string, string, Held]>; fates: Array<[string, NoteFate]> } | null {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || (doc as { version?: unknown }).version !== VERSION) return null;
  const d = doc as { sessions?: unknown; fates?: unknown };
  const sessions: Array<[string, string, Held]> = [];
  for (const [sid, keys] of Object.entries(d.sessions && typeof d.sessions === 'object' ? d.sessions : {})) {
    for (const [key, v] of Object.entries(keys && typeof keys === 'object' ? keys as object : {})) {
      const h = validHeld(v);
      if (h) sessions.push([sid, key, h]);
    }
  }
  const out: Array<[string, NoteFate]> = [];
  for (const [mid, v] of Object.entries(d.fates && typeof d.fates === 'object' ? d.fates : {})) {
    const f = validFate(v);
    if (f) out.push([mid, f]);
  }
  return { sessions, fates: out };
}

/**
 * Open the file (server boot): what waited before the restart joins what was held since, older
 * first. Idempotent. Never throws, and always settles (a send waits on it):
 *  - no file: empty;
 *  - a file this version does not read (another release's shape, or not JSON): set aside as
 *    `held-notices.json.backup-<time>` so the first write does not erase it, then empty;
 *  - a read error (permissions, no file handles): this boot keeps its notices in memory only and
 *    never writes the file, so what it holds is not written over.
 * Notices held before the file was read are written once it is.
 */
export function openStore(): Promise<void> {
  if (loading) return loading;
  opened = true;
  const gen = generation;
  loading = (async () => {
    try {
      let raw: string | null = null;
      try {
        raw = await fsp.readFile(storeFile(), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          writable = false;
          log.session.warn('held notices: the file could not be read; this boot keeps them in memory only', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (gen !== generation) return;
      const file = raw === null ? null : parseFile(raw);
      if (raw !== null && !file) {
        const aside = `${storeFile()}.backup-${Date.now()}`;
        await fsp.rename(storeFile(), aside).catch(() => { writable = false; });
        log.session.warn('held notices: the file is not one this version reads; set aside, starting empty', { aside, writable });
      }
      if (gen !== generation) return;
      const heldBefore = held.size > 0;
      for (const [sid, key, h] of file?.sessions ?? []) {
        // Pushed out by what was held since boot: told like any part the fold cap drops.
        const out = mergeOlder(slotOf(sid), key, h);
        if (out.length) onPushedOut(sid, out);
      }
      for (const [mid, f] of file?.fates ?? []) if (!fates.has(mid)) fates.set(mid, f);
      if (file?.sessions.length) log.session.info('held notices kept across the restart', { notices: file.sessions.length, sessions: held.size });
      if (heldBefore) void persist();
    } catch (err) {
      log.session.warn('held notices: the file could not be taken in; what it held waits there', { error: err instanceof Error ? err.message : String(err) });
      writable = false;
    } finally {
      if (gen === generation) loaded = true;
    }
  })();
  return loading;
}

/** Null when reads may go on now (loaded, or never opened); else the load to wait for. */
export function storeLoading(): Promise<void> | null {
  return loading && !loaded ? loading : null;
}

/** Hook for parts a merge pushed out (held-notices.ts sets it: they are recorded dropped and told). */
let onPushedOut: (sid: string, parts: unknown[]) => void = () => {};
export function setPushedOutHandler(fn: (sid: string, parts: unknown[]) => void): void {
  onPushedOut = fn;
}

function snapshot(): string {
  const view = new Map<string, Map<string, Held>>();
  for (const [sid, slot] of held) view.set(sid, new Map(slot));
  for (const t of taken.values()) {
    const slot = view.get(t.sid) ?? new Map<string, Held>();
    view.set(t.sid, slot);
    for (const [key, v] of t.entries) mergeOlder(slot, key, v);
  }
  const sessions: Record<string, Record<string, Omit<Held, 'render'>>> = {};
  for (const [sid, slot] of view) {
    if (!slot.size) continue;
    sessions[sid] = {};
    for (const [key, { render: _render, ...v }] of slot) sessions[sid][key] = v;
  }
  return JSON.stringify({ version: VERSION, sessions, fates: Object.fromEntries(fates) });
}

/** A write this large or slow is logged: the whole state is serialized on the event loop. */
const BIG_WRITE_BYTES = 1024 * 1024;
const SLOW_WRITE_MS = 50;

/**
 * Write what waits now. Resolves once a write that started after this call is on disk (writes are
 * coalesced: a change made while one is queued rides it). Never rejects: a failed write is logged
 * and the notices still wait in memory. A no-op until the file was opened.
 */
export function persist(): Promise<void> {
  if (!opened) return Promise.resolve();
  if (queuedWrite) return queuedWrite;
  const gen = generation;
  const next: Promise<void> = writeChain.then(async () => {
    if (queuedWrite === next) queuedWrite = null;
    try {
      // Never before the file's own notices are in memory: they would be written over.
      await loading;
      if (gen !== generation || !writable) return;
      const file = storeFile();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const { writeFileAtomic } = await import('../config-store.js');
      const t0 = performance.now();
      const text = snapshot();
      const ms = performance.now() - t0;
      if (text.length > BIG_WRITE_BYTES || ms > SLOW_WRITE_MS) {
        log.session.warn('held notices: a large write', { bytes: text.length, serializeMs: Math.round(ms), sessions: held.size, fates: fates.size });
      }
      await writeFileAtomic(file, text, 0o600);
    } catch (err) {
      log.session.warn('held notices: not saved', { error: err instanceof Error ? err.message : String(err) });
    }
  });
  queuedWrite = next;
  writeChain = next.catch(() => {});
  return next;
}

/** Server stop: resolves once every write asked for is on disk. */
export async function closeStore(): Promise<void> {
  await writeChain;
}

/** Test seam: forget everything; `keepFile` keeps it on disk (what a restart leaves), else it goes too. */
export async function _resetHeldStoreForTesting(opts: { keepFile?: boolean } = {}): Promise<void> {
  await writeChain;
  clearNow(!opts.keepFile);
}

/** Sync reset (held-notices.ts _clearHeldNotices): the file goes only when this process opened it. */
export function clearNow(removeFile = true): void {
  const wasOpen = opened;
  generation++;
  held.clear();
  taken.clear();
  fates.clear();
  opened = false;
  writable = true;
  loaded = false;
  loading = null;
  queuedWrite = null;
  writeChain = Promise.resolve();
  if (removeFile && wasOpen) fs.rmSync(storeFile(), { force: true });
}
