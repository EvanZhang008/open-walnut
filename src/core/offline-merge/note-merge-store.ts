/**
 * The Mac's notes drain keeps two small stores beside the vault (src/core/offline-merge/notes.ts,
 * docs/plan/walnut-replica-servers-impl.md section 6), in WALNUT_HOME/cache:
 *
 *   - note-write-times.json: per note, the time a replay wrote it last and the hash it
 *     left, so the note's own time is that replay's when it still holds that text (the
 *     file's mtime otherwise), never the drain's wall clock;
 *   - note-merge/: one merge context per note (the base, every version merged so far,
 *     the text the last replay left), with the versions' bodies by sha256.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { NoteDrainDeps } from './notes.js';

export function sha256(body: string | Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Write a file whole: tmp then rename, so a reader never sees half of it. The temp name
 * is short and its own (a dot file beside the target): `<name>.<pid>.<hex>.tmp` of a note
 * whose name is near the 255-byte limit is too long itself (ENAMETOOLONG on every retry).
 */
export async function writeWhole(target: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(target), `.wn-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.rename(tmp, target);
}

export async function readText(abs: string): Promise<string | null> {
  try { return await fsp.readFile(abs, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ── the per-note side table: the time a replay wrote a note last ──

interface SideRow { at: number; hash: string; path: string }
interface SideTable { v: 1; notes: Record<string, SideRow> }

/** Side table writes of this process, one after another (several hosts drain at once). */
let sideChain: Promise<unknown> = Promise.resolve();

function sideFile(deps: NoteDrainDeps): string { return path.join(deps.cacheDir, 'note-write-times.json'); }

async function loadSide(deps: NoteDrainDeps): Promise<SideTable> {
  const raw = await readText(sideFile(deps));
  if (raw === null) return { v: 1, notes: {} };
  try {
    const t = JSON.parse(raw) as SideTable;
    return t && typeof t.notes === 'object' && t.notes ? { v: 1, notes: t.notes } : { v: 1, notes: {} };
  } catch { return { v: 1, notes: {} }; }
}

function sideKeys(rel: string, noteId: string | undefined): string[] {
  return [`path:${rel}`, ...(noteId ? [`id:${noteId}`] : [])];
}

/** The time a replay wrote this text at this note last, or null (the Mac wrote it). */
export async function replayTimeOf(deps: NoteDrainDeps, rel: string, noteId: string | undefined, text: string): Promise<number | null> {
  const t = await loadSide(deps);
  const hash = sha256(text);
  for (const k of sideKeys(rel, noteId).reverse()) {
    const row = t.notes[k];
    if (row && row.hash === hash) return row.at;
  }
  return null;
}

/** Remember that a replay left `text` at the note (by path and by id), at `at`. */
export function noteReplayTime(deps: NoteDrainDeps, rel: string, noteId: string | undefined, text: string | null, at: number): Promise<void> {
  const run = sideChain.then(async () => {
    const t = await loadSide(deps);
    for (const k of sideKeys(rel, noteId)) {
      if (text === null) delete t.notes[k];
      else t.notes[k] = { at, hash: sha256(text), path: rel };
    }
    // A table of every note ever replayed stays small: the oldest go past 5,000 rows.
    const keys = Object.keys(t.notes);
    if (keys.length > 5_000) {
      keys.sort((a, b) => t.notes[a].at - t.notes[b].at);
      for (const k of keys.slice(0, keys.length - 5_000)) delete t.notes[k];
    }
    await writeWhole(sideFile(deps), JSON.stringify(t));
  });
  sideChain = run.catch(() => undefined);
  return run;
}

// ── merge contexts: what the replays of one note merged so far ──

export interface CtxVersion {
  key: string;
  /** sha256 of the version's text (its body in note-merge/bodies). */
  sha: string;
  at: number;
  /** The host label its conflict copy carries ("Mac" for the Mac's own). */
  label: string;
  /** The conflict copy already written for it (vault-relative), when it lost a region. */
  copied?: string;
}

export interface MergeCtx {
  v: 1;
  key: string;
  /** sha256 of the base the versions forked from; 'none' for creates. */
  base: string;
  /** sha256 of the text the last replay left at the note; 'deleted' when it removed it. */
  result: string;
  versions: CtxVersion[];
  /** A replay created the note (no base). */
  created?: true;
  /** A replay deleted the note: the deleting version's key (an edit of the same base restores it). */
  deletedBy?: string;
  /** Versions a later save of the same host replaced: a redrain of one is a no-op, never a version again. */
  gone?: string[];
  /** Wall time of the last change, for pruning only. */
  touchedAt: number;
}

const CTX_TTL_MS = 30 * 24 * 60 * 60_000;

function ctxDir(deps: NoteDrainDeps): string { return path.join(deps.cacheDir, 'note-merge'); }
function ctxFile(deps: NoteDrainDeps, key: string): string { return path.join(ctxDir(deps), `${sha256(key).slice(0, 24)}.json`); }
function bodyFile(deps: NoteDrainDeps, sha: string): string { return path.join(ctxDir(deps), 'bodies', sha); }

export async function loadCtx(deps: NoteDrainDeps, key: string): Promise<MergeCtx | null> {
  const raw = await readText(ctxFile(deps, key));
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as MergeCtx;
    return c && c.key === key && Array.isArray(c.versions) ? c : null;
  } catch { return null; }
}

export async function putBody(deps: NoteDrainDeps, text: string): Promise<string> {
  const sha = sha256(text);
  const target = bodyFile(deps, sha);
  try { await fsp.access(target); } catch { await writeWhole(target, text); }
  return sha;
}

export async function getBody(deps: NoteDrainDeps, sha: string): Promise<string> {
  const text = await readText(bodyFile(deps, sha));
  if (text === null || sha256(text) !== sha) throw new Error(`note merge: the kept version ${sha.slice(0, 12)} is missing`);
  return text;
}

/** Save a context, drop contexts past their TTL, and free bodies no context names. */
export async function saveCtx(deps: NoteDrainDeps, ctx: MergeCtx): Promise<void> {
  ctx.touchedAt = Date.now();
  await writeWhole(ctxFile(deps, ctx.key), JSON.stringify(ctx));
  let names: string[] = [];
  try { names = await fsp.readdir(ctxDir(deps)); } catch { return; }
  const used = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(ctxDir(deps), name);
    let c: MergeCtx | null = null;
    try { c = JSON.parse(await fsp.readFile(file, 'utf8')) as MergeCtx; } catch { continue; }
    if (!c || !Array.isArray(c.versions)) continue;
    if (Date.now() - (c.touchedAt ?? 0) > CTX_TTL_MS) { await fsp.rm(file, { force: true }); continue; }
    if (c.base !== 'none') used.add(c.base);
    for (const v of c.versions) used.add(v.sha);
  }
  let bodies: string[] = [];
  try { bodies = await fsp.readdir(path.join(ctxDir(deps), 'bodies')); } catch { return; }
  for (const b of bodies) if (/^[0-9a-f]{64}$/.test(b) && !used.has(b)) await fsp.rm(path.join(ctxDir(deps), 'bodies', b), { force: true });
}
