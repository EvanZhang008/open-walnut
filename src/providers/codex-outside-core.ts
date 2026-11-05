/**
 * Codex usage a Walnut session did not start: `codex exec` run from an agent's
 * shell, the desktop app, the terminal UI. Walnut keeps no session record for
 * those, so the per-session reads (session-cost-core.ts) never see them, yet they
 * spend tokens on whatever account Codex is signed in to.
 *
 * Read host-side from the rollout files Codex itself writes under
 * `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (and `archived_sessions`),
 * nothing else, and never written to. One rollout is one run: its first line
 * (`session_meta`) says who started it (`originator`), where (`cwd`) and on which
 * account (`model_provider`); the rest is folded exactly like a Walnut Codex
 * session's (one request per `token_count`, `foldCodexRollout`).
 *
 * A session id Walnut passes in `knownSessionIds` comes back as meta only: it is counted
 * from its own session record, and only its account is wanted. Every other run is folded,
 * `walnut` telling the ones Walnut started (originator `open-walnut`, a child thread Codex
 * made inside such a run included, which has no session record of its own) from the rest.
 * Newest files first, in pages of a time budget, so a first read of a large history never
 * holds one reply.
 */
import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bucketRows, dayZone, foldCodexRollout, type SessionCostBucket } from './session-cost-core.js';

export interface CodexOutsideRequest {
  codexHome?: string;
  /** Skip rollout files not modified since this instant (ISO); unset reads them all. */
  since?: string;
  /** Session ids Walnut has records for: reported as meta only. */
  knownSessionIds?: string[];
  thresholds?: number[];
  byDay: { timeZone: string };
  /** The `next` of the previous page: continue after this file name. */
  cursor?: string;
  /** Stop and return `next` after about this long (ms). */
  budgetMs?: number;
}

export interface CodexOutsideEntry {
  sessionId: string;
  originator: string;
  /** Codex's `model_provider`: the account its requests went through. */
  provider: string;
  cwd: string;
  /** False: the id is a Walnut session the server already reads (meta only, no buckets). */
  counted: boolean;
  /** Started by Walnut itself (originator `open-walnut`), also a child thread Codex made inside such a run. */
  walnut: boolean;
  buckets?: SessionCostBucket[];
  firstAt?: string;
  lastAt?: string;
}

export interface CodexOutsideScan {
  entries: CodexOutsideEntry[];
  /** Files looked at in this page, skipped ones included. */
  files: number;
  /** Rollout files that could not be read this time (at most 20 names): the caller reads them again before it trusts a `since`. */
  failed?: string[];
  /** Set when the budget ran out: ask again with this as `cursor`. */
  next?: string;
  byDay: { timeZone: string };
  scanMs: number;
}

/** Marker for the source twin: this sidecar has `scanCodexOutside` (codex-outside-v1). */
export const CODEX_OUTSIDE_SCAN = true;

const DEFAULT_BUDGET_MS = 20_000;
const MAX_ENTRIES = 400;
/** `session_meta` carries the whole base prompt (about 22 KB on a current Codex). */
const META_MAX_BYTES = 4 * 1024 * 1024;
const WALNUT_ORIGINATOR = 'open-walnut';

/**
 * Every rollout file under a Codex home, newest name first (the name starts with its start time).
 * A folder that does not exist is empty; one that exists and cannot be read is named in `failed`.
 */
async function rolloutFiles(codexHome: string): Promise<{ files: { file: string; name: string }[]; failed: string[] }> {
  const out: { file: string; name: string }[] = [];
  const failed: string[] = [];
  const list = async <T>(dir: string, read: () => Promise<T[]>): Promise<T[]> => {
    try { return await read(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && failed.length < 20) failed.push(`dir:${dir}`);
      return [];
    }
  };
  const take = async (dir: string) => {
    for (const entry of await list(dir, () => readdir(dir, { withFileTypes: true }))) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push({ file: path.join(dir, entry.name), name: entry.name });
    }
  };
  const numbered = async (dir: string) => (await list(dir, () => readdir(dir))).filter(n => /^\d+$/.test(n));
  const base = path.join(codexHome, 'sessions');
  await take(base);
  for (const y of await numbered(base)) for (const m of await numbered(path.join(base, y))) for (const d of await numbered(path.join(base, y, m))) {
    await take(path.join(base, y, m, d));
  }
  await take(path.join(codexHome, 'archived_sessions'));
  return { files: out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)), failed };
}

interface RolloutMeta { id: string; originator: string; provider: string; cwd: string; startedAt: string; child: boolean }

/** The first line of a rollout, read up to its newline only. A file that cannot be opened throws; one that is no rollout gives undefined. */
async function readMeta(file: string): Promise<RolloutMeta | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      const cut = slice.indexOf(0x0a);
      chunks.push(cut >= 0 ? slice.subarray(0, cut) : slice);
      total += bytesRead;
      if (cut >= 0 || total > META_MAX_BYTES) break;
    }
    let row: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try { row = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
    const p = row.payload;
    if (row.type !== 'session_meta' || !p || typeof p.id !== 'string' || !p.id) return undefined;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return { id: p.id, originator: str(p.originator), provider: str(p.model_provider), cwd: str(p.cwd),
      startedAt: str(p.timestamp) || str(row.timestamp), child: !!(str(p.parent_thread_id) || str(p.forked_from_id)) };
  } finally { await handle.close().catch(() => {}); }
}

export async function scanCodexOutside(req: CodexOutsideRequest): Promise<CodexOutsideScan> {
  const started = Date.now();
  const budget = req.budgetMs && req.budgetMs > 0 ? req.budgetMs : DEFAULT_BUDGET_MS;
  const home = req.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const zone = dayZone(req.byDay.timeZone);
  const since = req.since ? Date.parse(req.since) : NaN;
  const known = new Set(req.knownSessionIds ?? []);
  const thresholds = req.thresholds ?? [];
  const entries: CodexOutsideEntry[] = [];
  let files = 0;
  let last: string | undefined;
  let next: string | undefined;
  const listing = await rolloutFiles(home);
  const failed: string[] = [...listing.failed];
  for (const { file, name } of listing.files) {
    if (req.cursor && name >= req.cursor) continue;
    // Stop only after a file was read, so a page always moves the cursor forward.
    if (last && (entries.length >= MAX_ENTRIES || Date.now() - started > budget)) { next = last; break; }
    files++;
    last = name;
    try {
      if (Number.isFinite(since) && (await stat(file)).mtimeMs < since) continue;
      const meta = await readMeta(file);
      if (!meta) continue;
      const seen = known.has(meta.id);
      const entry: CodexOutsideEntry = { sessionId: meta.id, originator: meta.originator, provider: meta.provider, cwd: meta.cwd,
        counted: !seen, walnut: meta.originator === WALNUT_ORIGINATOR };
      if (!seen) {
        const fold = await foldCodexRollout(file);
        // A thread forked from another can carry its parent's history, with the parent's own times: only what
        // happened after the thread began is its own.
        const rows = meta.child && meta.startedAt ? fold.rows.filter(r => r.undated || r.at >= meta.startedAt) : fold.rows;
        entry.buckets = bucketRows(rows, thresholds, zone);
        if (rows.length) {
          let first = rows[0].at, latest = first;
          for (const r of rows) { if (r.at < first) first = r.at; if (r.at > latest) latest = r.at; }
          entry.firstAt = first; entry.lastAt = latest;
        }
      }
      entries.push(entry);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && failed.length < 20) failed.push(name); } // the caller reads it again before it trusts a `since`
  }
  return { entries, files, ...(failed.length ? { failed } : {}), ...(next ? { next } : {}), byDay: { timeZone: zone }, scanMs: Date.now() - started };
}
