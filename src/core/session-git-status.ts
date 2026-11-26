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
 * The route never waits on git: it answers from the cache (null for a session
 * never read) and every newer reading reaches the page as `session:git-status`.
 * On a loaded host one `git status` of a large checkout takes seconds
 * (2026-11-25: 4 to 9 s in a 28k-file monorepo with 2.6k submodules at load
 * 110), so a request that waited for it only held a browser connection.
 *
 * Reads are per folder and bounded: one read per folder at a time (every
 * session in it joins the running one, however long it takes), a finished one
 * shared for READ_SHARE_MS, LOCAL_PARALLEL on this machine and HOST_PARALLEL per
 * remote host. A folder inside a repo read once is read as that repo's root
 * for FOLDER_ROOT_TTL_MS, so sessions in different subfolders of one checkout
 * share its read. A read that never returns gives up after FOLDER_READ_MAX_MS,
 * and a session's round of folders ends by ROUND_MAX_MS.
 */

import os from 'node:os';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { createGitStatus, type GitRepoStatus } from '../providers/git-diff-core.js';
import { memoryPressureShedding } from './memory-pressure.js';
import { needCapability } from '../providers/daemon-capability-need.js'

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
/** Sessions in one folder share a read that started this recently. */
const READ_SHARE_MS = 5_000;
const RPC_TIMEOUT_MS = 15_000;
/** One folder's read gives up after this (its git may never return); the next ask reads again. */
const FOLDER_READ_MAX_MS = 60_000;
/** A session's round of folder reads ends by this, about one RPC's worth (the old one-RPC bound). */
const ROUND_MAX_MS = RPC_TIMEOUT_MS + 5_000;
/** How long a folder stays read as the repo root it resolved to. */
const FOLDER_ROOT_TTL_MS = 5 * 60_000;
const MAX_DIRS = 8;
const CACHE_MAX = 500;
/** Background Changed counts: the gap between two, how soon one is tried again (sooner
 *  for an open panel), the queue's cap, and the longest a count waits behind a compute
 *  already running (the prewarmer's, a tab's): one transcript parse at a time. */
const COUNT_PACE_MS = 2_000;
const COUNT_RETRY_MS = 10 * 60_000;
const COUNT_RETRY_FRONT_MS = 30_000;
/** A counted session whose repos moved is counted again, at most this often. */
const RECOUNT_MS = 30_000;
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
type RepoRead = GitRepoStatus[] | 'host_offline' | 'daemon_needs_upgrade';
/** Per folder (host + dir): the running read, else the last one and when it started. */
const folders = new Map<string, { running: Promise<RepoRead> | null; last: { at: number; p: Promise<RepoRead> } | null }>();
/** A folder read once -> the folder key of its repo's root (the one read it shares), and when. */
const folderRoot = new Map<string, { key: string; at: number }>();
const countQueue: string[] = [];
const countQueued = new Map<string, number>();
/** Counted sessions due a recount (their repos moved since). */
const recountDue = new Set<string>();
const recountTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** When each session's Changed list last reported its count (any compute: a tab, a count). */
const countedAt = new Map<string, number>();
/** Each session's transcript signature when its count last ran here. */
const countedSig = new Map<string, string>();
/** When Walnut last heard the session use a tool. */
const activeAt = new Map<string, number>();

/** Keeps a per-session map to CACHE_MAX, oldest first out. */
function stamp<V>(m: Map<string, V>, id: string, v: V): void {
  m.delete(id);
  m.set(id, v);
  if (m.size > CACHE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

/** Did the session itself write since its count? (Its repo moving is not enough: other
 *  sessions in the same repo, or the user, move it too.) Never counted here: once. */
async function sessionWroteSinceCount(sessionId: string, record: { cwd?: string; host?: string }): Promise<boolean> {
  if ((activeAt.get(sessionId) ?? -Infinity) > (countedAt.get(sessionId) ?? -Infinity)) return true;
  const sig = await deps.transcriptSig(sessionId, record).catch(() => null);
  if (sig === null) return false;
  const known = countedSig.get(sessionId);
  return known === undefined || known !== sig;
}
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
  countChanges: (id: string, record: { cwd?: string; host?: string; outputFile?: string }, opts?: { recount?: boolean }) => Promise<unknown>;
  /** True while the server sheds background work for memory. */
  shedding: () => boolean;
  /** True while any Changed compute runs (a count waits for it). */
  changesBusy: () => boolean;
  /** The session transcript's size+mtime signature (one stat), null when unknown. */
  transcriptSig: (id: string, record: { cwd?: string; host?: string }) => Promise<string | null>;
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
    if (!needCapability(conn, 'git-status-v1')) return 'daemon_needs_upgrade';
    const res = await conn.send('git.status', { dirs }, RPC_TIMEOUT_MS);
    if (!res.ok || !Array.isArray(res.repos)) throw new Error(typeof res.error === 'string' ? res.error : 'git.status failed');
    return res.repos as GitRepoStatus[];
  },
  emit: (glance) => { bus.emit(GIT_STATUS_EVENT, glance, ['web-ui'], { source: 'session-git-status' }); },
  countChanges: async (id, record, opts) => {
    const { computeSessionChanges } = await import('./session-changes.js');
    // A first count, noRetain: the disk snapshot (what later peeks read), not the in-memory
    // cache of sessions in use. A recount is a session at work: it keeps its parse state, so
    // the next recount reads only what the transcript gained.
    return computeSessionChanges(id, record.cwd, record.host, record.outputFile, opts?.recount ? undefined : { noRetain: true });
  },
  changesBusy: () => changesInflightProbe?.() ?? false,
  transcriptSig: async (id, record) => {
    const { sessionTranscriptSig } = await import('./session-changes.js');
    return sessionTranscriptSig(id, record.cwd, record.host);
  },
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

/** One folder's repos on the host: joins the folder's running read, reuses one started
 *  within READ_SHARE_MS, else reads it (at most one read per folder at a time). A dir
 *  known to be a repo root (a Changed group's) is read as itself; any other is read as
 *  the root it last resolved to, for FOLDER_ROOT_TTL_MS (a plain or uninitialised
 *  folder may become a repo of its own: `git init`, `submodule update --init`). */
function readFolder(host: string | undefined, dir: string, isRoot: boolean): Promise<RepoRead> {
  const local = isLocalHost(host);
  const lane = local ? '__local__' : host!;
  const asked = `${lane}\u0000${dir}`;
  const alias = isRoot ? undefined : folderRoot.get(asked);
  const key = alias && deps.now() - alias.at < FOLDER_ROOT_TTL_MS ? alias.key : asked;
  const readDir = key.slice(lane.length + 1);
  let f = folders.get(key);
  if (f?.running) return f.running;
  if (f?.last && deps.now() - f.last.at < READ_SHARE_MS) return f.last.p;
  if (!f) {
    f = { running: null, last: null };
    stamp(folders, key, f);
  }
  const held = f;
  const at = deps.now();
  const p = (async () => {
    const release = await slot(lane, local ? LOCAL_PARALLEL : HOST_PARALLEL);
    // A git that never returns (a hung mount, a read stuck in the kernel) gives up its
    // folder and its lane place after FOLDER_READ_MAX_MS, so the next ask reads again.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        local ? deps.readLocal([readDir]) : deps.readRemote(host!, [readDir]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`git read of ${readDir} took over ${FOLDER_READ_MAX_MS} ms`)), FOLDER_READ_MAX_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  })();
  held.running = p;
  p.then((got) => {
    held.last = { at, p };
    // A folder inside one repo is read as that repo's root for a while.
    if (!isRoot && key === asked && Array.isArray(got) && got.length === 1 && got[0]!.repoRoot !== dir) {
      stamp(folderRoot, asked, { key: `${lane}\u0000${got[0]!.repoRoot}`, at: deps.now() });
    }
  }, () => { held.last = null; }).finally(() => { if (held.running === p) held.running = null; });
  return p;
}

/** Read the repos of these dirs on the host, folder by folder, each repo once. The round
 *  ends by ROUND_MAX_MS (a slow host's folders queue two at a time): a folder still
 *  reading then counts with its last reading, and the round fails when one has none. */
async function readRepos(host: string | undefined, dirs: Array<{ dir: string; root: boolean }>): Promise<RepoRead> {
  const reads = dirs.map(({ dir, root }) => readFolder(host, dir, root));
  const settled: Array<RepoRead | undefined> = reads.map(() => undefined);
  // The first failed folder fails the round at once, as one RPC did.
  const all = Promise.all(reads.map((p, i) => p.then((g) => { settled[i] = g; })));
  all.catch(() => { /* a failure after the deadline: that folder's own read logged it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late: boolean;
  try {
    late = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), ROUND_MAX_MS); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const got: RepoRead[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const g = settled[i] ?? (late ? await lastReading(host, dirs[i]!) : undefined);
    if (g === undefined) throw new Error(`git read of ${dirs[i]!.dir} still running after ${ROUND_MAX_MS} ms`);
    got.push(g);
  }
  const away = got.find((g): g is 'host_offline' | 'daemon_needs_upgrade' => typeof g === 'string');
  if (away) return away;
  const out: GitRepoStatus[] = [];
  for (const repos of got as GitRepoStatus[][]) {
    for (const r of repos) if (!out.some((o) => o.repoRoot === r.repoRoot)) out.push(r);
  }
  return out;
}

/** A folder's last finished reading (undefined: none yet). */
async function lastReading(host: string | undefined, d: { dir: string; root: boolean }): Promise<RepoRead | undefined> {
  const lane = isLocalHost(host) ? '__local__' : host!;
  const asked = `${lane}\u0000${d.dir}`;
  const alias = d.root ? undefined : folderRoot.get(asked);
  const last = folders.get(alias?.key ?? asked)?.last;
  return last ? last.p.catch(() => undefined) : undefined;
}

/** The directories to read, the repo the session changed most first (`root`: a Changed
 *  group's repo root, read as itself). */
function dirsFor(cwd: string | undefined, peek: { groups: Array<{ repoRoot: string; files: unknown[] }> } | null): Array<{ dir: string; root: boolean }> {
  const touched = (peek?.groups ?? [])
    .filter((g) => g.repoRoot && g.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length)
    .map((g) => ({ dir: g.repoRoot, root: true }));
  const out: Array<{ dir: string; root: boolean }> = [];
  for (const d of [...touched, ...(cwd ? [{ dir: cwd, root: false }] : [])]) {
    if (!out.some((o) => o.dir === d.dir)) out.push(d);
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
    const readStart = deps.now();
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
    // Counted, and its repos moved: the session (or someone) edited files, so its own list may
    // have grown while no Changed tab was open to recompute it.
    // (A list computed since this read began already saw those edits.)
    else if (changedFiles !== null && prev && readOk && record?.cwd && isWatched(sessionId)
      && !sameRepos(prev.glance.repos, repos) && (countedAt.get(sessionId) ?? -Infinity) < readStart) {
      const rec = record;
      void sessionWroteSinceCount(sessionId, rec).then((wrote) => { if (wrote && isWatched(sessionId)) queueCount(sessionId, false, true); });
    }
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
 * behind (the web gets the result as an event); a session never read is null
 * now. `waitMs` (tests only; the route passes none) waits that long for a cold
 * or refreshed answer. Marks every asked session watched.
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
function queueCount(sessionId: string, front = false, recount = false): void {
  const last = countQueued.get(sessionId);
  const queued = countQueue.includes(sessionId);
  const retryMs = recount ? RECOUNT_MS : front ? COUNT_RETRY_FRONT_MS : COUNT_RETRY_MS;
  if (queued) {
    if (recount) recountDue.add(sessionId);
    if (!front) return;
    countQueue.splice(countQueue.indexOf(sessionId), 1);
  } else if (last !== undefined && deps.now() - last < retryMs) {
    // Too soon: a recount comes back when its window ends (a session that edits once and
    // stops is still counted again).
    if (recount && !recountTimers.has(sessionId)) {
      recountDue.add(sessionId);
      const t = setTimeout(() => {
        recountTimers.delete(sessionId);
        if (isWatched(sessionId)) queueCount(sessionId, false, true);
        else recountDue.delete(sessionId);
      }, retryMs - (deps.now() - last));
      t.unref?.();
      recountTimers.set(sessionId, t);
    }
    return;
  } else if (countQueue.length >= COUNT_QUEUE_MAX) {
    return;
  }
  if (recount) recountDue.add(sessionId);
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
      const recount = recountDue.delete(id);
      if (!isWatched(id) || (!recount && cache.get(id)?.glance.changedFiles != null)) continue;
      if (deps.shedding()) { countQueued.delete(id); continue; }
      try {
        const record = await deps.getSession(id);
        if (record?.cwd) {
          // The transcript as this count reads it: a later recount needs it to have moved.
          const sig = await deps.transcriptSig(id, record).catch(() => null);
          await deps.countChanges(id, record, recount ? { recount: true } : undefined);
          if (sig !== null) stamp(countedSig, id, sig);
        }
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
  stamp(countedAt, sessionId, deps.now());
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
    if (isWatched(data.sessionId)) stamp(activeAt, data.sessionId, deps.now());
    noteSessionActivity(data.sessionId);
  }, { global: true, interest: [EventNames.SESSION_TOOL_RESULT, EventNames.SESSION_RESULT] });
  return () => {
    bus.unsubscribe('session-git-status');
    for (const t of activityTimers.values()) clearTimeout(t);
    activityTimers.clear();
    for (const t of recountTimers.values()) clearTimeout(t);
    recountTimers.clear();
    recountDue.clear();
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
  folders.clear();
  folderRoot.clear();
  countQueue.length = 0;
  countQueued.clear();
  recountDue.clear();
  for (const t of recountTimers.values()) clearTimeout(t);
  recountTimers.clear();
  countedAt.clear();
  countedSig.clear();
  activeAt.clear();
  countGen++;
  counting = false;
}
