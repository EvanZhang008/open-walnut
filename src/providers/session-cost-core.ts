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
 * Pricing happens on the server, which owns the price data.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
  scanMs: number;
}

interface UsageRow {
  model: string; speed?: string | null; geo?: string | null; tier?: string | null;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWrite: number;
  webSearches?: number; incomplete?: boolean; at: string;
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

export function bucketRows(rows: UsageRow[], thresholds: number[]): SessionCostBucket[] {
  const buckets = new Map<string, SessionCostBucket>();
  for (const row of rows) {
    const prompt = row.input + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h + row.cacheWrite;
    const key = [row.model, row.speed || 'standard', row.geo || 'global', row.tier || 'standard', band(prompt, thresholds)];
    const id = JSON.stringify(key);
    let b = buckets.get(id);
    if (!b) {
      b = { model: key[0] as string, speed: key[1] as string, geo: key[2] as string, tier: key[3] as string, band: key[4] as number,
        responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0,
        webSearches: 0, incomplete: 0, firstAt: row.at, lastAt: row.at };
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
  try { projects = (await readdir(projectsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
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

export async function parseCodexRollout(file: string): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) return rows;
    const lines = createInterface({ input: handle.createReadStream({ encoding: 'utf8', autoClose: false }), crlfDelay: Infinity });
    let model = 'unknown';
    let lastTotal: number | undefined;
    for await (const line of lines) {
      const isCount = line.includes('"token_count"');
      if (!isCount && !line.includes('"turn_context"')) continue;
      let row: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
      try { row = JSON.parse(line); } catch { continue; }
      const payload = row.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (row.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model) model = normalizeUsageModel(payload.model);
        continue;
      }
      if (payload.type !== 'token_count') continue;
      const info = payload.info as { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null;
      const total = finite(info?.total_token_usage?.total_tokens);
      const last = info?.last_token_usage;
      // The same call is reported again (a rate-limit refresh) with an unchanged total.
      if (!last || total === 0 || total === lastTotal) continue;
      lastTotal = total;
      const prompt = finite(last.input_tokens);
      const cached = Math.min(finite(last.cached_input_tokens), prompt);
      const written = Math.min(finite(last.cache_write_input_tokens), prompt - cached);
      rows.push({
        model, input: prompt - cached - written, output: finite(last.output_tokens),
        cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: written,
        at: typeof row.timestamp === 'string' ? row.timestamp : new Date(0).toISOString(),
      });
    }
  } finally { await handle.close().catch(() => {}); }
  return rows;
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
const FOLD_LIMIT = 4;
const claudeJobs = new Map<string, { promise: Promise<Pick<ClaudeFold, 'rows' | 'engineTotals'>>; progress: { read: number }; totalBytes: number; stamp: string }>();

/** Test seam: forget every cached result and fold. */
export function resetSessionCostCachesForTests(): void { cache.clear(); folds.clear(); claudeJobs.clear(); }

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
  const key = JSON.stringify([req.engine, req.sessionId, thresholds]);
  const base = { engine: req.engine, sessionId: req.sessionId, files: 0, buckets: [] as SessionCostBucket[] };
  const done = (partial: Omit<SessionCostScan, 'engine' | 'sessionId' | 'scanMs' | 'files' | 'buckets'> & Partial<SessionCostScan>, rows?: UsageRow[]): SessionCostScan => {
    const buckets = rows ? bucketRows(rows, thresholds) : [];
    let firstAt: string | undefined, lastAt: string | undefined;
    for (const b of buckets) {
      if (!firstAt || b.firstAt < firstAt) firstAt = b.firstAt;
      if (!lastAt || b.lastAt > lastAt) lastAt = b.lastAt;
    }
    return { ...base, ...partial, buckets, ...(firstAt ? { firstAt, lastAt } : {}), scanMs: Date.now() - started };
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
    const result = done({ source: 'codex-rollout', found: true, files: 1 }, await parseCodexRollout(file));
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
