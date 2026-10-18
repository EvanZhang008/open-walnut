/**
 * Applying a journal `note` record on the Mac (docs/plan/walnut-replica-servers-impl.md
 * section 6, the table). One record, under the note's file lock, after the path is
 * resolved: the record's `noteId` (frontmatter `id`) through the notes index FIRST, the
 * record path second, so a note renamed or moved on the Mac merges at its new path.
 *
 *   Mac now                                 result                                letter
 *   bytes == ours                           nothing                               no
 *   hash == base                            write ours (Mac's id: line kept)      no
 *   changed, merges clean                   write the merge                       no
 *   changed, conflicting regions            newer side per region in the note,    yes
 *                                           the other version as a conflict copy
 *   merge over budget / worker deadline     the whole note is one region          yes
 *   missing, base present (Mac deleted)     ours as a conflict copy               yes
 *   exists, mode create, differs            Mac's kept, ours as a conflict copy   yes
 *   missing, mode create                    write ours                            no
 *   two creates of one new path (away)      the newer is the note, the other a copy yes
 *   mode delete, hash == base               delete                                no
 *   mode delete, Mac edited since base      Mac's kept (edit beats delete)        yes
 *
 * Drain order: two hosts and the companion may hand over edits of the same note in
 * any order. A plain chain of three-way merges is not order independent (a region one
 * side's edit forms with a second side's edit decides which third edit conflicts). So
 * the drain keeps a MERGE CONTEXT per note (`cache/note-merge/`): the base the edits
 * forked from, the Mac's own version, every side merged so far, and the text the last
 * replay left. A record of the same base onto that text merges ALL of them again, as
 * one N-way merge ranked by time (`mergeVersions`), so the note never depends on which
 * host came back first. A record whose base is a side's text (the same host saved
 * again on top of it) replaces that side. A Mac edit since the last replay (the note
 * is not the text the context left) starts a new context: the Mac's version is then
 * the note as it is, timed by the side table.
 *
 * Times: a replay's time is the record's `at` shifted to this Mac's clock. The note's
 * own time is the per-note side table's (`cache/note-write-times.json`) when a replay
 * wrote it last, else the file's mtime: never the drain's wall clock.
 *
 * Nothing is lost: every version that loses a region keeps a conflict copy beside the
 * note (`<stem> (conflict <host> <YYYY-MM-DD HHmm>).md`, ` 2`, ` 3` on a clash, the stem
 * cut so the name stays within 255 bytes, its id line removed so the copy gets its own
 * id), and both sides go to the durable conflict
 * log in full before the record is acked. A real conflict is the only thing that makes
 * a copy or a letter entry.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MergeVersion, VersionsResult } from '../../lib/three-way-merge.js';
import type { ConflictEntry } from './conflict-log.js';
import {
  getBody, loadCtx, noteReplayTime, putBody, readText, replayTimeOf, saveCtx, sha256, writeWhole,
  type CtxVersion, type MergeCtx,
} from './note-merge-store.js';

export { sha256 };

export type NoteMode = 'put' | 'create' | 'delete';

export interface NoteRecordLike {
  seq: number;
  at: number;
  opId?: string;
  rev?: number;
  actor?: unknown;
  path: string;
  noteId?: string;
  mode: NoteMode;
  baseHash?: string | null;
  baseBlob?: string | null;
  oursBlob?: string | null;
}

export interface NoteDrainDeps {
  /** The vault root (NOTES_DIR). */
  root: string;
  /** Where the side table and the merge contexts live (WALNUT_HOME/cache). */
  cacheDir: string;
  /** The label conflict copies carry for this record's host ("Mac" for the Mac's own). */
  hostLabel: string;
  /** The host key, for the context's version keys. */
  hostKey: string;
  fetchBlob: (sha: string) => Promise<Buffer>;
  merge: (base: string, versions: MergeVersion[], opts: { idFrom?: string; eolFrom?: string; wholeNote?: boolean }) => Promise<VersionsResult & { timedOut?: true }>;
  /** The vault-relative path the notes index holds for a note id, or undefined. */
  pathOfId: (noteId: string) => string | undefined;
  /** Run `fn` under the note file's lock (withUserFileLock on the Mac). */
  lock: <T>(abs: string, fn: () => Promise<T>) => Promise<T>;
  /** A note was written (the NOTES_UPDATED event and the index update). */
  written: (rel: string, content: string, created: boolean) => Promise<void> | void;
  /** Delete the note through the notes delete route's code. */
  remove: (rel: string) => Promise<void>;
  /**
   * The text with an id: its own when it has one, else `current`'s, else a fresh one
   * (withNoteId on the Mac, what its own save routes do with every body).
   */
  ensureId: (content: string, current: string | null) => string;
  /** Format a time for a copy's name (local `YYYY-MM-DD HHmm`). */
  stamp?: (at: number) => string;
}

export interface NoteOutcome {
  action: 'noop' | 'fast-forward' | 'merged' | 'conflict' | 'created' | 'deleted' | 'kept' | 'restored' | 'copied';
  /** The vault-relative path the record landed at (after the id was resolved). */
  path: string;
  /** Conflict copies this record wrote. */
  copies: string[];
  /** Entries for the conflict log (and so the letter): empty unless a real conflict. */
  entries: ConflictEntry[];
}

// ── helpers ──

/** Note applies of this process, one at a time (contexts share one bodies dir). */
let noteChain: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = noteChain.then(fn);
  noteChain = run.catch(() => undefined);
  return run;
}

/** A vault-relative note path (forward slashes, `.md`), or null when it leaves the vault. */
export function noteRel(raw: string): string | null {
  let s = String(raw ?? '').split('\\').join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!s) return null;
  if (!/\.md$/i.test(s)) s += '.md';
  if (s.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return s;
}

function localStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function cleanLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9 ._-]+/g, '-').trim().slice(0, 40) || 'host';
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * The text without its frontmatter `id:` line (a conflict copy gets its own id). A block
 * that held the id alone goes with it, so the copy's own id makes the same block again.
 */
export function withoutIdLine(text: string): string {
  const m = FRONTMATTER.exec(text);
  if (!m) return text;
  const head = m[0].replace(/\r?\nid:[^\r\n]*/, '');
  if (/^---\r?\n---(?:\r?\n|$)$/.test(head)) return text.slice(m[0].length);
  return head + text.slice(m[0].length);
}

/** The frontmatter id of a text, or undefined. */
function idOf(text: string | null): string | undefined {
  if (!text) return undefined;
  const m = FRONTMATTER.exec(text);
  if (!m) return undefined;
  const line = /\r?\nid:[ \t]*([^\r\n]*)/.exec(m[0]);
  const v = line ? line[1].trim().replace(/^["']|["']$/g, '') : '';
  return v || undefined;
}

/** Same note text, the id line aside (a write the Mac stamped an id into is still ours). */
function sameNote(a: string, b: string): boolean {
  return a === b || withoutIdLine(a).replace(/\r\n/g, '\n') === withoutIdLine(b).replace(/\r\n/g, '\n');
}

async function mtimeOf(abs: string): Promise<number> {
  try { return (await fsp.stat(abs)).mtimeMs; } catch { return 0; }
}

/** Longest file name, in UTF-8 bytes, the file systems a vault lives on take (APFS, ext4). */
const NAME_MAX_BYTES = 255;
/** The longest clash suffix a copy name takes (` 999`, the loop's last). */
const CLASH_SUFFIX_BYTES = 4;

/** `s` cut to at most `max` UTF-8 bytes, never inside a code point (so still valid UTF-8). */
export function cutUtf8(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** A conflict copy beside `rel`: its name, or the existing file a redrain already wrote. */
async function writeCopy(deps: NoteDrainDeps, rel: string, label: string, at: number, text: string): Promise<string> {
  const dir = path.posix.dirname(rel);
  const tail = ` (conflict ${cleanLabel(label)} ${(deps.stamp ?? localStamp)(at)})`;
  // A note whose name is near the limit: its stem is cut so the copy's whole file name,
  // clash suffix and `.md` included, still fits (else ENAMETOOLONG on every retry).
  const room = NAME_MAX_BYTES - Buffer.byteLength(tail) - CLASH_SUFFIX_BYTES - '.md'.length;
  const stem = cutUtf8(path.posix.basename(rel).replace(/\.md$/i, ''), Math.max(1, room));
  const name = `${stem}${tail}`;
  const body = withoutIdLine(text);
  for (let n = 1; n < 1000; n++) {
    const file = `${n === 1 ? name : `${name} ${n}`}.md`;
    const copyRel = dir === '.' ? file : `${dir}/${file}`;
    const abs = path.join(deps.root, copyRel);
    const existing = await readText(abs);
    if (existing !== null) {
      if (sameNote(withoutIdLine(existing), body)) return copyRel;
      continue;
    }
    const content = deps.ensureId(body, null);
    await writeWhole(abs, content);
    await deps.written(copyRel, content, true);
    return copyRel;
  }
  throw new Error(`note merge: no free conflict copy name beside ${rel}`);
}

// ── the record ──

export interface NoteApplyHooks {
  /** Durable conflict-log entries, written BEFORE the note or a copy is (a crash re-letters, never loses). */
  conflicts: (entries: ConflictEntry[]) => void;
}

function entryOf(record: NoteRecordLike, e: Partial<ConflictEntry>): ConflictEntry {
  return {
    kind: 'note', seq: record.seq, ...(record.opId ? { opId: record.opId } : {}), recordKind: 'note',
    ...(record.actor ? { actor: record.actor } : {}), ...e,
  } as ConflictEntry;
}

/**
 * Apply one `note` record (its `at` already on this Mac's clock). Throws on a host
 * that cannot hand over a body, a vault write that fails, or a path outside the vault
 * (the batch retries and then gives the record up into the conflict log, attached).
 */
export function applyNoteRecord(deps: NoteDrainDeps, hooks: NoteApplyHooks, record: NoteRecordLike, at: number): Promise<NoteOutcome> {
  return serial(() => applyNote(deps, hooks, record, at));
}

async function applyNote(deps: NoteDrainDeps, hooks: NoteApplyHooks, record: NoteRecordLike, at: number): Promise<NoteOutcome> {
  const recRel = noteRel(record.path);
  if (!recRel) throw new Error(`note record names a path outside the vault: ${String(record.path)}`);
  // Bodies first, outside the lock: a slow host never holds the note.
  const base = record.baseBlob ? (await deps.fetchBlob(record.baseBlob)).toString('utf8') : null;
  const ours = record.oursBlob ? (await deps.fetchBlob(record.oursBlob)).toString('utf8') : null;
  // The note id first: a note renamed or moved on the Mac is merged where it is now. Only
  // an id the record's base carries (the host's copy of the note had it): an id typed into
  // a saved body never sends the write to another note.
  const byId = record.noteId && idOf(base) === record.noteId ? deps.pathOfId(record.noteId) : undefined;
  const candidates = [...new Set([byId ? noteRel(byId) : null, recRel].filter((x): x is string => !!x))];
  let rel = recRel;
  for (const c of candidates) {
    if ((await readText(path.join(deps.root, c))) !== null) { rel = c; break; }
  }
  const abs = path.join(deps.root, rel);
  if (!abs.startsWith(deps.root + path.sep)) throw new Error(`note record names a path outside the vault: ${rel}`);
  return deps.lock(abs, async () => {
    const mac = await readText(abs);
    const ctxKey = record.noteId ? `id:${record.noteId}` : `path:${rel}`;
    const out: NoteOutcome = { action: 'noop', path: rel, copies: [], entries: [] };
    const vkey = `${deps.hostKey}/${record.opId ?? `seq-${record.seq}`}`;
    const note = (e: Partial<ConflictEntry>): void => { out.entries.push(entryOf(record, { notePath: rel, ...e })); };
    if (record.mode === 'delete') return applyDelete(deps, hooks, out, { record, rel, abs, mac, base, ctxKey, vkey, at, note });
    if (ours === null) throw new Error('a note save without its body');
    if (record.mode === 'create' || base === null) return applyCreate(deps, hooks, out, { record, rel, abs, mac, ours, ctxKey, vkey, at, note });
    return applyPut(deps, hooks, out, { record, rel, abs, mac, base, ours, ctxKey, vkey, at, note });
  });
}

interface Step {
  record: NoteRecordLike;
  rel: string;
  abs: string;
  mac: string | null;
  ctxKey: string;
  vkey: string;
  at: number;
  note: (e: Partial<ConflictEntry>) => void;
}

async function applyDelete(deps: NoteDrainDeps, hooks: NoteApplyHooks, out: NoteOutcome, s: Step & { base: string | null }): Promise<NoteOutcome> {
  if (s.mac === null) return out; // gone already
  const prior = await loadCtx(deps, s.ctxKey);
  // A delete drained already (an ack lost in a crash): nothing to do, no second letter.
  if (prior?.gone?.includes(s.vkey)) return out;
  // The note is what the replays left: the delete joins their context.
  const live = prior && !prior.created && prior.result === sha256(s.mac) ? prior : null;
  let unchanged = s.base !== null ? sameNote(s.mac, s.base) : sha256(s.mac).slice(0, 12) === s.record.baseHash;
  if (unchanged && live && s.base !== null) {
    // Edit beats delete, whatever came first: any other side's edit in this context (even
    // one that lost every line to the deleting side) or a Mac edit keeps the note, as it
    // does when that edit drains after the delete (the restore below).
    // A version equal to the context's base changed nothing: it is no edit to keep the note for.
    const own = sha256(s.base);
    const others = live.versions.filter((v) => v.key !== 'mac' && v.key !== s.vkey && v.sha !== own && v.sha !== live.base);
    const macV = live.versions.find((v) => v.key === 'mac');
    const macEdited = !!macV && live.base !== 'none' && !sameNote(await getBody(deps, macV.sha), await getBody(deps, live.base));
    if (others.length > 0 || macEdited) unchanged = false;
  }
  if (!unchanged) {
    // Edit beats delete for documents: the Mac's text stays, the user hears of the delete.
    s.note({ why: 'delete-kept', kept: 'mac', base: s.base ?? undefined, mac: s.mac, replicaAt: s.at, reason: 'the note was deleted while away, but it was edited since; the note is kept' });
    hooks.conflicts(out.entries);
    if (live) await saveCtx(deps, { ...live, gone: [...(live.gone ?? []), s.vkey].slice(-500) });
    out.action = 'kept';
    return out;
  }
  // The delete keeps the replays' context, so an edit of the same base drained later
  // restores the same text as if it had come first.
  const macAt = live ? 0 : (await replayTimeOf(deps, s.rel, idOf(s.mac), s.mac)) ?? (await mtimeOf(s.abs));
  const macSha = await putBody(deps, s.mac);
  const baseSha = live ? live.base : await putBody(deps, s.base ?? s.mac);
  await deps.remove(s.rel);
  await noteReplayTime(deps, s.rel, idOf(s.mac), null, s.at);
  // The save this delete was made on (its host's earlier record, whose text is the delete's
  // base) is drained too: its redrain must not bring the note back. Its text stays a version,
  // so an edit from another side restores the same note in any order.
  // Only this host's own versions: another side's save with the same text is no base of this one.
  const superseded = live && s.base !== null ? live.versions.filter((v) => sameHost(deps, v.key) && v.sha === sha256(s.base!)).map((v) => v.key) : [];
  await saveCtx(deps, live ? { ...live, result: 'deleted', deletedBy: s.vkey, gone: [...(live.gone ?? []), ...superseded, s.vkey].slice(-500) } : {
    v: 1, key: s.ctxKey, base: baseSha, result: 'deleted', deletedBy: s.vkey, gone: [s.vkey], touchedAt: Date.now(),
    versions: [{ key: 'mac', sha: macSha, at: macAt, label: 'Mac' }],
  });
  out.action = 'deleted';
  return out;
}

type TextVersion = CtxVersion & { text: string };

/** The note changed on the Mac while it was merged (a writer without the file lock): the batch tries again. */
class NoteChangedDuringMerge extends Error {
  constructor(rel: string) { super(`the note changed on this Mac while it was merged: ${rel}`); this.name = 'NoteChangedDuringMerge'; }
}

/** Whether a context version key is one of this host's records (`<hostKey>/<op>`; the Mac's is `mac`). */
function sameHost(deps: NoteDrainDeps, key: string): boolean {
  return key.startsWith(`${deps.hostKey}/`);
}

async function withTexts(deps: NoteDrainDeps, versions: CtxVersion[]): Promise<TextVersion[]> {
  const out: TextVersion[] = [];
  for (const v of versions) out.push({ ...v, text: await getBody(deps, v.sha) });
  return out;
}

async function applyCreate(deps: NoteDrainDeps, hooks: NoteApplyHooks, out: NoteOutcome, s: Step & { ours: string }): Promise<NoteOutcome> {
  const own: TextVersion = { key: s.vkey, sha: sha256(s.ours), at: s.at, label: deps.hostLabel, text: s.ours };
  if (s.mac === null) return settle(deps, hooks, out, s, '', 'none', [own], null, { created: true });
  const ctx = await loadCtx(deps, s.ctxKey);
  // Joined even when ours is the note already: its time ranks it among the creates.
  if (ctx && ctx.created && ctx.base === 'none' && ctx.result === sha256(s.mac)) {
    // Two creates of one new note while away: never diffed against an empty base; the newer one is the note.
    const kept = await withTexts(deps, ctx.versions.filter((v) => v.key !== s.vkey));
    return settle(deps, hooks, out, s, '', 'none', [...kept, own], ctx, { created: true, wholeNote: true });
  }
  if (sameNote(s.mac, s.ours)) return out;
  // The Mac has its own note at that path: it stays, ours is the copy.
  const copyRel = await writeCopy(deps, s.rel, deps.hostLabel, s.at, s.ours);
  out.copies.push(copyRel);
  s.note({ why: 'create-exists', kept: 'mac', mac: s.mac, replica: s.ours, replicaAt: s.at, copyPath: copyRel, reason: 'a note made while away has the path of a note on the Mac; it is kept as a copy' });
  hooks.conflicts(out.entries);
  out.action = 'copied';
  return out;
}

async function applyPut(deps: NoteDrainDeps, hooks: NoteApplyHooks, out: NoteOutcome, s: Step & { base: string; ours: string }): Promise<NoteOutcome> {
  const own: TextVersion = { key: s.vkey, sha: sha256(s.ours), at: s.at, label: deps.hostLabel, text: s.ours };
  const baseSha = sha256(s.base);
  const ctx = await loadCtx(deps, s.ctxKey);
  // A save a later save of its host already replaced (an ack lost in a crash): drained, nothing to do.
  if (ctx?.gone?.includes(s.vkey)) return out;
  // The host's own earlier save this one was made on. Never another side's version with the
  // same text (two hosts making the same change): dropping it would change the merge by
  // the order the records came in (the notes property run, seed 1138913017).
  const chained = ctx && ctx.base !== 'none' ? ctx.versions.find((v) => sameHost(deps, v.key) && v.sha === baseSha) : undefined;
  // This record merged already (a redrain before its ack): it joins its context again, so
  // its changes are never applied a second time on top of the note that holds them.
  const present = !!ctx && ctx.base !== 'none' && ctx.versions.some((v) => v.key === s.vkey);
  if (s.mac === null) {
    // A save that changed nothing from its base is no edit: it brings no deleted note back and
    // needs no copy, so a delete drained before it ends the same as one drained after it.
    if (sameNote(s.ours, s.base)) return out;
    if (ctx && ctx.deletedBy && ctx.result === 'deleted' && (ctx.base === baseSha || chained || present)) {
      // A delete replayed from the same base: the edit beats it, the note comes back.
      const base = ctx.base === baseSha ? s.base : await getBody(deps, ctx.base);
      const drop = ctx.base === baseSha ? undefined : chained?.key;
      const kept = await withTexts(deps, ctx.versions.filter((v) => v.key !== s.vkey && v.key !== drop));
      return settle(deps, hooks, out, s, base, ctx.base, [...kept, own], ctx, { restored: true, drop });
    }
    // The Mac deleted it: the edit is not lost, the path stays deleted.
    const copyRel = await writeCopy(deps, s.rel, deps.hostLabel, s.at, s.ours);
    out.copies.push(copyRel);
    s.note({ why: 'mac-deleted', kept: 'mac', base: s.base, replica: s.ours, replicaAt: s.at, copyPath: copyRel, reason: 'the note was deleted on the Mac; the change made while away is kept as a copy' });
    hooks.conflicts(out.entries);
    out.action = 'copied';
    return out;
  }
  // A save equal to the note still joins the merge (settle writes nothing then): its time
  // ranks it among the other versions, so the note never depends on which came first.
  const macSha = sha256(s.mac);
  if (ctx && !ctx.created && ctx.result === macSha && (ctx.base === baseSha || chained || present)) {
    // The note is what the last replay left: merge every version of this base again.
    const base = ctx.base === baseSha ? s.base : await getBody(deps, ctx.base);
    const drop = ctx.base === baseSha ? undefined : chained?.key;
    const kept = await withTexts(deps, ctx.versions.filter((v) => v.key !== s.vkey && v.key !== drop));
    return settle(deps, hooks, out, s, base, ctx.base, [...kept, own], ctx, { drop });
  }
  const macAt = (await replayTimeOf(deps, s.rel, idOf(s.mac), s.mac)) ?? (await mtimeOf(s.abs));
  const macVersion: TextVersion = { key: 'mac', sha: macSha, at: macAt, label: 'Mac', text: s.mac };
  return settle(deps, hooks, out, s, s.base, baseSha, [macVersion, own], null, {});
}

/**
 * Merge `versions` over `base`, write a conflict copy for every version that lost a
 * region and has none yet, letter those, then write the note and keep the context.
 * Order on disk: copies, the conflict log, the note, the context. A crash in between
 * redrains to the same copies (found by name and text), never a lost version.
 */
async function settle(
  deps: NoteDrainDeps, hooks: NoteApplyHooks, out: NoteOutcome, s: Step,
  base: string, baseKey: string, versions: TextVersion[], prior: MergeCtx | null,
  extra: { created?: true; wholeNote?: true; restored?: true; drop?: string },
): Promise<NoteOutcome> {
  const hasMac = versions.some((v) => v.key === 'mac');
  const r = await deps.merge(base, versions.map((v) => ({ key: v.key, text: v.text, at: v.at })), {
    ...(hasMac ? { idFrom: 'mac', eolFrom: 'mac' } : {}), ...(extra.wholeNote ? { wholeNote: true } : {}),
  });
  // A writer that takes no file lock (an editor, a session's Edit tool) may have changed the
  // note during the merge (up to 2 s in the worker): merge again from its text, never over it.
  if ((await readText(s.abs)) !== s.mac) throw new NoteChangedDuringMerge(s.rel);
  const copied = new Map<string, string>();
  for (const v of prior?.versions ?? []) if (v.copied) copied.set(v.key, v.copied);
  const byKey = new Map(versions.map((v) => [v.key, v]));
  const why = extra.created && extra.wholeNote ? 'create-both' : r.timedOut ? 'deadline' : r.overBudget ? 'over-budget' : 'conflict';
  for (const loser of r.losers) {
    if (copied.has(loser)) continue;
    const v = byKey.get(loser);
    if (!v) continue;
    const copyRel = await writeCopy(deps, s.rel, v.label, v.at, r.wins[loser]);
    copied.set(loser, copyRel);
    out.copies.push(copyRel);
    s.note({
      why, kept: loser === 'mac' ? 'replica' : 'mac', copyPath: copyRel, lostVersion: loser,
      base, mac: s.mac ?? undefined, replica: byKey.get(s.vkey)?.text, macAt: byKey.get('mac')?.at, replicaAt: s.at,
      reason: why === 'conflict'
        ? `both sides changed the same lines; the newer change is in the note, the other version is in ${copyRel}`
        : why === 'create-both'
          ? `two notes were made at this path while away; the newer one is the note, the other is in ${copyRel}`
          : `the note was too large to merge line by line; the newer version is the note, the other is in ${copyRel}`,
    });
  }
  if (extra.restored) {
    s.note({ why: 'restored', kept: 'replica', base, replica: byKey.get(s.vkey)?.text, replicaAt: s.at, reason: 'the note was deleted and edited while away; the edit wins and the note is back' });
  }
  if (out.entries.length) hooks.conflicts(out.entries);
  // The note keeps the id it has on the Mac (a body saved without one keeps the note's, as the save routes do).
  // The same note, the id line aside, is not written: the Mac's bytes stay.
  let text = deps.ensureId(r.text, s.mac);
  const write = s.mac === null || !sameNote(text, s.mac);
  if (!write) text = s.mac!;
  const at = versions.reduce((n, v) => Math.max(n, v.at), 0);
  const gone = [...(prior?.gone ?? []), ...(extra.drop ? [extra.drop] : [])].slice(-500);
  // The context (bodies first) before the note: a failure after it (a full cache disk, a
  // restart) is retried against a context that already names this record, so the retry
  // merges the same versions to the same text instead of applying this record again.
  if (baseKey !== 'none') await putBody(deps, base);
  for (const v of versions) await putBody(deps, v.text);
  await saveCtx(deps, {
    v: 1, key: s.ctxKey, base: baseKey, result: sha256(text), touchedAt: Date.now(),
    versions: versions.map((v) => ({ key: v.key, sha: v.sha, at: v.at, label: v.label, ...(copied.has(v.key) ? { copied: copied.get(v.key) } : {}) })),
    ...(extra.created ? { created: true as const } : {}),
    ...(gone.length ? { gone } : {}),
  });
  if (write) {
    await writeWhole(s.abs, text);
    await deps.written(s.rel, text, s.mac === null);
    await noteReplayTime(deps, s.rel, idOf(text), text, at);
  }
  out.action = r.conflicts > 0 ? 'conflict' : extra.restored ? 'restored' : !write ? 'noop' : extra.created && s.mac === null ? 'created'
    : versions.length === 2 && hasMac && sameNote(byKey.get('mac')!.text, base) ? 'fast-forward' : 'merged';
  return out;
}

// ── on the Mac ──

/** The drain's deps on this Mac: the vault, the notes index, the file lock, the worker merge. */
export async function macNoteDeps(hostKey: string, conn: { send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> }): Promise<NoteDrainDeps> {
  const [constants, blob, worker, index, fileLock, frontmatter, events, indexer, notesRoute, tree] = await Promise.all([
    import('../../constants.js'), import('./blob.js'), import('./note-merge-worker.js'), import('../notes-index.js'),
    import('../../utils/user-file-lock.js'), import('../parse-frontmatter.js'), import('../event-bus.js'),
    import('../notes-indexer.js'), import('../../web/routes/notes-v2.js'), import('../notes-tree.js'),
  ]);
  const root = path.resolve(constants.NOTES_DIR);
  return {
    root,
    cacheDir: path.join(constants.WALNUT_HOME, 'cache'),
    hostLabel: hostKey,
    hostKey,
    fetchBlob: (sha) => blob.fetchOfflineBlob(conn, sha),
    merge: (base, versions, opts) => worker.mergeNoteOffLoop(base, versions, opts),
    pathOfId: (noteId) => { try { return index.getNotePathById(noteId); } catch { return undefined; } },
    lock: (abs, fn) => fileLock.withUserFileLock(abs, fn),
    written: (rel, content, created) => {
      // A file the drain made (a conflict copy, a note made away): every open tree shows it.
      if (created) {
        tree.invalidateNotesTree();
        events.bus.emit(events.EventNames.NOTES_TREE_CHANGED, { path: rel }, ['web-ui']);
      }
      // The notes routes' own contract: `notes/{path}` without `.md` (files-tools.ts, useNoteContent.ts).
      events.bus.emit(events.EventNames.NOTES_UPDATED, { source: `notes/${rel.replace(/\.md$/i, '')}`, contentHash: sha256(content).slice(0, 12) }, ['web-ui']);
      indexer.scheduleNotesIndexUpdate(rel);
    },
    remove: async (rel) => {
      await notesRoute.deleteNoteFile(path.join(root, rel));
      events.bus.emit(events.EventNames.NOTES_TREE_CHANGED, { path: rel }, ['web-ui']);
    },
    ensureId: (content, current) => frontmatter.withNoteId(content, current).content,
  };
}
