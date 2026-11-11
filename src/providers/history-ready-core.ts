/**
 * A session's ready view, built next to its transcript ('history-ready-v1').
 *
 * The history route's first paint (P1) used to have nothing to show for a session it had never
 * served: a remote one waited for its host to ship a 4 MB tail and the ten-turn backfill, and the
 * 128 KiB preview that replaced it was often all notices (2026-11-10: 3.2 s cold, 7.9 s when the
 * tail held only agent notices). This module runs INSIDE the host's daemon: it reads the tail of
 * the session's transcript from local disk, parses it with the ONE parser the server uses
 * (src/core/history-parse.ts, same options, the asking server's legacy-hint cutoff), and answers
 * the newest rows that make a readable first paint. Only those rows cross the link, gzipped.
 *
 * What it guarantees:
 *   - Never a rewound branch. A session with recorded in-place rewinds is parsed with the dead
 *     set the rewind probe computes over the WHOLE file (transcript-rewind-core.ts
 *     rewindDeadSetAtPath, in the worker); when that set is not available (too large, an
 *     archived file, a file that changed under the read) nothing is answered.
 *   - Never another parser's rows. Every answer and key carries HISTORY_PARSER_VERSION, the hash
 *     of the parser's and this builder's source; the server keeps only its own version.
 *   - Never notices passed off as the conversation. A view is `readable` only when it holds a
 *     message someone sent that is more than an envelope, or an assistant reply with words in it
 *     (not only the agent-ack line). Anything else answers `pending`, never rows.
 *   - Off the daemon's event loop. The rewind dead set, the read, the parse, the fit and the gzip
 *     of a view run in a worker thread (createReadyWorkerExecutor; the binary compiles
 *     history-ready-worker.ts in as a second entry, the source twin starts its
 *     history-ready-core.cjs sidecar as the worker). The loop only stats files and passes
 *     messages. One build at a time; each parse is at most PARSE_MAX_BYTES and PARSE_MAX_LINES.
 *   - A view cut short is never taken for the whole one. An answer a request's budget ended
 *     before its build did carries its own key (partialReadyKey), so asking again with it
 *     never answers `unchanged`.
 *   - A hard bound on what crosses: at most READY_MAX_ROWS rows and READY_MAX_JSON_BYTES UTF-8
 *     bytes of JSON before gzip. A view whose newest readable rows do not fit is not cut down
 *     to something else: it answers `pending too-large`.
 *   - Bounded time to find the file: the projects dir is listed at most every DIR_LIST_TTL_MS,
 *     a search stops at LOCATE_MAX_MS, and each request answers inside its own budget.
 *   - Read-only. An archived transcript (transcript-archive.ts) is read through gunzip into a
 *     bounded tail buffer, never restored; an offloaded one answers `none`.
 *   - No bookkeeping on Claude Code's file: the answer is a cache of the parse, keyed by the
 *     file's identity (path, size, mtime) and the inputs that change the parse. Nothing is kept
 *     on disk. No process-wide state of the parser is changed (a daemon serves several servers).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  HISTORY_CACHE_SCHEMA,
  getOrphanFinishedAgentIds,
  parseSessionMessages,
  rewindCutsKey,
  type ParseSessionMessagesOptions,
  type SessionHistoryMessage,
} from '../core/history-parse.js';
import { historyTurnWindowLimit, isHistoryUserTurn } from '../lib/history-turn-window.js';
import { readTurnMarker } from '../lib/turn-end-marker.js';
import { HISTORY_PARSER_VERSION } from '../core/history-parser-version.js';
import { encodeProjectPathCore, isSafeForProjectEncodingCore } from './session-changes-core.js';
import { rewindDeadSetAtPath, type RewindProbeCut } from './transcript-rewind-core.js';

/** Parse windows tried in order, from the end of the transcript. */
export const READY_STAGE_BYTES = [512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024] as const;
/** The most bytes one parse reads. */
export const PARSE_MAX_BYTES = 8 * 1024 * 1024;
/** The most lines one parse reads: dense rows cost per line, not per byte. */
export const PARSE_MAX_LINES = 16_000;
/** User turns a view aims for (the web asks ten, lib/history-turn-window.ts INITIAL_HISTORY_TURNS). */
export const READY_TURNS = 10;
/** Rows a view aims for (the web's HISTORY_TAIL_LIMIT). */
export const READY_ROWS = 400;
/** The most rows a view carries (history-view-snapshot.ts VIEW_MAX_MESSAGES). */
export const READY_MAX_ROWS = 1200;
/** The most UTF-8 bytes of row JSON a view carries, before gzip. The server refuses more. */
export const READY_MAX_JSON_BYTES = 2 * 1024 * 1024;
/** Default time a request waits for its answer before answering what it has. */
export const READY_DEFAULT_BUDGET_MS = 600;
/** An archived transcript larger than this (compressed) is not read for a first paint. */
export const ARCHIVED_MAX_GZ_BYTES = 256 * 1024 * 1024;
/** How long reading one archived transcript may take. */
export const ARCHIVED_MAX_READ_MS = 60_000;
/** The longest a search for one transcript goes on (it runs past a request's budget, once). */
export const LOCATE_MAX_MS = 5_000;
/** How long a listing of the projects dir is reused. */
export const DIR_LIST_TTL_MS = 30_000;
/** The longest one readyKeys call goes on; items it did not reach are left out. */
export const READY_KEYS_MAX_MS = 10_000;
/** The longest one build may take in the worker before the worker is replaced. */
export const READY_JOB_MAX_MS = 90_000;
/** A worker left idle this long is ended (the parse's memory goes with it). */
export const READY_WORKER_IDLE_MS = 60_000;
const MEMO_MAX = 24;
const LOCATED_MAX = 512;

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ARCHIVE_SUFFIX = '.gz';
const MANIFEST_SUFFIX = '.walnut-archive.json';

export interface ReadyViewRequest {
  sessionId: string;
  cwd?: string;
  /** Claude home on this host (`$HOME/.claude`; tests pass a temp dir). */
  claudeHome: string;
  /** The session's recorded in-place rewinds (SessionRecord.inPlaceRewinds). */
  cuts?: RewindProbeCut[];
  turns?: number;
  rows?: number;
  /** The key of the view the caller already holds: an unchanged view answers `unchanged`. */
  have?: string;
  /** How long to wait (ms), the search for the file included. The build itself goes on. */
  budgetMs?: number;
  /** The asking server's legacy-hint cutoff (legacy-hint-lines.ts): a parse option, never a global. */
  legacyHintCutoffMs?: number;
  /** A person waits on this one: it goes before background builds. */
  interactive?: boolean;
}

export interface ReadySource {
  size: number;
  mtimeMs: number;
  archived?: true;
}

/** A ready view as it crosses the wire: its rows are gzipped JSON, base64. */
export interface ReadyAnswer {
  status: 'ready';
  key: string;
  schema: number;
  /** The parse's version (HISTORY_PARSER_VERSION of the daemon's build). */
  parser: string;
  cutsKey: string;
  /** gzip of the rows' JSON, base64. */
  rowsGz: string;
  /** How many rows. */
  rows: number;
  /** UTF-8 bytes of the rows' JSON before gzip (at most READY_MAX_JSON_BYTES). */
  jsonBytes: number;
  /** Rows in the parsed window (its own count space, like a windowed history read's total). */
  total: number;
  /** The view reaches the turns it aimed for, or the file's start. */
  complete: boolean;
  reachedStart: boolean;
  windowed: boolean;
  turns: number;
  /** Always true: an unreadable result is `pending`. Kept on the wire for the server's check. */
  readable: true;
  finishedAgentIds?: string[];
  source: ReadySource;
  parseMs: number;
}

export type PendingAnswer = { status: 'pending'; reason: 'building' | 'locating' | 'not-readable' | 'too-large'; key?: string };
export type NoneAnswer = { status: 'none'; reason: 'invalid' | 'not-found' | 'offloaded' | 'too-large' | 'rewound-archived' | 'rewind-unresolved' | 'read-failed' | 'no-worker' };
export type ReadyViewAnswer = { status: 'unchanged'; key: string } | ReadyAnswer | PendingAnswer | NoneAnswer;
/** What one build ends with. */
export type ReadyBuilt = ReadyAnswer | NoneAnswer | { status: 'pending'; reason: 'not-readable' | 'too-large'; key: string };

/** One build, as handed to the worker (plain data: it crosses a thread). */
export interface ReadyJob {
  key: string;
  path: string;
  archived: boolean;
  size: number;
  mtimeMs: number;
  cutsKey: string;
  /** The session's recorded rewinds: the worker replays them over the whole file. */
  cuts?: RewindProbeCut[];
  turns: number;
  rows: number;
  legacyHintCutoffMs?: number;
  stageBytes: number[];
}

/** Runs a build somewhere (a worker thread in a daemon, this thread in tests). */
export type ReadyExecutor = (job: ReadyJob, onProgress: (answer: ReadyAnswer) => void) => Promise<ReadyBuilt>;

export interface HistoryReadyDeps {
  /** Where builds run. A daemon passes createReadyWorkerExecutor; tests inThreadReadyExecutor. */
  executor: ReadyExecutor;
  /** Optional diagnostics. */
  log?(level: 'info' | 'warn' | 'debug', message: string, fields?: Record<string, unknown>): void;
  /** Test seams. */
  stageBytes?: readonly number[];
  now?(): number;
}

interface Located {
  path: string;
  archived: boolean;
  size: number;
  mtimeMs: number;
}
type LocateResult = Located | { offloaded: true } | { timedOut: true } | null;

const statFile = async (p: string): Promise<fs.Stats | null> => {
  try { const st = await fsp.stat(p); return st.isFile() ? st : null; } catch { return null; }
};

/**
 * The transcript on this host, without restoring an archive. `deadline` (ms) ends a directory
 * search early (`timedOut`); `listDirs` lets a caller reuse one listing of the projects dir.
 */
export async function locateTranscriptReadOnly(
  sessionId: string,
  cwd: string | undefined,
  claudeHome: string,
  opts: { deadline?: number; listDirs?: () => Promise<string[] | null>; now?: () => number } = {},
): Promise<LocateResult> {
  const now = opts.now ?? Date.now;
  const projects = path.join(claudeHome, 'projects');
  if (cwd && isSafeForProjectEncodingCore(cwd)) {
    const p = path.join(projects, encodeProjectPathCore(cwd), `${sessionId}.jsonl`);
    const st = await statFile(p);
    if (st) return { path: p, archived: false, size: st.size, mtimeMs: st.mtimeMs };
  }
  let dirs: string[] | null;
  if (opts.listDirs) dirs = await opts.listDirs();
  else { try { dirs = (await fsp.readdir(projects)).sort(); } catch { dirs = null; } }
  if (!dirs) return null;
  const late = (): boolean => opts.deadline !== undefined && now() > opts.deadline;
  for (const d of dirs) {
    if (late()) return { timedOut: true };
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    const st = await statFile(p);
    if (st) return { path: p, archived: false, size: st.size, mtimeMs: st.mtimeMs };
  }
  for (const d of dirs) {
    if (late()) return { timedOut: true };
    const manifest = path.join(projects, d, `${sessionId}${MANIFEST_SUFFIX}`);
    if (!(await statFile(manifest))) continue;
    const gz = path.join(projects, d, `${sessionId}.jsonl${ARCHIVE_SUFFIX}`);
    const st = await statFile(gz);
    if (st) return { path: gz, archived: true, size: st.size, mtimeMs: st.mtimeMs };
    return { offloaded: true };
  }
  return null;
}

/** The view's key: the file's identity plus every input that changes the parse. */
export function readyViewKey(
  located: { path: string; size: number; mtimeMs: number },
  cuts: readonly RewindProbeCut[] | undefined,
  opts: { turns: number; rows: number; legacyHintCutoffMs?: number },
): string {
  return [
    located.path, located.size, Math.floor(located.mtimeMs), rewindCutsKey(cuts),
    HISTORY_CACHE_SCHEMA, HISTORY_PARSER_VERSION, opts.legacyHintCutoffMs ?? '', opts.turns, opts.rows,
  ].join('|');
}

/** The key of a view a request's budget ended before its build did: never the whole view's. */
export function partialReadyKey(key: string): string {
  return `${key}|partial`;
}

/**
 * True when the rows hold something a person reads as the conversation: a message someone sent
 * that is more than a Walnut envelope (isHistoryUserTurn), or an assistant reply with words in
 * it. Notices, envelopes, tool steps and a reply that is only the agent-ack line are not.
 * Either side alone counts: a session other tasks drive (a lead, a VP) has no typed turn for
 * megabytes, and its replies are what its first paint must show.
 */
export function isReadableView(rows: readonly SessionHistoryMessage[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (isHistoryUserTurn(m)) return true;
    if (m.role === 'assistant' && !m.cliError && readTurnMarker(m.text).text.trim()) return true;
  }
  return false;
}

/** The last `maxLines` lines of `text` (whole lines). */
export function lastLines(text: string, maxLines: number): { text: string; cut: boolean } {
  let count = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== 10) continue;
    // A trailing newline ends the last line; it does not start one.
    if (i === text.length - 1) continue;
    if (++count >= maxLines) return { text: text.slice(i + 1), cut: true };
  }
  return { text, cut: false };
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * The newest rows that fit both caps, with their JSON: at most `maxRows` rows and `maxBytes`
 * UTF-8 bytes of JSON. Rows are never cut: when not even the newest one fits, nothing does
 * (an empty list), and the caller answers that the view is too large.
 */
export function fitRows(rows: SessionHistoryMessage[], maxRows: number, maxBytes: number): { rows: SessionHistoryMessage[]; json: string } {
  const kept = rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
  const all = JSON.stringify(kept);
  if (utf8Bytes(all) <= maxBytes) return { rows: kept, json: all };
  // Bisection on the count of newest rows: a handful of stringifies (this runs in the worker).
  let lo = 0;
  let hi = kept.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(JSON.stringify(kept.slice(kept.length - mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const out = lo > 0 ? kept.slice(kept.length - lo) : [];
  return { rows: out, json: JSON.stringify(out) };
}

const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** The last `maxBytes` BYTES of an archived transcript, read through gunzip (never restored). */
export async function readArchivedTail(gzPath: string, maxBytes: number, deadline: number): Promise<{ bytes: Buffer; start: number; size: number } | null> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let held = 0;
    let total = 0;
    let done = false;
    const input = fs.createReadStream(gzPath);
    const gunzip = zlib.createGunzip();
    const finish = (value: { bytes: Buffer; start: number; size: number } | null): void => {
      if (done) return;
      done = true;
      input.destroy();
      gunzip.destroy();
      resolve(value);
    };
    gunzip.on('data', (chunk: Buffer) => {
      if (Date.now() > deadline) { finish(null); return; }
      chunks.push(chunk);
      held += chunk.length;
      total += chunk.length;
      while (chunks.length > 1 && held - chunks[0]!.length >= maxBytes) held -= chunks.shift()!.length;
    });
    gunzip.on('end', () => {
      const buf = Buffer.concat(chunks);
      const keep = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
      finish({ bytes: keep, start: total - keep.length, size: total });
    });
    gunzip.on('error', () => finish(null));
    input.on('error', () => finish(null));
    input.pipe(gunzip);
  });
}

async function readPlainBytes(file: string, start: number, end: number): Promise<Buffer | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A window's text: the bytes decoded, minus the first line when the window starts mid-file. */
export function windowText(bytes: Buffer, startsAtZero: boolean): string {
  // Cut on the byte of the first newline, never on a character index: the window's first byte
  // may sit inside a multi-byte character, which only that dropped first line may hold.
  if (startsAtZero) return bytes.toString('utf8');
  const nl = bytes.indexOf(10);
  return nl >= 0 ? bytes.subarray(nl + 1).toString('utf8') : '';
}

/**
 * Build one ready view: read the window(s), parse, fit, gzip. Runs in the worker (and in this
 * thread for tests). `onProgress` gets each readable stage before the last one, so a request
 * whose budget ends mid-build can still answer what is readable.
 */
export async function buildReadyView(job: ReadyJob, onProgress?: (answer: ReadyAnswer) => void): Promise<ReadyBuilt> {
  let chainFilter: ParseSessionMessagesOptions['chainFilter'];
  if (job.cuts && job.cuts.length > 0) {
    // The cut anchors can sit anywhere in the file, so the dead set reads all of it.
    if (job.archived) return { status: 'none', reason: 'rewound-archived' };
    const dead = await rewindDeadSetAtPath(job.path, job.cuts);
    if (!dead || dead.truncated) return { status: 'none', reason: 'rewind-unresolved' };
    // Read at another identity than the key's: a view of one file and a dead set of another.
    if (dead.size !== job.size || Math.floor(dead.mtimeMs) !== Math.floor(job.mtimeMs)) {
      return { status: 'none', reason: 'rewind-unresolved' };
    }
    chainFilter = { deadUuids: new Set(dead.deadUuids), queueDeadKeys: new Set(dead.queueDeadKeys) };
  }
  const parseOpts: ParseSessionMessagesOptions = {
    ...(chainFilter ? { chainFilter } : {}),
    ...(job.legacyHintCutoffMs !== undefined ? { legacyHintCutoffMs: job.legacyHintCutoffMs } : {}),
  };
  let archivedTail: { bytes: Buffer; start: number; size: number } | null = null;
  if (job.archived) {
    if (job.size > ARCHIVED_MAX_GZ_BYTES) return { status: 'none', reason: 'too-large' };
    archivedTail = await readArchivedTail(job.path, PARSE_MAX_BYTES, Date.now() + ARCHIVED_MAX_READ_MS);
    if (!archivedTail) return { status: 'none', reason: 'read-failed' };
  }
  const fileSize = archivedTail ? archivedTail.size : job.size;
  let parseMs = 0;
  let best: { answer: Omit<ReadyAnswer, 'rowsGz' | 'rows' | 'jsonBytes'>; json: string; rows: number } | null = null;
  let tooLarge = false;
  const encode = (b: NonNullable<typeof best>): ReadyAnswer => {
    const json = Buffer.from(b.json, 'utf8');
    return { ...b.answer, rowsGz: zlib.gzipSync(json).toString('base64'), rows: b.rows, jsonBytes: json.length };
  };
  const stages = job.stageBytes.length > 0 ? job.stageBytes : [...READY_STAGE_BYTES];
  for (let s = 0; s < stages.length; s++) {
    const want = Math.min(stages[s]!, PARSE_MAX_BYTES);
    const start = Math.max(0, fileSize - want);
    let bytes: Buffer | null;
    if (archivedTail) bytes = archivedTail.bytes.subarray(Math.max(0, start - archivedTail.start));
    else bytes = await readPlainBytes(job.path, start, job.size);
    if (bytes === null) return { status: 'none', reason: 'read-failed' };
    const capped = lastLines(windowText(bytes, start === 0), PARSE_MAX_LINES);
    const t0 = Date.now();
    const parsed = parseSessionMessages(capped.text, parseOpts);
    parseMs += Date.now() - t0;
    const reachedStart = start === 0 && !capped.cut;
    const userTurns = parsed.filter(isHistoryUserTurn).length;
    const limit = Math.max(job.rows, historyTurnWindowLimit(parsed, job.turns));
    const sliced = parsed.length > limit ? parsed.slice(parsed.length - limit) : parsed;
    const fitted = fitRows(sliced, READY_MAX_ROWS, READY_MAX_JSON_BYTES);
    if (sliced.length > 0 && fitted.rows.length === 0) tooLarge = true;
    const readable = isReadableView(fitted.rows);
    const lastStage = s === stages.length - 1 || capped.cut || reachedStart || want >= PARSE_MAX_BYTES;
    const complete = userTurns >= job.turns || reachedStart;
    if (readable) {
      const orphans = getOrphanFinishedAgentIds(parsed);
      best = {
        answer: {
          status: 'ready',
          key: job.key,
          schema: HISTORY_CACHE_SCHEMA,
          parser: HISTORY_PARSER_VERSION,
          cutsKey: job.cutsKey,
          total: parsed.length,
          complete,
          reachedStart,
          windowed: !reachedStart || fitted.rows.length < parsed.length,
          turns: userTurns,
          readable: true,
          ...(orphans && orphans.size > 0 ? { finishedAgentIds: [...orphans].sort() } : {}),
          source: { size: job.size, mtimeMs: job.mtimeMs, ...(job.archived ? { archived: true as const } : {}) },
          parseMs,
        },
        json: fitted.json,
        rows: fitted.rows.length,
      };
    }
    if (complete || lastStage) break;
    if (best && onProgress) onProgress(encode(best));
    await yieldLoop();
  }
  // Nothing a person can read at the largest window: say so rather than serve notices.
  if (!best) return { status: 'pending', reason: tooLarge ? 'too-large' : 'not-readable', key: job.key };
  return encode(best);
}

/** Builds in this thread. Tests only: a daemon runs builds in its worker. */
export const inThreadReadyExecutor: ReadyExecutor = (job, onProgress) => buildReadyView(job, onProgress);

/** What a worker thread looks like to the executor (node:worker_threads Worker; a fake in tests). */
export interface ReadyWorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', cb: (value: unknown) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

type WorkerMsg = { type: 'pong' } | { type: 'progress'; id: number; answer: ReadyAnswer } | { type: 'done'; id: number; result: ReadyBuilt };

/**
 * Runs builds in one worker thread, one at a time. `spawners` are tried in order until one
 * answers a ping (the compiled file and the binary place the worker entry differently); one
 * that works is kept. A worker that dies or overruns READY_JOB_MAX_MS is ended and the build
 * answers `none read-failed`; with no worker at all, every build answers `none no-worker`
 * (retried after a cool-down), and nothing ever runs on the daemon's own loop.
 */
export function createReadyWorkerExecutor(
  spawners: Array<() => ReadyWorkerLike>,
  opts: { jobMaxMs?: number; idleMs?: number; pingMs?: number; retryAfterMs?: number; log?: HistoryReadyDeps['log']; now?: () => number } = {},
): ReadyExecutor & { close(): void; warm(): Promise<boolean>; _alive(): boolean } {
  const jobMaxMs = opts.jobMaxMs ?? READY_JOB_MAX_MS;
  const idleMs = opts.idleMs ?? READY_WORKER_IDLE_MS;
  const pingMs = opts.pingMs ?? 10_000;
  const retryAfterMs = opts.retryAfterMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let worker: ReadyWorkerLike | null = null;
  let closed = false;
  let working = 0;
  let unavailableUntil = 0;
  let seq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let starting: Promise<ReadyWorkerLike | null> | null = null;
  let current: { id: number; onProgress: (a: ReadyAnswer) => void; finish: (r: ReadyBuilt) => void } | null = null;

  // Workers this executor ended itself: their exit is no news.
  const ended = new WeakSet<object>();
  const drop = (w: ReadyWorkerLike | null): void => {
    if (!w) return;
    ended.add(w);
    if (worker === w) worker = null;
    try { w.terminate(); } catch { /* already gone */ }
  };
  const start = (index: number): Promise<ReadyWorkerLike | null> => new Promise((resolve) => {
    let w: ReadyWorkerLike;
    try { w = spawners[index]!(); } catch { resolve(null); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; drop(w); resolve(null); } }, pingMs);
    (timer as { unref?: () => void }).unref?.();
    w.on('message', (raw) => {
      const msg = raw as WorkerMsg;
      if (!settled && msg && msg.type === 'pong') { settled = true; clearTimeout(timer); resolve(w); return; }
      if (!current || !msg || !('id' in msg) || msg.id !== current.id) return;
      if (msg.type === 'progress') current.onProgress(msg.answer);
      else if (msg.type === 'done') current.finish(msg.result);
    });
    const dead = (why: string) => {
      if (!settled) { settled = true; clearTimeout(timer); drop(w); resolve(null); return; }
      if (ended.has(w)) return;
      ended.add(w);
      opts.log?.('warn', 'history ready worker ended', { why });
      if (worker === w) worker = null;
      current?.finish({ status: 'none', reason: 'read-failed' });
    };
    w.on('error', (err) => dead(err instanceof Error ? err.message : String(err)));
    w.on('exit', (code) => dead(`exit ${code}`));
    w.unref?.();
    w.postMessage({ type: 'ping' });
  });
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = undefined; if (!current) drop(worker); }, idleMs);
    (idleTimer as { unref?: () => void }).unref?.();
  };
  const ensure = (): Promise<ReadyWorkerLike | null> => {
    if (closed) return Promise.resolve(null);
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    if (now() < unavailableUntil) return Promise.resolve(null);
    starting = (async () => {
      for (let i = 0; i < spawners.length; i++) {
        const index = (working + i) % spawners.length;
        const w = await start(index);
        if (closed) { drop(w); return null; }
        if (w) { working = index; worker = w; return w; }
      }
      unavailableUntil = now() + retryAfterMs;
      opts.log?.('warn', 'history ready worker could not start', { tried: spawners.length });
      return null;
    })().finally(() => { starting = null; });
    return starting;
  };
  const runOne = async (job: ReadyJob, onProgress: (a: ReadyAnswer) => void): Promise<ReadyBuilt> => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    const w = await ensure();
    if (!w) return { status: 'none', reason: 'no-worker' };
    const id = ++seq;
    const result = await new Promise<ReadyBuilt>((resolve) => {
      const timer = setTimeout(() => {
        opts.log?.('warn', 'history ready build overran; worker replaced', { key: job.key });
        drop(w);
        finish({ status: 'none', reason: 'read-failed' });
      }, jobMaxMs);
      (timer as { unref?: () => void }).unref?.();
      const finish = (r: ReadyBuilt): void => {
        if (!current || current.id !== id) return;
        clearTimeout(timer);
        current = null;
        resolve(r);
      };
      current = { id, onProgress, finish };
      try { w.postMessage({ type: 'job', id, job }); } catch { drop(w); finish({ status: 'none', reason: 'read-failed' }); }
    });
    armIdle();
    return result;
  };
  const executor = ((job: ReadyJob, onProgress: (a: ReadyAnswer) => void): Promise<ReadyBuilt> => {
    const run = chain.then(() => runOne(job, onProgress));
    chain = run.catch(() => undefined);
    return run.catch(() => ({ status: 'none', reason: 'read-failed' }) as NoneAnswer);
  }) as ReadyExecutor & { close(): void; warm(): Promise<boolean>; _alive(): boolean };
  executor.warm = async () => { const w = await ensure(); if (w && !current) armIdle(); return !!w; };
  executor.close = () => {
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    current?.finish({ status: 'none', reason: 'read-failed' });
    drop(worker);
  };
  executor._alive = () => worker !== null;
  return executor;
}

/** The worker's side: answer pings, run builds, post progress and the result. */
export function serveReadyWorker(port: { on(event: 'message', cb: (value: unknown) => void): unknown; postMessage(value: unknown): void }): void {
  port.on('message', (raw) => {
    const msg = raw as { type?: string; id?: number; job?: ReadyJob };
    if (msg?.type === 'ping') { port.postMessage({ type: 'pong' }); return; }
    if (msg?.type !== 'job' || typeof msg.id !== 'number' || !msg.job) return;
    const id = msg.id;
    void buildReadyView(msg.job, (answer) => port.postMessage({ type: 'progress', id, answer }))
      .catch((): ReadyBuilt => ({ status: 'none', reason: 'read-failed' }))
      .then((result) => port.postMessage({ type: 'done', id, result }));
  });
}

/**
 * Where the worker entry sits. In a compiled file (`main` under bun's virtual root) the entry is
 * compiled in beside the main one: next to it for the daemon binary (both entries in
 * src/providers), under providers/ for the Walnut file (entries in src/binary and src/providers).
 * Run from source, it is the file beside this one.
 */
export function readyWorkerEntries(main: string, moduleUrl: string): string[] {
  if (main.startsWith('/$bunfs/') || main.includes('~BUN')) {
    const root = main.slice(0, Math.max(main.lastIndexOf('/'), main.lastIndexOf('\\')));
    return [`${root}/history-ready-worker.ts`, `${root}/providers/history-ready-worker.ts`];
  }
  return [new URL('./history-ready-worker.ts', moduleUrl).href];
}

/** The request's own clock: resolve `work`, or `fallback` once `deadline` passes. */
function byDeadline<T, F>(work: Promise<T>, deadline: number, now: () => number, fallback: F): Promise<T | F> {
  const left = deadline - now();
  if (left <= 0) return Promise.race([work, Promise.resolve(fallback)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), left); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

interface Build {
  key: string;
  /** The best readable result so far (a progress message of the worker). */
  best: ReadyAnswer | null;
  done: Promise<ReadyBuilt>;
  /** Its place in the build queue: a person asking for a queued background build moves it up. */
  queued: { interactive: boolean };
}

export interface HistoryReady {
  readyView(req: ReadyViewRequest): Promise<ReadyViewAnswer>;
  /** Each session's current key, from a stat (no parse): what a reconnect compares. Items the
   *  call did not reach in READY_KEYS_MAX_MS are left out; a session with no transcript is null. */
  readyKeys(items: Array<Omit<ReadyViewRequest, 'claudeHome'>>, claudeHome: string): Promise<Record<string, string | null>>;
  /** Tests. */
  _memoSize(): number;
}

export function createHistoryReady(deps: HistoryReadyDeps): HistoryReady {
  const stages = [...(deps.stageBytes ?? READY_STAGE_BYTES)];
  const now = deps.now ?? Date.now;
  const memo = new Map<string, ReadyBuilt>();
  const building = new Map<string, Build>();
  // Where each session's transcript was found: a later ask stats it again, never searches.
  const located = new Map<string, string>();
  const locating = new Map<string, Promise<LocateResult>>();
  let dirList: { home: string; at: number; dirs: Promise<string[] | null> } | null = null;
  // One build at a time; a request a person waits on goes first.
  const queue: Array<{ interactive: boolean; run: () => void }> = [];
  let running = false;
  const pump = (): void => {
    if (running) return;
    const i = queue.findIndex((q) => q.interactive);
    const next = queue.splice(i >= 0 ? i : 0, 1)[0];
    if (!next) return;
    running = true;
    next.run();
  };
  const gate = <T>(item: { interactive: boolean }, work: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const entry = item as { interactive: boolean; run: () => void };
    entry.run = () => { work().then(resolve, reject).finally(() => { running = false; pump(); }); };
    queue.push(entry);
    pump();
  });

  const remember = (key: string, value: ReadyBuilt): void => {
    memo.delete(key);
    memo.set(key, value);
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  };

  const listDirs = (claudeHome: string): Promise<string[] | null> => {
    if (!dirList || dirList.home !== claudeHome || now() - dirList.at > DIR_LIST_TTL_MS) {
      dirList = {
        home: claudeHome,
        at: now(),
        dirs: fsp.readdir(path.join(claudeHome, 'projects')).then((d) => d.sort(), () => null),
      };
    }
    return dirList.dirs;
  };

  /** Find the transcript: the cwd's file, else where it was found last, else one bounded search. */
  const locate = (sessionId: string, cwd: string | undefined, claudeHome: string): Promise<LocateResult> => {
    const known = located.get(sessionId);
    const inflight = locating.get(sessionId);
    if (inflight) return inflight;
    const run = (async (): Promise<LocateResult> => {
      if (cwd && isSafeForProjectEncodingCore(cwd)) {
        const p = path.join(claudeHome, 'projects', encodeProjectPathCore(cwd), `${sessionId}.jsonl`);
        const st = await statFile(p);
        if (st) return { path: p, archived: false, size: st.size, mtimeMs: st.mtimeMs };
      }
      if (known && !known.endsWith(ARCHIVE_SUFFIX)) {
        const st = await statFile(known);
        if (st) return { path: known, archived: false, size: st.size, mtimeMs: st.mtimeMs };
      }
      const found = await locateTranscriptReadOnly(sessionId, undefined, claudeHome, {
        deadline: now() + LOCATE_MAX_MS, listDirs: () => listDirs(claudeHome), now,
      });
      if (found && 'path' in found) {
        located.delete(sessionId);
        located.set(sessionId, found.path);
        while (located.size > LOCATED_MAX) located.delete(located.keys().next().value as string);
      }
      return found;
    })().finally(() => locating.delete(sessionId));
    locating.set(sessionId, run);
    return run;
  };

  /**
   * The file as it is NOW, for this request: a locate another request began (shared while in
   * flight) may have stat'ed it before this request arrived. The key, and so every answer
   * (memo hit, a joined or queued build, a partial), names the content at a stat made after the
   * request came in, which the server relies on (history-view-snapshot.ts contentAt: the ask's
   * start, on the server's clock, is a lower bound of what the answer holds).
   */
  const observe = async (found: Located): Promise<Located | null> => {
    const st = await statFile(found.path);
    return st ? { ...found, size: st.size, mtimeMs: st.mtimeMs } : null;
  };

  async function runBuild(build: Build, req: ReadyViewRequest, found: Located, turns: number, rows: number): Promise<ReadyBuilt> {
    // Known without a read: no worker trip.
    if (req.cuts && req.cuts.length > 0 && found.archived) return { status: 'none', reason: 'rewound-archived' };
    return await deps.executor({
      key: build.key, path: found.path, archived: found.archived, size: found.size, mtimeMs: found.mtimeMs,
      cutsKey: rewindCutsKey(req.cuts), ...(req.cuts && req.cuts.length > 0 ? { cuts: req.cuts } : {}), turns, rows,
      ...(req.legacyHintCutoffMs !== undefined ? { legacyHintCutoffMs: req.legacyHintCutoffMs } : {}),
      stageBytes: stages,
    }, (answer) => { build.best = answer; });
  }

  const sidOk = (sid: unknown): sid is string => typeof sid === 'string' && SID_RE.test(sid) && !sid.includes('..');
  const turnsOf = (v: number | undefined): number => (Number.isInteger(v) && v! > 0 && v! <= 100 ? v! : READY_TURNS);
  const rowsOf = (v: number | undefined): number => (Number.isInteger(v) && v! > 0 && v! <= READY_MAX_ROWS ? v! : READY_ROWS);

  async function readyView(req: ReadyViewRequest): Promise<ReadyViewAnswer> {
    // The budget covers the whole answer, the search for the file included.
    const budget = Math.max(0, Math.min(req.budgetMs ?? READY_DEFAULT_BUDGET_MS, 30_000));
    const deadline = now() + budget;
    if (!sidOk(req.sessionId)) return { status: 'none', reason: 'invalid' };
    const turns = turnsOf(req.turns);
    const rows = rowsOf(req.rows);
    const where = await byDeadline(locate(req.sessionId, req.cwd, req.claudeHome), deadline, now, 'late' as const);
    if (where === 'late' || (where && 'timedOut' in where)) return { status: 'pending', reason: 'locating' };
    if (!where) return { status: 'none', reason: 'not-found' };
    if ('offloaded' in where) return { status: 'none', reason: 'offloaded' };
    const found = await observe(where);
    // Gone between the search and now (archived, moved): the next ask searches again.
    if (!found) { located.delete(req.sessionId); return { status: 'pending', reason: 'locating' }; }
    const key = readyViewKey(found, req.cuts, { turns, rows, legacyHintCutoffMs: req.legacyHintCutoffMs });
    if (req.have && req.have === key) return { status: 'unchanged', key };
    const hit = memo.get(key);
    if (hit) return hit;
    let build = building.get(key);
    if (!build) {
      const fresh: Build = { key, best: null, done: null as never, queued: { interactive: req.interactive === true } };
      fresh.done = gate(fresh.queued, () => runBuild(fresh, req, found, turns, rows))
        .then((result) => {
          if (result.status === 'ready' || result.status === 'pending') remember(key, result);
          deps.log?.('debug', 'history ready view built', {
            sessionId: req.sessionId, status: result.status,
            ...(result.status === 'ready' ? { rows: result.rows, bytes: result.jsonBytes, turns: result.turns, parseMs: result.parseMs, complete: result.complete } : {}),
            ...(result.status !== 'ready' ? { reason: result.reason } : {}),
          });
          return result;
        })
        .catch((err: unknown): ReadyBuilt => {
          deps.log?.('warn', 'history ready view build failed', { sessionId: req.sessionId, error: err instanceof Error ? err.message : String(err) });
          return { status: 'none', reason: 'read-failed' };
        })
        .finally(() => { if (building.get(key) === fresh) building.delete(key); });
      building.set(key, fresh);
      build = fresh;
    } else if (req.interactive) {
      // Already queued as background work: a person now waits on it.
      build.queued.interactive = true;
    }
    const result = await byDeadline(build.done, deadline, now, null);
    if (result) return result;
    // The budget ran out: what the build already has, when a person can read it, under a key of
    // its own (a server that keeps it and asks again with that key gets the whole view).
    if (build.best) return { ...build.best, key: partialReadyKey(key), complete: false };
    return { status: 'pending', reason: 'building', key };
  }

  async function readyKeys(items: Array<Omit<ReadyViewRequest, 'claudeHome'>>, claudeHome: string): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const until = now() + READY_KEYS_MAX_MS;
    for (const item of items) {
      if (now() > until) break;
      if (!sidOk(item.sessionId)) continue;
      const where = await byDeadline(locate(item.sessionId, item.cwd, claudeHome), until, now, 'late' as const);
      if (where === 'late' || (where && 'timedOut' in where)) break;
      const found = where && 'path' in where ? await observe(where) : null;
      out[item.sessionId] = found
        ? readyViewKey(found, item.cuts, { turns: turnsOf(item.turns), rows: rowsOf(item.rows), legacyHintCutoffMs: item.legacyHintCutoffMs })
        : null;
    }
    return out;
  }

  return { readyView, readyKeys, _memoSize: () => memo.size };
}

/** A ready answer's rows (tests and diagnostics; the server decodes with its own byte cap). */
export function decodeReadyRows(answer: Pick<ReadyAnswer, 'rowsGz'>): SessionHistoryMessage[] {
  return JSON.parse(zlib.gunzipSync(Buffer.from(answer.rowsGz, 'base64')).toString('utf8')) as SessionHistoryMessage[];
}

/** Parse a `history.readyView` request's fields (the wire is untrusted JSON). */
export function readyRequestFromWire(cmd: Record<string, unknown>, claudeHome: string): ReadyViewRequest {
  const cuts = Array.isArray(cmd.cuts)
    ? (cmd.cuts as Array<Record<string, unknown>>)
      .filter((c) => c && typeof c.uuid === 'string' && typeof c.lastUuidAtCommit === 'string')
      .map((c) => ({
        uuid: c.uuid as string,
        lastUuidAtCommit: c.lastUuidAtCommit as string,
        ...(Array.isArray(c.trailingQueueKeys)
          ? { trailingQueueKeys: (c.trailingQueueKeys as unknown[]).filter((k): k is string => typeof k === 'string') }
          : {}),
      }))
    : undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    sessionId: typeof cmd.sid === 'string' ? cmd.sid : '',
    ...(typeof cmd.cwd === 'string' && cmd.cwd ? { cwd: cmd.cwd } : {}),
    claudeHome,
    ...(cuts && cuts.length ? { cuts } : {}),
    ...(num(cmd.turns) !== undefined ? { turns: num(cmd.turns) } : {}),
    ...(num(cmd.rows) !== undefined ? { rows: num(cmd.rows) } : {}),
    ...(typeof cmd.have === 'string' ? { have: cmd.have } : {}),
    ...(num(cmd.budgetMs) !== undefined ? { budgetMs: num(cmd.budgetMs) } : {}),
    ...(num(cmd.legacyHintCutoffMs) !== undefined ? { legacyHintCutoffMs: num(cmd.legacyHintCutoffMs) } : {}),
    ...(cmd.interactive === true ? { interactive: true } : {}),
  };
}

// The source twin starts this very file (its history-ready-core.cjs sidecar) as the worker,
// flagged in workerData; any other load of it (the daemon's main thread, a test) serves nothing.
if (!isMainThread && parentPort && (workerData as { walnutHistoryReadyWorker?: unknown } | null)?.walnutHistoryReadyWorker === true) {
  serveReadyWorker(parentPort);
}
