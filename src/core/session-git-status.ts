/**
 * Session git glance: a session's git state at a glance, without opening it.
 *
 * For every session a row shows, the server answers the repos the session
 * works in (the repos it edited files in, then its cwd's repo) with their
 * branch, changed paths, +/- lines and commits not pushed yet, plus how many
 * files the session's Changed tab lists (`changedFiles`, read from the
 * changes cache; a watched session with no list yet gets one counted in the
 * background, one at a time, so its chip has a number before the tab opens).
 *
 * Where the git work runs: on the host that owns the repo, like the Changed
 * tab's git diff (session-git-diff.ts). A local session runs createGitStatus
 * (git-diff-core.ts) in-process; a remote one asks its daemon's `git.status`
 * (capability 'git-status-v1'). A host that is not connected is never dialled
 * from here: its rows keep the last answer and say the host is away.
 *
 * Freshness without polling every row:
 *   - a read serves the cached answer and recomputes it behind when older
 *     than FRESH_MS (the batch route waits a short moment for a cold one);
 *   - a session the web asked about in the last WATCH_MS is "watched": its
 *     tool calls and turn ends recompute it (debounced, never more often than
 *     MIN_INTERVAL_MS), and a finished Changed-tab compute updates its count;
 *   - every change goes out as `session:git-status` to the web, which patches
 *     the rows and the open Changed tab in place.
 * Reads are bounded: one per session at a time, LOCAL_PARALLEL on this machine
 * and HOST_PARALLEL per remote host, and sessions in one repo share a read.
 */

import os from 'node:os';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { createGitStatus, type GitRepoStatus } from '../providers/git-diff-core.js';
import { memoryPressureShedding } from './memory-pressure.js';

export type { GitRepoStatus } from '../providers/git-diff-core.js';

export interface SessionGitGlance {
  sessionId: string;
  /** The repos the session works in, the one it changed most first. Empty = no repo. */
  repos: GitRepoStatus[];
  /** Files the session's Changed tab lists (its own edits); null = not computed yet. */
  changedFiles: number | null;
  /** When the repos were read (ISO). */
  checkedAt: string;
  /** Why the repos could not be read now (the last answer, if any, is kept). */
  unavailable?: 'host_offline' | 'daemon_needs_upgrade' | 'error';
}

export const GIT_STATUS_EVENT = 'session:git-status';

const FRESH_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const ACTIVITY_DEBOUNCE_MS = 3_000;
const WATCH_MS = 15 * 60_000;
/** Reads at once on this machine, and per remote host (a hung host never holds up the others). */
const LOCAL_PARALLEL = 4;
const HOST_PARALLEL = 2;
/** Sessions in one repo share a read made this recently. */
const READ_SHARE_MS = 5_000;
const RPC_TIMEOUT_MS = 15_000;
const MAX_DIRS = 8;
const CACHE_MAX = 500;
/** Background Changed counts: the gap between two, how soon one is tried again (sooner
 *  for an open panel), the queue's cap, and the longest a count waits behind a compute
 *  already running (the prewarmer's, a tab's): one transcript parse at a time. */
const COUNT_PACE_MS = 2_000;
const COUNT_RETRY_MS = 10 * 60_000;
const COUNT_RETRY_FRONT_MS = 30_000;
const COUNT_QUEUE_MAX = 100;
const COUNT_WAIT_MAX_MS = 2 * 60_000;

interface Entry {
  glance: SessionGitGlance;
  /** Date.now() of the last finished read (0 = never). */
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SessionGitGlance>>();
const watched = new Map<string, number>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lanes = new Map<string, { running: number; waiters: Array<() => void> }>();
const reads = new Map<string, { at: number; p: Promise<GitRepoStatus[] | 'host_offline' | 'daemon_needs_upgrade'> }>();
const countQueue: string[] = [];
const countQueued = new Map<string, number>();
let counting = false;
/** Bumped by the test reset: a drain from before it stops. */
let countGen = 0;

// ── Dependencies (swappable in tests) ──

interface Deps {
  getSession: (id: string) => Promise<{ cwd?: string; host?: string; outputFile?: string } | null>;
  peekChanges: (id: string, host?: string) => Promise<{ fileCount: number; groups: Array<{ repoRoot: string; files: unknown[] }> } | null>;
  readLocal: (dirs: string[]) => Promise<GitRepoStatus[]>;
  readRemote: (host: string, dirs: string[]) => Promise<GitRepoStatus[] | 'host_offline' | 'daemon_needs_upgrade'>;
  emit: (glance: SessionGitGlance) => void;
  /** Compute the session's Changed list (it reports its count through noteSessionChangesComputed). */
  countChanges: (id: string, record: { cwd?: string; host?: string; outputFile?: string }) => Promise<unknown>;
  /** True while the server sheds background work for memory. */
  shedding: () => boolean;
  /** True while any Changed compute runs (a count waits for it). */
  changesBusy: () => boolean;
  now: () => number;
}

const localStatus = createGitStatus({
  exec: (argv, cwd) => new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (!err) { resolve({ stdout, stderr, code: 0 }); return; }
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ stdout: stdout || '', stderr: stderr || err.message, code: typeof code === 'number' ? code : 1 });
    });
  }),
  readText: async (absPath, maxBytes) => {
    try {
      const st = await fsp.stat(absPath);
      if (!st.isFile()) return null;
      if (st.size > maxBytes) return { tooBig: true as const };
      return { text: await fsp.readFile(absPath, 'utf-8') };
    } catch { return null; }
  },
});

function isLocalHost(host: string | undefined): boolean {
  return !host || host === '__local__' || host === 'local';
}

const defaultDeps: Deps = {
  getSession: async (id) => {
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    return getSessionByClaudeId(id);
  },
  peekChanges: async (id, host) => {
    const { peekSessionChanges } = await import('./session-changes.js');
    return peekSessionChanges(id, host);
  },
  readLocal: (dirs) => localStatus.status(dirs.map((d) => (d === '~' || d.startsWith('~/') ? os.homedir() + d.slice(1) : d))),
  readRemote: async (host, dirs) => {
    let conn: { connected?: boolean; hasCapability(c: string): boolean; send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> } | null = null;
    try {
      const { selfHostConnection } = await import('../replica/self-host.js');
      const self = selfHostConnection(host);
      if (self) conn = self.connected ? self : null;
      else {
        const { getConnectedDaemonConnection } = await import('../providers/daemon-connection.js');
        conn = getConnectedDaemonConnection(host) ?? null;
      }
    } catch { conn = null; }
    if (!conn) return 'host_offline';
    if (!conn.hasCapability('git-status-v1')) return 'daemon_needs_upgrade';
    const res = await conn.send('git.status', { dirs }, RPC_TIMEOUT_MS);
    if (!res.ok || !Array.isArray(res.repos)) throw new Error(typeof res.error === 'string' ? res.error : 'git.status failed');
    return res.repos as GitRepoStatus[];
  },
  emit: (glance) => { bus.emit(GIT_STATUS_EVENT, glance, ['web-ui'], { source: 'session-git-status' }); },
  countChanges: async (id, record) => {
    const { computeSessionChanges } = await import('./session-changes.js');
    // noRetain: the disk snapshot (what later peeks read), not the in-memory cache of sessions in use.
    return computeSessionChanges(id, record.cwd, record.host, record.outputFile, { noRetain: true });
  },
  changesBusy: () => changesInflightProbe?.() ?? false,
  shedding: () => {
    try { return memoryPressureShedding(); } catch { return false; }
  },
  now: () => Date.now(),
};

let deps: Deps = defaultDeps;

// session-changes imports this module, so its in-flight probe is wired lazily.
let changesInflightProbe: (() => boolean) | null = null;
void import('./session-changes.js').then((m) => { changesInflightProbe = m.anySessionChangesInflight; }).catch(() => { /* waits on nothing */ });

// ── Compute ──

/** A place in the host's lane; the release hands it straight to the next waiter. */
async function slot(lane: string, limit: number): Promise<() => void> {
  let l = lanes.get(lane);
  if (!l) { l = { running: 0, waiters: [] }; lanes.set(lane, l); }
  const held = l;
  if (held.running >= limit) await new Promise<void>((r) => held.waiters.push(r));
  else held.running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = held.waiters.shift();
    if (next) next(); // the place passes on: running stays the same
    else held.running--;
  };
}

/** Read the repos of these dirs on the host, sharing a read of the same dirs made just now. */
function readRepos(host: string | undefined, dirs: string[]): Promise<GitRepoStatus[] | 'host_offline' | 'daemon_needs_upgrade'> {
  const local = isLocalHost(host);
  const key = `${local ? '__local__' : host}\u0000${dirs.join('\u0000')}`;
  const hit = reads.get(key);
  if (hit && deps.now() - hit.at < READ_SHARE_MS) return hit.p;
  const p = (async () => {
    const release = await slot(local ? '__local__' : host!, local ? LOCAL_PARALLEL : HOST_PARALLEL);
    try {
      return local ? await deps.readLocal(dirs) : await deps.readRemote(host!, dirs);
    } finally {
      release();
    }
  })();
  reads.set(key, { at: deps.now(), p });
  p.catch(() => { reads.delete(key); });
  if (reads.size > CACHE_MAX) {
    for (const [k, v] of reads) if (deps.now() - v.at >= READ_SHARE_MS) reads.delete(k);
  }
  return p;
}

/** The directories to read, the repo the session changed most first. */
function dirsFor(cwd: string | undefined, peek: { groups: Array<{ repoRoot: string; files: unknown[] }> } | null): string[] {
  const touched = (peek?.groups ?? [])
    .filter((g) => g.repoRoot && g.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length)
    .map((g) => g.repoRoot);
  const out: string[] = [];
  for (const d of [...touched, ...(cwd ? [cwd] : [])]) {
    if (!out.includes(d)) out.push(d);
    if (out.length >= MAX_DIRS) break;
  }
  return out;
}

function sameRepos(a: GitRepoStatus[], b: GitRepoStatus[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function remember(id: string, entry: Entry): void {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function computeInner(sessionId: string): Promise<SessionGitGlance> {
  {
    const prev = cache.get(sessionId);
    const record = await deps.getSession(sessionId);
    const host = record?.host;
    const peek = await deps.peekChanges(sessionId, host).catch(() => null);
    const dirs = dirsFor(record?.cwd, peek);
    let repos: GitRepoStatus[] = prev?.glance.repos ?? [];
    let unavailable: SessionGitGlance['unavailable'];
    let readOk = false;
    if (dirs.length) {
      try {
        const got = await readRepos(host, dirs);
        if (typeof got === 'string') unavailable = got;
        else { repos = got; readOk = true; }
      } catch (err) {
        unavailable = 'error';
        log.session.debug('session-git-status: read failed', { sessionId, host, error: String(err) });
      }
    } else {
      repos = [];
      readOk = true;
    }
    const now = deps.now();
    // The count a Changed-tab compute reported while this read ran wins over
    // the cache peeked before it (noteSessionChangesComputed keeps it current).
    const latest = cache.get(sessionId);
    const changedFiles = latest?.glance.changedFiles ?? (peek ? peek.fileCount : null);
    const glance: SessionGitGlance = {
      sessionId,
      repos,
      changedFiles,
      checkedAt: readOk ? new Date(now).toISOString() : (prev?.glance.checkedAt ?? new Date(now).toISOString()),
      ...(unavailable ? { unavailable } : {}),
    };
    // A failed read counts as a read for freshness: retried after FRESH_MS, not at every ask.
    remember(sessionId, { glance, at: now });
    const changed = !prev
      || !sameRepos(prev.glance.repos, glance.repos)
      || prev.glance.changedFiles !== glance.changedFiles
      || prev.glance.unavailable !== glance.unavailable;
    if (changed) deps.emit(glance);
    // No Changed list yet for a session on screen: count one behind (its repos
    // were just read, so its host is there to read the transcript from).
    if (changedFiles === null && readOk && record?.cwd && isWatched(sessionId)) queueCount(sessionId);
    return glance;
  }
}

/** Read one session's git state now (deduped: a read already running is joined). */
export function computeSessionGitGlance(sessionId: string): Promise<SessionGitGlance> {
  const running = inflight.get(sessionId);
  if (running) return running;
  const p = computeInner(sessionId).finally(() => { inflight.delete(sessionId); });
  inflight.set(sessionId, p);
  return p;
}

function isFresh(entry: Entry | undefined, ms: number): boolean {
  return !!entry && deps.now() - entry.at < ms;
}

/**
 * The glance for each session: the cached one at once, a stale one recomputed
 * behind (the web gets the result as an event). A session never read waits up
 * to `waitMs` for its first answer; past that it is null now and arrives as
 * an event. Marks every asked session watched.
 */
export async function getSessionGitGlances(
  sessionIds: string[],
  opts: { waitMs?: number; refresh?: boolean; maxAgeMs?: number } = {},
): Promise<Record<string, SessionGitGlance | null>> {
  const now = deps.now();
  const out: Record<string, SessionGitGlance | null> = {};
  const cold: Array<{ id: string; p: Promise<SessionGitGlance> }> = [];
  for (const id of sessionIds) {
    watched.set(id, now);
    const entry = cache.get(id);
    const freshFor = opts.refresh ? MIN_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, opts.maxAgeMs ?? FRESH_MS);
    const due = !isFresh(entry, freshFor);
    // An open panel asks with refresh: its count goes first.
    if (opts.refresh && entry && entry.glance.changedFiles === null) queueCount(id, true);
    out[id] = entry?.glance ?? null;
    if (!due) continue;
    const p = computeSessionGitGlance(id);
    p.catch(() => { /* logged inside */ });
    if (opts.refresh && !entry) void p.then((g) => { if (g.changedFiles === null && isWatched(id)) queueCount(id, true); }).catch(() => {});
    if (!entry || opts.refresh) cold.push({ id, p });
  }
  if (cold.length && (opts.waitMs ?? 0) > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((r) => { timer = setTimeout(r, opts.waitMs); });
    await Promise.race([
      Promise.allSettled(cold.map(({ id, p }) => p.then((g) => { out[id] = g; }))),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
  }
  return out;
}

// ── Live updates for watched sessions ──

function isWatched(sessionId: string): boolean {
  const at = watched.get(sessionId);
  if (at === undefined) return false;
  if (deps.now() - at > WATCH_MS) { watched.delete(sessionId); return false; }
  return true;
}

/** The session did something that may change its tree: read it again soon. */
export function noteSessionActivity(sessionId: string, delayMs = ACTIVITY_DEBOUNCE_MS): void {
  if (!isWatched(sessionId)) return;
  const pending = activityTimers.get(sessionId);
  if (pending) clearTimeout(pending);
  const entry = cache.get(sessionId);
  // Never more often than MIN_INTERVAL_MS per session.
  const floor = entry ? Math.max(0, MIN_INTERVAL_MS - (deps.now() - entry.at)) : 0;
  const t = setTimeout(() => {
    activityTimers.delete(sessionId);
    void computeSessionGitGlance(sessionId).catch(() => { /* logged inside */ });
  }, Math.max(delayMs, floor));
  t.unref?.();
  activityTimers.set(sessionId, t);
}

// ── Background Changed counts ──

/** Count a watched session's Changed list behind, one session at a time (front = an open panel). */
function queueCount(sessionId: string, front = false): void {
  const last = countQueued.get(sessionId);
  const queued = countQueue.includes(sessionId);
  if (queued && front) countQueue.splice(countQueue.indexOf(sessionId), 1);
  else if (queued || (last !== undefined && deps.now() - last < (front ? COUNT_RETRY_FRONT_MS : COUNT_RETRY_MS))) return;
  if (!queued && countQueue.length >= COUNT_QUEUE_MAX) return;
  countQueued.set(sessionId, deps.now());
  if (countQueued.size > CACHE_MAX) {
    for (const [k, at] of countQueued) if (deps.now() - at >= COUNT_RETRY_MS) countQueued.delete(k);
  }
  if (front) countQueue.unshift(sessionId);
  else countQueue.push(sessionId);
  void drainCounts();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

async function drainCounts(): Promise<void> {
  if (counting) return;
  counting = true;
  const gen = countGen;
  try {
    while (countQueue.length && gen === countGen) {
      // Behind a compute already running: never two transcript parses at once.
      for (let waited = 0; deps.changesBusy() && waited < COUNT_WAIT_MAX_MS && gen === countGen; waited += COUNT_PACE_MS) await sleep(COUNT_PACE_MS);
      if (gen !== countGen) return;
      const id = countQueue.shift();
      if (id === undefined) break;
      if (!isWatched(id) || cache.get(id)?.glance.changedFiles != null) continue;
      if (deps.shedding()) { countQueued.delete(id); continue; }
      try {
        const record = await deps.getSession(id);
        if (record?.cwd) await deps.countChanges(id, record);
      } catch (err) {
        log.session.debug('session-git-status: Changed count failed', { sessionId: id, error: String(err) });
      }
      if (countQueue.length) await sleep(COUNT_PACE_MS);
    }
  } finally {
    if (gen === countGen) counting = false;
  }
}

/** The Changed tab's list for a session was recomputed: push the new count. */
export function noteSessionChangesComputed(sessionId: string, fileCount: number): void {
  const entry = cache.get(sessionId);
  if (!entry || entry.glance.changedFiles === fileCount) {
    // Unknown session: a watched one gets its first read (repos may be new too).
    if (!entry && isWatched(sessionId)) noteSessionActivity(sessionId, 0);
    return;
  }
  const glance = { ...entry.glance, changedFiles: fileCount };
  remember(sessionId, { ...entry, glance });
  deps.emit(glance);
  // The session's edits moved: its repos (or their counts) may have too.
  noteSessionActivity(sessionId, 0);
}

let started = false;

/** Subscribe to the session events that move a watched session's tree. */
export function startSessionGitStatus(): () => void {
  if (started) return () => {};
  started = true;
  bus.subscribe('session-git-status', (event) => {
    const data = event.data as { sessionId?: unknown; replayed?: unknown } | undefined;
    if (!data || typeof data.sessionId !== 'string' || data.replayed === true) return;
    noteSessionActivity(data.sessionId);
  }, { global: true, interest: [EventNames.SESSION_TOOL_RESULT, EventNames.SESSION_RESULT] });
  return () => {
    bus.unsubscribe('session-git-status');
    for (const t of activityTimers.values()) clearTimeout(t);
    activityTimers.clear();
    started = false;
  };
}

// ── Tests ──

export function _setSessionGitStatusDepsForTesting(over: Partial<Deps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
}

export function _resetSessionGitStatusForTesting(): void {
  cache.clear();
  inflight.clear();
  watched.clear();
  for (const t of activityTimers.values()) clearTimeout(t);
  activityTimers.clear();
  lanes.clear();
  reads.clear();
  countQueue.length = 0;
  countQueued.clear();
  countGen++;
  counting = false;
}
