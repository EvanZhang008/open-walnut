/**
 * One session's token usage, read host-side from what the ENGINE recorded.
 * Walnut counts nothing itself: every number here is the engine's own per-request
 * usage record, deduplicated the way the engine writes it.
 *
 *   claude    the session transcript plus its subagent transcripts, folded by the
 *             canonical scanner (one response per message id, fork history dropped).
 *   codex     the rollout file: one `token_count` event per model call; a repeated
 *             event (same running total) is the same call written twice.
 *   opencode  `opencode export <id>`: one assistant message per model call.
 *   others    report no per-request usage Walnut can read, so the scan says so.
 *
 * Requests are summed into buckets that keep everything a price depends on:
 * model, speed, region, service tier, and how many of the caller's context
 * thresholds the request's prompt went past (a long prompt changes the rate of
 * the WHOLE request for tiered models, so a sum of tokens alone cannot be priced).
 * Pricing happens on the server, which owns the price data. With `byDay` the
 * buckets are split once more by the local calendar day each response was written.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeUsageModel, scanCanonicalSessionUsage, type CanonicalCostState, type SessionFoldState } from './usage-scan-core.js';

export interface SessionCostRequest {
  engine: string;
  sessionId: string;
  cwd?: string;
  /** Prompt-size thresholds the server's price data uses, ascending. */
  thresholds?: number[];
  projectsDir: string;
  codexHome?: string;
  /** Answer by then with a `pending` scan while a long first read goes on (ms). */
  softDeadlineMs?: number;
  /**
   * Split buckets by the calendar day (YYYY-MM-DD) each response was written, in
   * this IANA zone. An unknown zone counts in UTC. Unset: no day, as before.
   */
  byDay?: { timeZone: string };
}

export interface SessionCostBucket {
  model: string;
  speed: string;
  geo: string;
  tier: string;
  /** How many thresholds this bucket's requests went past (prompt > threshold). */
  band: number;
  responses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Cache writes the engine reported without a 5m/1h split. */
  cacheWrite: number;
  webSearches: number;
  /** Responses whose usage record was incomplete (still counted). */
  incomplete: number;
  firstAt: string;
  lastAt: string;
  /** Local day of these responses (byDay only; absent when no response time is known). */
  day?: string;
}

export type SessionCostSource = 'claude-transcript' | 'codex-rollout' | 'opencode-export' | 'none';

export interface SessionCostScan {
  engine: string;
  sessionId: string;
  source: SessionCostSource;
  found: boolean;
  /** A first read of a large transcript is still going; it finishes in the background. */
  pending?: { readBytes: number; totalBytes: number };
  /** Why nothing was read, in words a person can act on. */
  reason?: string;
  files: number;
  buckets: SessionCostBucket[];
  firstAt?: string;
  lastAt?: string;
  /** What the engine itself says about the session (its own cost and clocks). */
  engineTotals?: { costUsd?: number; apiDurationMs?: number; durationMs?: number };
  /** Set only on a day-split answer: the zone the days are in (UTC when the asked one was unknown). */
  byDay?: { timeZone: string };
  scanMs: number;
}

/** Marker for the source twin: this sidecar honours `byDay` (session-cost-day-v1). */
export const SESSION_COST_DAY_SPLIT = true;

interface UsageRow {
  model: string; speed?: string | null; geo?: string | null; tier?: string | null;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWrite: number;
  webSearches?: number; incomplete?: boolean; at: string;
  /** The engine wrote no time for this response (`at` is then the epoch). */
  undated?: boolean;
}

const NO_USAGE_REASON: Record<string, string> = {
  goose: 'Goose keeps only session totals, without the cache detail a price needs.',
  gemini: 'Gemini usage is not read yet.',
  pi: 'Pi usage is not read yet.',
};

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function band(prompt: number, thresholds: number[]): number {
  let n = 0;
  for (const t of thresholds) if (prompt > t) n++;
  return n;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone days are counted in: the asked one when this runtime knows it, else UTC. */
export function dayZone(timeZone: string): string {
  if (dayFormats.has(timeZone)) return timeZone;
  try {
    dayFormats.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    return timeZone;
  } catch {
    if (!dayFormats.has('UTC')) dayFormats.set('UTC', new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }));
    return 'UTC';
  }
}

/** YYYY-MM-DD of an instant in a zone `dayZone` returned. */
export function localDay(ms: number, zone: string): string {
  const parts = dayFormats.get(zone)!.formatToParts(ms);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function bucketRows(rows: UsageRow[], thresholds: number[], zone?: string): SessionCostBucket[] {
  const buckets = new Map<string, SessionCostBucket>();
  // A response the engine wrote no time for takes the day of the nearest EARLIER
  // dated response in the same file (rows arrive in file order); none: no day.
  let lastDay: string | undefined;
  for (const row of rows) {
    const prompt = row.input + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h + row.cacheWrite;
    const key: (string | number | null)[] = [row.model, row.speed || 'standard', row.geo || 'global', row.tier || 'standard', band(prompt, thresholds)];
    let day: string | undefined;
    if (zone) {
      const ms = row.undated ? NaN : Date.parse(row.at);
      if (Number.isFinite(ms)) lastDay = localDay(ms, zone);
      day = lastDay;
      key.push(day ?? null);
    }
    const id = JSON.stringify(key);
    let b = buckets.get(id);
    if (!b) {
      b = { model: key[0] as string, speed: key[1] as string, geo: key[2] as string, tier: key[3] as string, band: key[4] as number,
        responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0,
        webSearches: 0, incomplete: 0, firstAt: row.at, lastAt: row.at, ...(day ? { day } : {}) };
      buckets.set(id, b);
    }
    b.responses++;
    b.input += row.input; b.output += row.output; b.cacheRead += row.cacheRead;
    b.cacheWrite5m += row.cacheWrite5m; b.cacheWrite1h += row.cacheWrite1h; b.cacheWrite += row.cacheWrite;
    b.webSearches += row.webSearches ?? 0;
    if (row.incomplete) b.incomplete++;
    if (row.at < b.firstAt) b.firstAt = row.at;
    if (row.at > b.lastAt) b.lastAt = row.at;
  }
  return [...buckets.values()];
}

// ── Claude ──────────────────────────────────────────────────────────────────

async function claudeFiles(projectsDir: string, sessionId: string, cwd?: string): Promise<{ path: string; agentId?: string }[]> {
  let projects: string[];
  // Sorted: the first project holding the sid wins, and bun lists in file system order.
  try { projects = (await readdir(projectsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch { return []; }
  if (cwd) {
    // The CLI names a project dir after the canonical cwd with every non-alphanumeric replaced.
    const canonical = (await realpath(cwd).catch(() => cwd)).normalize('NFC');
    const name = canonical.replace(/[^a-zA-Z0-9]/g, '-');
    const index = projects.findIndex(p => p === name || (name.length > 200 && p.startsWith(`${name.slice(0, 200)}-`)));
    if (index > 0) projects.unshift(...projects.splice(index, 1));
  }
  for (const project of projects) {
    const main = path.join(projectsDir, project, `${sessionId}.jsonl`);
    try { if (!(await lstat(main)).isFile()) continue; } catch { continue; }
    const files: { path: string; agentId?: string }[] = [{ path: main }];
    const agents = path.join(projectsDir, project, sessionId, 'subagents');
    try {
      for (const entry of await readdir(agents, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: path.join(agents, entry.name), agentId: entry.name.slice(0, -6) });
      }
    } catch { /* no subagents */ }
    return files;
  }
  return [];
}

async function scanClaude(req: SessionCostRequest, files: { path: string; agentId?: string }[], prior: SessionFoldState | undefined, progress: { read: number }) {
  const scan = await scanCanonicalSessionUsage({ sessionId: req.sessionId, files, state: prior, progress });
  const rows: UsageRow[] = [];
  for (const r of scan.records) {
    const split = r.cache_creation;
    const write = r.cache_creation_input_tokens ?? 0;
    rows.push({
      model: r.model, speed: r.speed, geo: r.inference_geo || 'global', tier: r.service_tier,
      input: r.input_tokens ?? 0, output: r.output_tokens ?? 0, cacheRead: r.cache_read_input_tokens ?? 0,
      cacheWrite5m: split ? split.ephemeral_5m_input_tokens : 0,
      cacheWrite1h: split ? split.ephemeral_1h_input_tokens : 0,
      cacheWrite: split ? 0 : write,
      webSearches: r.server_tool_use?.web_search_requests ?? 0,
      incomplete: !r.complete, at: r.timestamp,
    });
  }
  const state: CanonicalCostState | undefined = scan.costStates[0];
  return { rows, fold: scan.state,
    engineTotals: state ? { costUsd: state.totalCostUsd, apiDurationMs: state.apiDurationMs, durationMs: state.durationMs } : undefined };
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** Day dirs (local time, as codex names them) around a UUIDv7's own timestamp. */
function uuidV7Days(id: string): string[] {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return [];
  const ms = parseInt(hex.slice(0, 12), 16);
  const days: string[] = [];
  for (const offset of [0, -1, 1]) {
    const d = new Date(ms + offset * 86_400_000);
    days.push(path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return days;
}

async function findInDir(dir: string, suffix: string): Promise<string | undefined> {
  try {
    for (const name of await readdir(dir)) if (name.startsWith('rollout-') && name.endsWith(suffix)) return path.join(dir, name);
  } catch { /* missing */ }
  return undefined;
}

async function codexRollout(codexHome: string, sessionId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  for (const root of ['sessions', 'archived_sessions']) {
    const base = path.join(codexHome, root);
    for (const day of uuidV7Days(sessionId)) {
      const hit = await findInDir(path.join(base, day), suffix);
      if (hit) return hit;
    }
    const flat = await findInDir(base, suffix);
    if (flat) return flat;
  }
  // Bounded walk: years / months / days, newest first.
  const base = path.join(codexHome, 'sessions');
  const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter(n => /^\d+$/.test(n)).sort().reverse();
  for (const y of await list(base)) for (const m of await list(path.join(base, y))) for (const d of await list(path.join(base, y, m))) {
    const hit = await findInDir(path.join(base, y, m, d), suffix);
    if (hit) return hit;
  }
  return undefined;
}

/** What a Codex rollout read so far: a file that only grew is read from where the last read ended. */
export interface CodexFold { dev: number; ino: number; offset: number; model: string; lastTotal?: number; rows: UsageRow[] }

const CODEX_CHUNK = 4 * 1024 * 1024;

function foldCodexLine(fold: CodexFold, line: string): void {
  const isCount = line.includes('"token_count"');
  if (!isCount && !line.includes('"turn_context"')) return;
  let row: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
  try { row = JSON.parse(line); } catch { return; }
  const payload = row.payload;
  if (!payload || typeof payload !== 'object') return;
  if (row.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model) fold.model = normalizeUsageModel(payload.model);
    return;
  }
  if (payload.type !== 'token_count') return;
  const info = payload.info as { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null;
  const total = finite(info?.total_token_usage?.total_tokens);
  const last = info?.last_token_usage;
  // The same call is reported again (a rate-limit refresh) with an unchanged total.
  if (!last || total === 0 || total === fold.lastTotal) return;
  fold.lastTotal = total;
  const prompt = finite(last.input_tokens);
  const cached = Math.min(finite(last.cached_input_tokens), prompt);
  const written = Math.min(finite(last.cache_write_input_tokens), prompt - cached);
  fold.rows.push({
    model: fold.model, input: prompt - cached - written, output: finite(last.output_tokens),
    cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: written,
    at: typeof row.timestamp === 'string' ? row.timestamp : new Date(0).toISOString(),
    ...(typeof row.timestamp === 'string' ? {} : { undated: true }),
  });
}

/**
 * Fold a Codex rollout, continuing `prior` when the file is the same one and only
 * grew (Codex appends). Reads complete lines only: a line still being written is
 * read next time.
 */
export async function foldCodexRollout(file: string, prior?: CodexFold): Promise<CodexFold> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { dev: st.dev, ino: st.ino, offset: 0, model: 'unknown', rows: [] };
    const same = prior && prior.dev === st.dev && prior.ino === st.ino && st.size >= prior.offset;
    const fold: CodexFold = same
      ? { ...prior, rows: prior.rows.slice() }
      : { dev: st.dev, ino: st.ino, offset: 0, model: 'unknown', rows: [] };
    // Split on newline BYTES: a chunk may end inside a multi-byte character.
    const buffer = Buffer.alloc(Math.min(CODEX_CHUNK, Math.max(1, st.size - fold.offset)));
    let carry: Buffer = Buffer.alloc(0);
    let position = fold.offset;
    while (position < st.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, st.size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const bytes = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const cut = bytes.lastIndexOf(0x0a);
      if (cut < 0) { carry = Buffer.from(bytes); continue; }
      for (const line of bytes.toString('utf8', 0, cut).split('\n')) foldCodexLine(fold, line);
      carry = Buffer.from(bytes.subarray(cut + 1));
      fold.offset = position - carry.length;
    }
    return fold;
  } finally { await handle.close().catch(() => {}); }
}

export async function parseCodexRollout(file: string): Promise<UsageRow[]> {
  return (await foldCodexRollout(file)).rows;
}

// ── OpenCode ────────────────────────────────────────────────────────────────

function openCodeBinaryEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.opencode', 'bin'), path.join(home, '.local', 'bin')];
  return { ...process.env, PATH: [process.env.PATH ?? '', ...extra].filter(Boolean).join(path.delimiter) };
}

export function parseOpenCodeExport(text: string): { rows: UsageRow[]; costUsd: number } {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('opencode export printed no JSON');
  const doc = JSON.parse(text.slice(start)) as { messages?: { info?: Record<string, unknown> }[] };
  const rows: UsageRow[] = [];
  let costUsd = 0;
  for (const message of doc.messages ?? []) {
    const info = message.info;
    if (!info || info.role !== 'assistant') continue;
    const tokens = info.tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
    if (!tokens) continue;
    costUsd += finite(info.cost);
    const model = normalizeUsageModel(typeof info.modelID === 'string' ? info.modelID : '');
    const write = finite(tokens.cache?.write);
    const created = (info.time as { created?: number } | undefined)?.created;
    rows.push({
      // OpenCode stores output WITHOUT reasoning and bills reasoning at the output rate
      // (Session.getUsage: output = outputTokens - reasoningTokens; checked in 1.4.0).
      model, input: finite(tokens.input), output: finite(tokens.output) + finite(tokens.reasoning),
      cacheRead: finite(tokens.cache?.read),
      // OpenCode writes Anthropic prompt caches with the default 5-minute TTL.
      cacheWrite5m: model.startsWith('claude-') ? write : 0, cacheWrite1h: 0,
      cacheWrite: model.startsWith('claude-') ? 0 : write,
      at: new Date(typeof created === 'number' ? created : 0).toISOString(),
      ...(typeof created === 'number' ? {} : { undated: true }),
    });
  }
  return { rows, costUsd };
}

function runOpenCodeExport(sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('opencode', ['export', sessionId], { timeout: 20_000, maxBuffer: 128 * 1024 * 1024, env: openCodeBinaryEnv() },
      (err, stdout) => err ? reject(err) : resolve(String(stdout)));
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

interface CacheEntry { stamp: string; result: SessionCostScan; at: number }
type ClaudeFold = Awaited<ReturnType<typeof scanClaude>>;
/** Each session's fold so far (a transcript that grew is read from its last offset). */
const folds = new Map<string, SessionFoldState>();
/** Folds kept (a budget checks each of its sessions every few seconds; an evicted fold is a full reread). */
const FOLD_LIMIT = 32;
const codexFolds = new Map<string, { file: string; fold: CodexFold }>();
const claudeJobs = new Map<string, { promise: Promise<Pick<ClaudeFold, 'rows' | 'engineTotals'>>; progress: { read: number }; totalBytes: number; stamp: string }>();

/** Test seam: forget every cached result and fold. */
export function resetSessionCostCachesForTests(): void { cache.clear(); folds.clear(); claudeJobs.clear(); codexFolds.clear(); }

async function totalSize(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) total += (await stat(file).catch(() => null))?.size ?? 0;
  return total;
}
const cache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 24;
const OPENCODE_TTL_MS = 30_000;

async function stampOf(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => null);
    parts.push(s ? `${file}:${s.size}:${s.mtimeMs}` : `${file}:-`);
  }
  return parts.join('|');
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export async function scanSessionCost(req: SessionCostRequest): Promise<SessionCostScan> {
  const started = Date.now();
  if (!req.sessionId || path.basename(req.sessionId) !== req.sessionId || req.sessionId === '..') {
    throw new Error('Session ID must be a filename component');
  }
  const thresholds = [...new Set((req.thresholds ?? []).filter(t => Number.isFinite(t) && t > 0))].sort((a, b) => a - b);
  const zone = req.byDay ? dayZone(String(req.byDay.timeZone)) : undefined;
  const key = JSON.stringify(zone ? [req.engine, req.sessionId, thresholds, zone] : [req.engine, req.sessionId, thresholds]);
  const base = { engine: req.engine, sessionId: req.sessionId, files: 0, buckets: [] as SessionCostBucket[] };
  const done = (partial: Omit<SessionCostScan, 'engine' | 'sessionId' | 'scanMs' | 'files' | 'buckets'> & Partial<SessionCostScan>, rows?: UsageRow[]): SessionCostScan => {
    const buckets = rows ? bucketRows(rows, thresholds, zone) : [];
    let firstAt: string | undefined, lastAt: string | undefined;
    for (const b of buckets) {
      if (!firstAt || b.firstAt < firstAt) firstAt = b.firstAt;
      if (!lastAt || b.lastAt > lastAt) lastAt = b.lastAt;
    }
    return { ...base, ...partial, buckets, ...(firstAt ? { firstAt, lastAt } : {}), ...(zone ? { byDay: { timeZone: zone } } : {}), scanMs: Date.now() - started };
  };

  if (req.engine === 'claude') {
    const files = await claudeFiles(req.projectsDir, req.sessionId, req.cwd);
    if (!files.length) return done({ source: 'claude-transcript', found: false, reason: 'No transcript for this session on its host.' });
    const stamp = await stampOf(files.map(f => f.path));
    const hit = cache.get(key);
    if (hit && hit.stamp === stamp) return { ...hit.result, scanMs: Date.now() - started };
    // One fold per session at a time; it reads only what the transcript gained since the last one.
    let job = claudeJobs.get(req.sessionId);
    if (!job) {
      const progress = { read: 0 };
      const totalBytes = await totalSize(files.map(f => f.path));
      const promise = scanClaude(req, files, folds.get(req.sessionId), progress).then(({ rows, fold, engineTotals }) => {
        folds.delete(req.sessionId);
        folds.set(req.sessionId, fold);
        while (folds.size > FOLD_LIMIT) folds.delete(folds.keys().next().value!);
        return { rows, engineTotals };
      }).finally(() => { claudeJobs.delete(req.sessionId); });
      job = { promise, progress, totalBytes, stamp };
      claudeJobs.set(req.sessionId, job);
    }
    const soft = req.softDeadlineMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), soft); });
    const outcome = await Promise.race([job.promise, late]).finally(() => clearTimeout(timer));
    if (outcome === 'late') {
      return done({ source: 'claude-transcript', found: true, files: files.length,
        pending: { readBytes: job.progress.read, totalBytes: job.totalBytes } });
    }
    const result = done({ source: 'claude-transcript', found: true, files: files.length, ...(outcome.engineTotals ? { engineTotals: outcome.engineTotals } : {}) }, outcome.rows);
    // The job read the files as they were when IT started: a later request's stamp may cover bytes it never saw.
    remember(key, { stamp: job.stamp, result, at: Date.now() });
    return result;
  }
  if (req.engine === 'codex') {
    const home = req.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const file = await codexRollout(home, req.sessionId);
    if (!file) return done({ source: 'codex-rollout', found: false, reason: 'No Codex session file for this session on its host.' });
    const stamp = await stampOf([file]);
    const hit = cache.get(key);
    if (hit && hit.stamp === stamp) return { ...hit.result, scanMs: Date.now() - started };
    const prior = codexFolds.get(req.sessionId);
    const fold = await foldCodexRollout(file, prior?.file === file ? prior.fold : undefined);
    codexFolds.delete(req.sessionId);
    codexFolds.set(req.sessionId, { file, fold });
    while (codexFolds.size > FOLD_LIMIT) codexFolds.delete(codexFolds.keys().next().value!);
    const result = done({ source: 'codex-rollout', found: true, files: 1 }, fold.rows);
    remember(key, { stamp, result, at: Date.now() });
    return result;
  }
  if (req.engine === 'opencode') {
    // The export is slow (seconds); its database's own stat says when it can have changed.
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const db = path.join(dataHome, 'opencode', 'opencode.db');
    const stamp = await stampOf([db, `${db}-wal`]);
    const hit = cache.get(key);
    const dbKnown = !stamp.startsWith(`${db}:-`);
    if (hit && (dbKnown ? hit.stamp === stamp : Date.now() - hit.at < OPENCODE_TTL_MS)) return { ...hit.result, scanMs: Date.now() - started };
    let text: string;
    try { text = await runOpenCodeExport(req.sessionId); }
    catch (err) {
      return done({ source: 'opencode-export', found: false, reason: `opencode export failed: ${(err as Error).message.split('\n')[0]}` });
    }
    const parsed = parseOpenCodeExport(text);
    const result = done({ source: 'opencode-export', found: true, files: 1, engineTotals: { costUsd: parsed.costUsd } }, parsed.rows);
    remember(key, { stamp, result, at: Date.now() });
    return result;
  }
  return done({ source: 'none', found: false, reason: NO_USAGE_REASON[req.engine] ?? `${req.engine} usage is not read yet.` });
}
