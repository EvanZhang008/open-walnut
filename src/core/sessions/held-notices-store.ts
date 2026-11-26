/**
 * Where held notices wait (held-notices.ts): in memory AND on disk, so a restart never drops what
 * still waits for a session's next message (2026-11-21: three task_send wake=false notes from a lead
 * to one task, held in memory only, were lost to deploys within minutes, nobody was told, and
 * op_result kept answering "applied, delivery held").
 *
 * WALNUT_HOME/cache/held-notices.json (cache/: git sync leaves it out, it is queue state):
 *   { version: 1,
 *     sessions: { <session id>: { <key>: { text, at, whileOpen?, parts?, dropped? } } },
 *     fates:    { <message id>: { state: 'delivered' | 'dropped', at, sid, why?, row? } },
 *     tells?:   [ { callerSid, op, taskId, reason, at, tries, mid?, fromTask?, kind? } ] }   (senders still to be told)
 * Only the server opens it (openStore, at boot on the leader): a process that never opened it
 * keeps its notices in memory as before and never writes the file. A missing file, or one in a
 * shape this version does not read (an older or a newer release's, set aside first), reads as empty.
 *
 * Notices a message took (pendingHeldNotices) stay in the file until that message is stored, so a
 * restart in between sends them again instead of losing them. A note's fate, by its message id, is
 * kept FATE_KEEP_MS for op_result. A folded notice's render function is not stored: the next part
 * held under its key renders every part again, restored ones included.
 *
 * A task's own note is never lost (2026-11-23, the user: no message is ever lost, at any time, and an
 * error keeps being retried). A part marked `whole` (session-send-core.ts sets it when the sender is a
 * session) is never pushed out by FOLD_PARTS_MAX and never expires by age: it waits until its
 * target's next message, follows the target's session when that changes, and only when the target
 * is gone with nothing going on for it is it dropped, with its sender told (the tell itself is kept
 * here until it is held for the sender, as a `whole` part too, and tried again while that fails, for
 * TELL_KEEP_MS; a tell no live session can take is written on the note's fate instead). What one
 * target holds of whole notes is bounded by WHOLE_HELD_MAX_BYTES: past it a new wake=false note is
 * refused at its send, never cut. A topic's fold (topics/topic-delivery.ts) is `whole` too: the
 * member's read mark moved past its posts, which go back to the topic as unread if it is dropped.
 * Walnut's own status notices and scripts' notes keep the age limit and the cap; a script's dropped
 * note still has its fate.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

/** A held notice older than this is dropped unread (never one with a `whole` part): the live list has moved on. */
export const HOLD_MAX_MS = 3 * 24 * 60 * 60_000;
/** Most parts one folded notice keeps; older ones are dropped (the newest say where things stand), never a `whole` one. */
export const FOLD_PARTS_MAX = 12;
/** How long a note's fate is kept for op_result (its call's writes stay in the ledger 30 days). */
export const FATE_KEEP_MS = 7 * 24 * 60 * 60_000;
const FATES_MAX = 2_000;
/**
 * Most bytes of whole notes (a task's, keptWhole) one target holds unread: past it a new wake=false
 * note is refused at its send (quiet-notes.ts holdQuietNote), so one rider never grows past what a
 * CLI takes as one message.
 */
export const WHOLE_HELD_MAX_BYTES = 64 * 1024;
/** How long a sender's tell is tried again before it is written on the note's fate as not told. */
export const TELL_KEEP_MS = 7 * 24 * 60 * 60_000;
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
export interface PartMeta {
  at?: number; mid?: string; from?: string; task?: string; title?: string;
  /** A task's own words: kept whole, never pushed out by the cap, never expired by age (keptWhole). */
  whole?: boolean;
  /** The sending session's task: told there when that session is gone (held-notices-sweep.ts). */
  fromTask?: string;
  /** A sender's tell (held-notices-sweep.ts flushDropTells): the notes it tells of. */
  told?: Array<Pick<DropTell, 'callerSid' | 'mid' | 'reason'> & Partial<DropTell>>;
  /**
   * A quiet note whose sender was told it still waits past its max hold (held-notices.ts
   * tellStillWaiting): when. Stored with the part, so no lap and no restart tells it twice.
   */
  waitTold?: number;
  /**
   * Its sender could not be told it still waits: when and why. Tried again a max hold later (no live
   * session took the tell), or never (`final`: the sender's task is complete).
   */
  waitUntold?: { at: number; why: string; final?: boolean };
  /** A topic's fold (topics/topic-text.ts FoldPart): its posts go back unread when it is dropped. */
  topic?: string;
  /** A quiet note's sender kind (quiet-notes.ts QuietNoteBy): see goesAlone. */
  by?: string;
}

/**
 * What a sender is told about a note of its: it was `dropped` unread, or it is still `waiting` past
 * its max hold for a reason that does not clear by itself (held-notices-sweep.ts QUIET_WAITS).
 */
export type TellKind = 'dropped' | 'waiting';

/** A note whose sender is a session, to tell it about: told by held-notices-sweep.ts flushDropTells. */
export interface DropTell {
  callerSid: string; op: string; taskId: string; reason: string;
  /** Absent: `dropped` (every tell before kinds were kept). */
  kind?: TellKind;
  /** When it was queued, and how many tries failed since (TELL_KEEP_MS bounds the tries). */
  at: number; tries: number;
  /** The dropped note's message id: its fate says so when no session can be told. */
  mid?: string;
  fromTask?: string;
  /**
   * `message`: a message of the sender's (a queue row, or a note that rode one) set aside or voided
   * unsent, told by sessions/undelivered-tell.ts; absent: a wake=false note the hold itself dropped
   * or still holds.
   */
  subject?: 'message';
}

/**
 * The key prefix every quiet note waits under, one key per sender (quiet-notes.ts): a session's
 * wake=false note or a script's no-reply note. Only these go out on their own once they waited
 * COLD_HOLD_MAX_MS (held-notices-sweep.ts deliverDueQuietNotes); Walnut's own notices only ride.
 */
export const QUIET_NOTE_KEY = 'quiet-note:';
/**
 * The key a sender's tells wait under (held-notices-sweep.ts flushDropTells): their parts are
 * `whole`, so no age limit or cap drops them, and they go on their own past the max hold like a
 * session's quiet note (goesAlone): a sender that gets no other message still hears.
 */
export const DROP_TELL_KEY = 'note-dropped';
/** The key Walnut's own wake=false notices wait under (session-send-core.ts: `Walnut (<source>)@<host>`). */
const WALNUT_QUIET_KEY = `${QUIET_NOTE_KEY}Walnut (`;

/**
 * Does this held part go out on its own once it waited the max hold: a quiet note a session or a
 * script sent, or a sender's tell about such a note (2026-11-24: a tell that only rode the sender's
 * next message never reached a sender that got none), never Walnut's own notices (they ride and
 * wake nothing). A part from before `by` was kept reads Walnut's by its key.
 */
export function goesAlone(key: string, part: unknown): boolean {
  if (key === DROP_TELL_KEY) return true;
  if (!key.startsWith(QUIET_NOTE_KEY)) return false;
  const by = metaOf(part).by;
  return by === undefined ? !key.startsWith(WALNUT_QUIET_KEY) : by !== 'walnut';
}

export const held = new Map<string, Map<string, Held>>();
export const taken = new Map<number, Taken>();
const fates = new Map<string, NoteFate>();
/** Senders still to be told their note was dropped; `tellsOut`: being told now (still written to the file). */
const tells: DropTell[] = [];
const tellsOut = new Set<DropTell>();

let opened = false;
/** False for a boot that could not read the file: it never writes it (openStore). */
let writable = true;
let loading: Promise<void> | null = null;
let loaded = false;
/** Bumped by a test reset: a write or load of an older generation does nothing. */
let generation = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let queuedWrite: Promise<boolean> | null = null;

function storeFile(): string {
  return path.join(WALNUT_HOME, 'cache', 'held-notices.json');
}

export function metaOf(part: unknown): PartMeta {
  return part && typeof part === 'object' ? part as PartMeta : {};
}

/**
 * A task's own note (its words kept whole and never dropped but for a target that is gone).
 * A part written before the marker existed says so by its sending session (`from`): only a
 * session's note ever carried one.
 */
export function keptWhole(part: unknown): boolean {
  const m = metaOf(part);
  return m.whole === true || (m.whole === undefined && typeof m.from === 'string' && m.from.length > 0);
}

/** Bytes of whole notes (a task's, with a message id) waiting for `sid`, in the hold or taken by a message. */
export function wholeBytesHeld(sid: string): number {
  let bytes = 0;
  const add = (entries: Iterable<[string, Held]>) => {
    for (const [, v] of entries) {
      for (const p of v.parts ?? []) {
        const m = metaOf(p) as PartMeta & { text?: unknown };
        if (m.mid && keptWhole(p) && typeof m.text === 'string') bytes += Buffer.byteLength(m.text);
      }
    }
  };
  add(held.get(sid) ?? []);
  for (const t of taken.values()) if (t.sid === sid) add(t.entries);
  return bytes;
}

/** A notice past its age limit that may go: none of its parts is a task's own note. */
export function expiredByAge(v: Held, now: number): boolean {
  return now - v.at > HOLD_MAX_MS && !(v.parts ?? []).some(keptWhole);
}

/** The newest FOLD_PARTS_MAX of `all`, but every `whole` part kept: `out` is what the cap pushes out, oldest first. */
function capParts(all: unknown[]): { parts: unknown[]; out: unknown[] } {
  let over = all.length - FOLD_PARTS_MAX;
  if (over <= 0) return { parts: all, out: [] };
  const parts: unknown[] = [];
  const out: unknown[] = [];
  for (const p of all) {
    if (over > 0 && !keptWhole(p)) { out.push(p); over--; } else parts.push(p);
  }
  return { parts, out };
}

export function slotOf(sid: string): Map<string, Held> {
  const slot = held.get(sid) ?? new Map<string, Held>();
  held.set(sid, slot);
  return slot;
}

/**
 * Store a folded notice of `all` parts under `key`, the newest FOLD_PARTS_MAX kept (and every part
 * that is a task's own note, however many). Returns the parts pushed out (the caller records them
 * dropped). Without a render (two restored halves meeting) the two texts are kept side by side.
 */
export function setFolded(
  slot: Map<string, Held>, key: string, all: unknown[], droppedBefore: number,
  render: Held['render'], at: number, olderText?: string,
): unknown[] {
  const { parts, out } = capParts(all);
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

/** A sender to tell its note was dropped (kept in the file until it is told). */
export function queueTell(t: DropTell): void {
  tells.push(t);
}

/**
 * Take back queued tells that a message is not delivered yet (undelivered-tell.ts): it was delivered
 * since, or its void says what became of it. A tell already being told (takeTells) is left alone.
 * Returns whether one was taken back (the caller writes the file).
 */
export function forgetQueuedTells(mids: readonly string[]): boolean {
  const gone = new Set(mids);
  const keep = tells.filter((t) => !(t.subject === 'message' && t.kind === 'waiting' && t.mid && gone.has(t.mid)));
  if (keep.length === tells.length) return false;
  tells.splice(0, tells.length, ...keep);
  return true;
}

/** The senders to tell now; they stay in the file until settleTells says how it went. */
export function takeTells(): DropTell[] {
  const out = tells.splice(0, tells.length);
  for (const t of out) tellsOut.add(t);
  return out;
}

/** A batch takeTells gave is done: `untold` (delivery failed) waits for the next try. */
export function settleTells(batch: readonly DropTell[], untold: readonly DropTell[]): void {
  for (const t of batch) tellsOut.delete(t);
  tells.push(...untold);
}

export function pruneFates(now = Date.now()): boolean {
  let changed = false;
  for (const [mid, f] of fates) if (now - f.at > FATE_KEEP_MS) { fates.delete(mid); changed = true; }
  return changed;
}

/**
 * When the oldest quiet note held for `sid` that goes out on its own (goesAlone) was sent (its part's
 * own `at`, kept on disk), or null. A sender's tell (DROP_TELL_KEY) counts only when nothing else
 * that goes alone is held: an old tell never makes a new note due at once.
 */
export function oldestQuietAt(sid: string): number | null {
  let oldest: number | null = null;
  let oldestTell: number | null = null;
  for (const [key, v] of held.get(sid) ?? []) {
    for (const p of v.parts ?? []) {
      if (!goesAlone(key, p)) continue;
      const at = metaOf(p).at ?? v.at;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      if (key === DROP_TELL_KEY) { if (oldestTell === null || at < oldestTell) oldestTell = at; } else if (oldest === null || at < oldest) oldest = at;
    }
  }
  return oldest ?? oldestTell;
}

/**
 * Why the quiet notes held for a session still wait past their max hold (op_result's held_note says
 * it), as the last lap found them: said only while the same oldest note waits.
 */
const quietWaitWhy = new Map<string, { why: string; oldest: number }>();
export function setQuietWaitWhy(sid: string, why: string | null): void {
  const oldest = oldestQuietAt(sid);
  if (why && oldest !== null) quietWaitWhy.set(sid, { why, oldest }); else quietWaitWhy.delete(sid);
}
export function quietWaitWhyOf(sid: string): string | undefined {
  const w = quietWaitWhy.get(sid);
  return w && w.oldest === oldestQuietAt(sid) ? w.why : undefined;
}

/**
 * The session a tell about this note waits for (held under DROP_TELL_KEY), and its kind, or null.
 * A tell that it was dropped wins over one that it still waits (the newer news).
 */
export function heldTellOf(mid: string): { sid: string; kind: TellKind } | null {
  let waiting: { sid: string; kind: TellKind } | null = null;
  const look = (sid: string, entries: Iterable<[string, Held]>) => {
    for (const [key, v] of entries) {
      if (key !== DROP_TELL_KEY) continue;
      for (const p of v.parts ?? []) {
        for (const t of metaOf(p).told ?? []) {
          if (!t || t.mid !== mid) continue;
          if ((t.kind ?? 'dropped') === 'dropped') return { sid, kind: 'dropped' as const };
          waiting ??= { sid, kind: 'waiting' };
        }
      }
    }
    return null;
  };
  for (const [sid, slot] of held) { const hit = look(sid, slot); if (hit) return hit; }
  for (const t of taken.values()) { const hit = look(t.sid, t.entries); if (hit) return hit; }
  return waiting;
}

/** Where a note with this message id waits now, or null. */
export function waitingNote(mid: string): { sid: string; key: string; at: number; part: unknown } | null {
  const find = (sid: string, entries: Iterable<[string, Held]>) => {
    for (const [key, v] of entries) {
      const part = v.parts?.find((p) => metaOf(p).mid === mid);
      if (part) return { sid, key, at: metaOf(part).at ?? v.at, part };
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

function validTell(v: unknown): DropTell | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (typeof t.callerSid !== 'string' || typeof t.op !== 'string' || typeof t.reason !== 'string') return null;
  return {
    callerSid: t.callerSid, op: t.op, taskId: typeof t.taskId === 'string' ? t.taskId : '', reason: t.reason,
    at: typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : Date.now(),
    tries: typeof t.tries === 'number' && Number.isFinite(t.tries) ? t.tries : 0,
    ...(typeof t.mid === 'string' ? { mid: t.mid } : {}),
    ...(typeof t.fromTask === 'string' ? { fromTask: t.fromTask } : {}),
    ...(t.kind === 'waiting' || t.kind === 'dropped' ? { kind: t.kind } : {}),
    ...(t.subject === 'message' ? { subject: 'message' as const } : {}),
  };
}

/** The file's notices, fates and tells, or null when it is not a file this version reads. */
function parseFile(raw: string): { sessions: Array<[string, string, Held]>; fates: Array<[string, NoteFate]>; tells: DropTell[] } | null {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || (doc as { version?: unknown }).version !== VERSION) return null;
  const d = doc as { sessions?: unknown; fates?: unknown; tells?: unknown };
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
  const told = (Array.isArray(d.tells) ? d.tells : []).map(validTell).filter((t): t is DropTell => !!t);
  return { sessions, fates: out, tells: told };
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
      // Senders a dropped note was not yet told about: told with the next sweep's flush.
      tells.unshift(...(file?.tells ?? []));
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

/** Whether this process opened the file (the server): only it delivers what waited too long. */
export function storeOpened(): boolean {
  return opened;
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
  const tellsNow = [...tellsOut, ...tells];
  return JSON.stringify({ version: VERSION, sessions, fates: Object.fromEntries(fates), ...(tellsNow.length ? { tells: tellsNow } : {}) });
}

/** A write this large or slow is logged: the whole state is serialized on the event loop. */
const BIG_WRITE_BYTES = 1024 * 1024;
const SLOW_WRITE_MS = 50;

/**
 * Write what waits now. Resolves once a write that started after this call is on disk (writes are
 * coalesced: a change made while one is queued rides it): true when it is, false when it is not (a
 * failed write is logged and the notices still wait in memory; a boot that cannot write keeps them
 * in memory only). Never rejects. A no-op (true) until the file was opened.
 */
export function persist(): Promise<boolean> {
  if (!opened) return Promise.resolve(true);
  if (queuedWrite) return queuedWrite;
  const gen = generation;
  const next: Promise<boolean> = writeChain.then(async () => {
    if (queuedWrite === next) queuedWrite = null;
    try {
      // Never before the file's own notices are in memory: they would be written over.
      await loading;
      if (gen !== generation) return true;
      if (!writable) return false;
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
      return true;
    } catch (err) {
      log.session.warn('held notices: not saved', { error: err instanceof Error ? err.message : String(err) });
      return false;
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
  tells.length = 0;
  tellsOut.clear();
  quietWaitWhy.clear();
  opened = false;
  writable = true;
  loaded = false;
  loading = null;
  queuedWrite = null;
  writeChain = Promise.resolve();
  if (removeFile && wasOpen) fs.rmSync(storeFile(), { force: true });
}
