/**
 * Per-turn working-tree snapshots, shared by both daemon twins.
 *
 * At the end of every turn of a session whose cwd is inside a git repository,
 * the daemon records the WHOLE working tree as a commit under a hidden ref,
 * `refs/walnut/turns/<sessionId>/<n>`, without touching anything the user owns:
 *
 *   - the index: the snapshot is built in a TEMPORARY index file (a copy of the
 *     real one, so git only rehashes files whose stat changed), passed as
 *     GIT_INDEX_FILE; the real `.git/index` is never written;
 *   - HEAD and branches: `git commit-tree` makes a commit object without moving
 *     anything, and `git update-ref` writes only the hidden ref;
 *   - files: `git add` reads the tree, it writes objects only.
 *
 * The snapshot honours .gitignore (`--exclude-standard`), and a repo with an
 * untracked pile (a node_modules without a .gitignore) records its tracked
 * files only, never the pile. A tree equal to the previous snapshot makes no
 * new ref. Nothing ever runs `git gc`; retention deletes old refs only.
 *
 * Skipped, and the reason recorded: not a git repo, `index.lock` present, a
 * merge / rebase / cherry-pick / revert in progress, the time budget spent
 * (that repo then rests for a while), git failing.
 *
 * Every git child gets an env with no inherited GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE (and the other repo redirects, see src/lib/git-env.ts for
 * why), a fixed committer identity, and stdin closed at once.
 *
 * The snapshot never delays or breaks a turn: the tailer calls onTurnEnd and
 * returns; the work runs later, serialized per repository (at most two repos
 * at a time), coalesced per session, errors logged and swallowed.
 *
 * Commands built on the snapshots: list a session's snapshots, the diff of one
 * file between two of them (or one and the working tree), a restore that FIRST
 * snapshots the current state (so the restore is undoable) and refuses while a
 * turn of that session runs, and a comparison of named files with the
 * session's newest snapshot (the rewind guard's first fact, turn-guard-core.ts).
 *
 * How each twin gets it: daemon-standalone.ts imports createTurnSnapshots;
 * daemon-source.ts inlines `createTurnSnapshots.toString()` through
 * `__CREATE_TURN_SNAPSHOTS__`. So the factory body references NOTHING at
 * module scope: every helper lives inside it and every capability comes from
 * `deps`.
 */

export interface TurnSnapshotExecOptions {
  cwd: string
  encoding: 'utf-8' | 'buffer'
  timeout: number
  maxBuffer: number
  env: Record<string, string | undefined>
}

export interface TurnSnapshotExecFile {
  (
    file: string,
    args: string[],
    options: TurnSnapshotExecOptions,
    callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: unknown, stderr: unknown) => void,
  ): unknown
}

export interface TurnSnapshotStat {
  size: number
  mtimeMs?: number
  atimeMs?: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface TurnSnapshotFs {
  copyFile(src: string, dst: string): Promise<void>
  unlink(p: string): Promise<void>
  lstat(p: string): Promise<TurnSnapshotStat>
  readFile(p: string): Promise<Uint8Array>
  readlink(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  mkdir(p: string, opts: { recursive: true }): Promise<unknown>
  /** Keeps a copied index's timestamp, so git's racy-entry check stays exact. */
  utimes?(p: string, atime: Date, mtime: Date): Promise<void>
  /** Maps a path spelled through a symlink (/var vs /private/var) into the repo. */
  realpath?(p: string): Promise<string>
}

export interface TurnSnapshotPath {
  join(...parts: string[]): string
  resolve(...parts: string[]): string
  relative(from: string, to: string): string
  isAbsolute(p: string): boolean
  dirname(p: string): string
  sep: string
}

export interface TurnSnapshotDeps {
  execFile?: TurnSnapshotExecFile
  fs?: TurnSnapshotFs
  path?: TurnSnapshotPath
  /** The base env for git children; redirect vars are stripped from a copy. */
  env?: Record<string, string | undefined>
  /** Where temporary index files go (the daemon's own directory). */
  tmpDir?: string
  /** Persisted settings (`{enabled, keep}`), read once at start. */
  settingsPath?: string
  now?: () => number
  randomHex?: () => string
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, data?: Record<string, unknown>) => void
  /** True while a turn of this session runs (restore refuses then). */
  turnActive?: (sid: string) => boolean
  /** A repository root the snapshots may write to (tests pin a temp root). */
  allowRepo?: (repoRoot: string) => boolean
  /** Off from the start (WALNUT_TURN_SNAPSHOTS=0); a configure cannot turn it on. */
  forceDisabled?: boolean
  /** Budget for ONE snapshot (default 10s). */
  timeBudgetMs?: number
  /** Untracked files a snapshot adds at most (default 2000); more = tracked files only. */
  maxUntrackedFiles?: number
  /** Total size of the untracked files added (default 64 MB). */
  maxUntrackedBytes?: number
  /** One untracked file larger than this is left out (default 8 MB). */
  maxUntrackedFileBytes?: number
  /** How long a repo rests after a snapshot ran out of time (default 15 min). */
  timeoutBackoffMs?: number
  /** Files listed per snapshot in its record (default 500). */
  maxListedFiles?: number
  /** Default retention per session (default 100). */
  keep?: number
  /** Refs of ANY session older than this are swept (default 30 days; tests override). */
  refMaxAgeMs?: number
  /** A repository is swept at most this often (default 24h; tests override). */
  sweepEveryMs?: number
}

export type TurnSnapshotKind = 'start' | 'turn' | 'pre-restore' | 'restored'

/** One file a snapshot changed against the one before it. */
export interface TurnSnapshotFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number | null
  deletions: number | null
}

export interface TurnSnapshotEntry {
  n: number
  sha: string
  tree: string
  at: number
  kind: TurnSnapshotKind
  /** 'tracked-only' = the untracked files were over the cap and left out. */
  capture: 'full' | 'tracked-only'
  untrackedSkipped?: number
  files: TurnSnapshotFile[]
  filesTotal: number
  /** What `files` is measured against. */
  base: 'previous' | 'head' | 'empty'
  /** The commit `files` was measured against. */
  prevSha?: string
  restoredFrom?: number
}

export interface TurnSnapshotSkip {
  at: number
  reason: string
  detail?: string
}

export type TurnSnapshotOutcome =
  | { status: 'created'; n: number; sha: string; tree: string; files: TurnSnapshotFile[] }
  | { status: 'unchanged'; n: number; sha: string; tree: string }
  | { status: 'skipped'; reason: string; detail?: string }

export interface TurnSnapshotListResult {
  enabled: boolean
  repoRoot: string | null
  snapshots: TurnSnapshotEntry[]
  skipped: TurnSnapshotSkip[]
  lastTurnEndAt: number | null
}

export interface TurnSnapshotDiffResult {
  path: string
  filePath: string
  before: string
  after: string
  status: 'added' | 'modified' | 'deleted'
  binary?: boolean
  tooLarge?: boolean
  fromN: number | null
  toN: number | null
}

export interface TurnSnapshotRestorePlan {
  n: number
  write: string[]
  delete: string[]
  /** Files absent from the snapshot that it never recorded (tracked-only capture): left alone. */
  keep: string[]
}

export interface TurnSnapshotRestoreResult extends TurnSnapshotRestorePlan {
  dryRun: boolean
  /** The snapshot of the state BEFORE the restore (restore to it to undo). */
  backupN: number | null
  /** The snapshot of the state after the restore. */
  afterN: number | null
}

export interface TurnSnapshotCompareFile {
  /** Absolute path, as the caller sent it. */
  path: string
  /** Repo-relative, when the file is inside the repository. */
  rel: string | null
  exists: boolean
  /** A regular file (not a link, not a directory). */
  regular: boolean
  /** Current text (null: missing, binary or over 4 MB). */
  text: string | null
  /** Current content vs the session's newest snapshot. */
  snapshot: 'same' | 'differs' | 'unknown'
}

export interface TurnSnapshotCompareResult {
  repoRoot: string | null
  snapshotN: number | null
  snapshotAt: number | null
  /** The newest snapshot is older than the session's last turn end. */
  snapshotStale: boolean
  files: TurnSnapshotCompareFile[]
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createTurnSnapshots(deps: TurnSnapshotDeps) {
  var TIME_BUDGET_MS = deps.timeBudgetMs ?? 10_000
  var MAX_UNTRACKED_FILES = deps.maxUntrackedFiles ?? 2000
  var MAX_UNTRACKED_BYTES = deps.maxUntrackedBytes ?? 64 * 1024 * 1024
  var MAX_UNTRACKED_FILE_BYTES = deps.maxUntrackedFileBytes ?? 8 * 1024 * 1024
  var TIMEOUT_BACKOFF_MS = deps.timeoutBackoffMs ?? 15 * 60_000
  var MAX_LISTED_FILES = deps.maxListedFiles ?? 500
  var DEFAULT_KEEP = deps.keep ?? 100
  // Retention per session never reaches a session that ended: its refs would
  // stay in the user's repo for good. The age sweep covers every session.
  var REF_MAX_AGE_MS = deps.refMaxAgeMs ?? 30 * 24 * 3600_000
  var SWEEP_EVERY_MS = deps.sweepEveryMs ?? 24 * 3600_000
  /** Less budget left than this after a capture: the sweep waits for the next one. */
  var SWEEP_MIN_BUDGET_MS = 1000
  var SWEEP_CHUNK = 1000
  var MAX_BLOB_BYTES = 4 * 1024 * 1024
  var REF_PREFIX = 'refs/walnut/turns/'
  var MAX_CONCURRENT = 2
  var SKIPS_PER_SESSION = 10
  var MAX_TRACKED_SESSIONS = 500
  /** Mirrors GIT_REPO_REDIRECT_VARS in src/lib/git-env.ts (a test pins the two). */
  var REDIRECT_VARS = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
  ]
  var now = deps.now ?? (() => Date.now())
  var log = deps.log ?? (() => {})
  var randomHex = deps.randomHex ?? (() => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10))

  var settings = { enabled: !deps.forceDisabled, keep: DEFAULT_KEEP }
  var settingsLoaded: Promise<void> | null = null
  /** Recent skips per session, newest last. */
  var skips = new Map<string, TurnSnapshotSkip[]>()
  /** The `v` of the last result line handled per session (a replayed line is ignored). */
  var lastResultV = new Map<string, number>()
  var lastTurnEnd = new Map<string, number>()
  /** When a snapshot last confirmed the session's state (created, or unchanged). */
  var confirmedAt = new Map<string, number>()
  /** Sessions with a snapshot queued and not started (a second turn end rides it). */
  var queued = new Set<string>()
  var baselineChecked = new Set<string>()
  /** Per-repository chain: snapshots of one repo never overlap. */
  var repoChains = new Map<string, Promise<unknown>>()
  var repoBackoffUntil = new Map<string, number>()
  /** When each repository was last swept for old refs (this daemon's clock). */
  var lastSweepAt = new Map<string, number>()
  /** Sessions with a snapshot entered and not finished (queued or running). */
  var inFlight = new Map<string, number>()
  var running = 0
  var waiters: Array<() => void> = []
  var emptyTreeByRoot = new Map<string, string>()

  // ── small helpers ──

  function err(code: string, message: string): Error {
    var e = new Error(message) as Error & { code?: string }
    e.code = code
    return e
  }

  function remember(map: Map<string, unknown>, key: string): void {
    if (map.size <= MAX_TRACKED_SESSIONS) return
    var first = map.keys().next()
    if (!first.done && first.value !== key) map.delete(first.value)
  }

  function recordSkip(sid: string, reason: string, detail?: string): void {
    var list = skips.get(sid)
    if (!list) { list = []; skips.set(sid, list); remember(skips as Map<string, unknown>, sid) }
    list.push(detail ? { at: now(), reason: reason, detail: detail } : { at: now(), reason: reason })
    if (list.length > SKIPS_PER_SESSION) list.splice(0, list.length - SKIPS_PER_SESSION)
  }

  /** A session id usable as one ref path component. */
  function validSid(sid: unknown): sid is string {
    return typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid)
      && sid.indexOf('..') < 0 && !/\.lock$/.test(sid)
  }

  /** A repo-relative path a caller may name: no absolute path, no `..`, no `.git`. */
  function validRel(rel: unknown): rel is string {
    if (typeof rel !== 'string' || !rel || rel.length > 4096) return false
    if (rel.charAt(0) === '/' || rel.indexOf('\\') >= 0 || rel.indexOf('\u0000') >= 0) return false
    var parts = rel.split('/')
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i]
      if (p === '' || p === '.' || p === '..') return false
      if (p.toLowerCase() === '.git') return false
    }
    return true
  }

  function gitEnv(index?: string): Record<string, string | undefined> {
    var env: Record<string, string | undefined> = Object.assign({}, deps.env || {})
    for (var i = 0; i < REDIRECT_VARS.length; i++) delete env[REDIRECT_VARS[i]]
    // Config lives where it always does; nothing may ask a question or take an
    // optional lock on the user's index; the snapshot names itself as its author.
    env.LANG = 'C'
    env.LC_ALL = 'C'
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_OPTIONAL_LOCKS = '0'
    env.GIT_AUTHOR_NAME = 'Walnut'
    env.GIT_AUTHOR_EMAIL = 'walnut@localhost'
    env.GIT_COMMITTER_NAME = 'Walnut'
    env.GIT_COMMITTER_EMAIL = 'walnut@localhost'
    if (index) env.GIT_INDEX_FILE = index
    return env
  }

  interface GitRun { code: number; stdout: string; stderr: string; buf?: Uint8Array; overflow?: boolean }

  /**
   * One git run. Never rejects for an exit code (exit codes are answers);
   * rejects with code 'timeout' when the deadline passed or git was killed.
   */
  function git(args: string[], opts: { cwd: string; deadline: number; index?: string; input?: string; buffer?: boolean; maxBuffer?: number }): Promise<GitRun> {
    return new Promise((resolve, reject) => {
      var exec = deps.execFile
      if (!exec) return reject(err('no-git', 'turn snapshots: no execFile'))
      var left = opts.deadline - now()
      if (left <= 0) return reject(err('timeout', 'time budget spent'))
      var child = exec('git', args, {
        cwd: opts.cwd,
        encoding: opts.buffer ? 'buffer' : 'utf-8',
        timeout: Math.max(50, Math.floor(left)),
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        env: gitEnv(opts.index),
      }, (e, stdout, stderr) => {
        var outText = opts.buffer ? '' : String(stdout ?? '')
        var errText = stderr == null ? '' : (typeof stderr === 'string' ? stderr : String(stderr))
        if (!e) return resolve({ code: 0, stdout: outText, stderr: errText, buf: opts.buffer ? (stdout as Uint8Array) : undefined })
        var x = e as Error & { code?: unknown; killed?: boolean; signal?: unknown }
        if (/maxBuffer/i.test(String(x.message || '')) || x.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ code: 1, stdout: outText, stderr: errText, overflow: true })
        }
        if (x.killed || x.signal) return reject(err('timeout', 'git ' + args[0] + ' ran out of time'))
        if (typeof x.code === 'number') return resolve({ code: x.code, stdout: outText, stderr: errText || String(x.message || '') })
        reject(err('git-failed', 'git ' + args[0] + ': ' + (x.message || String(x))))
      }) as { stdin?: { end(data?: string): void; on?(ev: string, fn: () => void): unknown } | null } | undefined
      // Close stdin at once (or after the input): no git here may ever wait on it.
      try {
        if (child && child.stdin) {
          if (child.stdin.on) child.stdin.on('error', () => {})
          child.stdin.end(opts.input ?? '')
        }
      } catch { /* the child is already gone */ }
    })
  }

  function firstLine(s: string): string {
    return String(s || '').trim().split('\n')[0] || ''
  }

  async function exists(p: string): Promise<boolean> {
    if (!deps.fs) return false
    try { await deps.fs.lstat(p); return true } catch { return false }
  }

  // ── settings ──

  async function loadSettings(): Promise<void> {
    if (!deps.settingsPath || !deps.fs) return
    try {
      var raw = await deps.fs.readFile(deps.settingsPath)
      var parsed = JSON.parse(new TextDecoder().decode(raw)) as { enabled?: unknown; keep?: unknown }
      if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled && !deps.forceDisabled
      if (typeof parsed.keep === 'number' && parsed.keep >= 1) settings.keep = Math.min(Math.floor(parsed.keep), 10_000)
    } catch { /* no file yet: defaults */ }
  }

  function ready(): Promise<void> {
    if (!settingsLoaded) settingsLoaded = loadSettings()
    return settingsLoaded
  }

  async function configure(input: { enabled?: unknown; keep?: unknown }): Promise<{ enabled: boolean; keep: number; changed: boolean }> {
    await ready()
    var before = settings.enabled + ':' + settings.keep
    if (typeof input.enabled === 'boolean') settings.enabled = input.enabled && !deps.forceDisabled
    if (typeof input.keep === 'number' && input.keep >= 1) settings.keep = Math.min(Math.floor(input.keep), 10_000)
    var changed = before !== settings.enabled + ':' + settings.keep
    if (changed && deps.settingsPath && deps.fs) {
      try {
        await deps.fs.mkdir(deps.path ? deps.path.dirname(deps.settingsPath) : '.', { recursive: true })
        await deps.fs.writeFile(deps.settingsPath, JSON.stringify({ enabled: settings.enabled, keep: settings.keep }))
      } catch (e) {
        log('warn', 'turn snapshots: settings not persisted', { error: (e as Error).message })
      }
    }
    return { enabled: settings.enabled, keep: settings.keep, changed: changed }
  }

  // ── the concurrency gates ──

  async function acquireSlot(): Promise<void> {
    if (running < MAX_CONCURRENT) { running++; return }
    await new Promise<void>((resolve) => waiters.push(resolve))
    running++
  }

  function releaseSlot(): void {
    running--
    var next = waiters.shift()
    if (next) next()
  }

  /** Run `work` after every earlier job on this repo, inside a global slot. */
  function inRepo<T>(root: string, work: () => Promise<T>): Promise<T> {
    var prev = repoChains.get(root) || Promise.resolve()
    var run = prev.catch(() => {}).then(async () => {
      await acquireSlot()
      try { return await work() } finally { releaseSlot() }
    })
    var tail = run.catch(() => {})
    repoChains.set(root, tail)
    void tail.then(() => { if (repoChains.get(root) === tail) repoChains.delete(root) })
    return run
  }

  // ── parsers (pure) ──

  /** `git for-each-ref` records: fields split by NUL, each record ended by NUL + newline. */
  function parseRefRecords(stdout: string): TurnSnapshotEntry[] {
    var out: TurnSnapshotEntry[] = []
    var records = String(stdout || '').split('\u0000\n')
    for (var i = 0; i < records.length; i++) {
      var rec = records[i]
      if (!rec || !rec.trim()) continue
      var f = rec.split('\u0000')
      if (f.length < 5) continue
      var ref = f[0].replace(/^\n+/, '')
      var slash = ref.lastIndexOf('/')
      var n = Number(ref.slice(slash + 1))
      if (!Number.isInteger(n) || n < 0) continue
      var meta: Record<string, unknown> = {}
      try { meta = JSON.parse(f.slice(4).join('\u0000').trim() || '{}') as Record<string, unknown> } catch { meta = {} }
      var atSec = Number(f[3])
      var files: TurnSnapshotFile[] = []
      var rawFiles = Array.isArray(meta.files) ? meta.files as unknown[] : []
      for (var j = 0; j < rawFiles.length; j++) {
        var r = rawFiles[j] as unknown[]
        if (!Array.isArray(r) || typeof r[1] !== 'string') continue
        var st = r[0] === 'A' ? 'added' : r[0] === 'D' ? 'deleted' : 'modified'
        files.push({
          path: r[1],
          status: st as TurnSnapshotFile['status'],
          additions: typeof r[2] === 'number' ? r[2] : null,
          deletions: typeof r[3] === 'number' ? r[3] : null,
        })
      }
      var kind = meta.kind === 'start' || meta.kind === 'pre-restore' || meta.kind === 'restored' ? meta.kind : 'turn'
      var entry: TurnSnapshotEntry = {
        n: n,
        sha: f[1],
        tree: f[2],
        at: typeof meta.at === 'number' ? meta.at : (Number.isFinite(atSec) ? atSec * 1000 : 0),
        kind: kind as TurnSnapshotKind,
        capture: meta.capture === 'tracked-only' ? 'tracked-only' : 'full',
        files: files,
        filesTotal: typeof meta.filesTotal === 'number' ? meta.filesTotal : files.length,
        base: meta.base === 'head' || meta.base === 'empty' ? meta.base : 'previous',
      }
      // -1 = "more than the listing could hold": the count itself is unknown.
      if (typeof meta.untrackedSkipped === 'number' && meta.untrackedSkipped !== 0) entry.untrackedSkipped = meta.untrackedSkipped
      if (typeof meta.prev === 'string' && /^[0-9a-f]{40,64}$/.test(meta.prev)) entry.prevSha = meta.prev
      if (typeof meta.restoredFrom === 'number') entry.restoredFrom = meta.restoredFrom
      out.push(entry)
    }
    out.sort((a, b) => a.n - b.n)
    return out
  }

  /** `git diff-tree -z --name-status` → [status letter, path]. */
  function parseNameStatusZ(stdout: string): Array<{ s: string; p: string }> {
    var parts = String(stdout || '').split('\u0000')
    var out: Array<{ s: string; p: string }> = []
    for (var i = 0; i + 1 < parts.length; i += 2) {
      var s = parts[i].replace(/^\n+/, '')
      if (!s) { i--; continue }
      out.push({ s: s.charAt(0), p: parts[i + 1] })
    }
    return out
  }

  /** `git diff-tree -z --numstat` → path → [added, deleted] (null for a binary file). */
  function parseNumstatZ(stdout: string): Map<string, [number | null, number | null]> {
    var map = new Map<string, [number | null, number | null]>()
    var parts = String(stdout || '').split('\u0000')
    for (var i = 0; i < parts.length; i++) {
      var m = /^\n?(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i])
      if (!m) continue
      map.set(m[3], [m[1] === '-' ? null : Number(m[1]), m[2] === '-' ? null : Number(m[2])])
    }
    return map
  }

  function statusOf(letter: string): TurnSnapshotFile['status'] {
    return letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
  }

  // ── repository facts ──

  interface Repo {
    root: string
    index: string
    lock: string
    inProgress: Array<{ path: string; reason: string }>
  }

  async function resolveRepo(cwd: string, deadline: number): Promise<Repo | null> {
    var r = await git([
      'rev-parse', '--show-toplevel',
      '--git-path', 'index', '--git-path', 'index.lock',
      '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply',
      '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD',
    ], { cwd: cwd, deadline: deadline })
    if (r.code !== 0) return null
    var lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length < 8) return null
    var p = deps.path
    var abs = (x: string) => (p ? (p.isAbsolute(x) ? x : p.resolve(cwd, x)) : x)
    return {
      root: lines[0],
      index: abs(lines[1]),
      lock: abs(lines[2]),
      inProgress: [
        { path: abs(lines[3]), reason: 'merge-in-progress' },
        { path: abs(lines[4]), reason: 'rebase-in-progress' },
        { path: abs(lines[5]), reason: 'rebase-in-progress' },
        { path: abs(lines[6]), reason: 'cherry-pick-in-progress' },
        { path: abs(lines[7]), reason: 'revert-in-progress' },
      ],
    }
  }

  async function headCommit(root: string, deadline: number): Promise<string | null> {
    var r = await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, deadline: deadline })
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
  }

  async function listRefs(root: string, sid: string, deadline: number): Promise<TurnSnapshotEntry[]> {
    var r = await git([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(tree)%00%(committerdate:unix)%00%(contents:body)%00',
      REF_PREFIX + sid + '/',
    ], { cwd: root, deadline: deadline })
    if (r.code !== 0) throw err('git-failed', 'for-each-ref: ' + firstLine(r.stderr))
    return parseRefRecords(r.stdout)
  }

  async function emptyTree(root: string, deadline: number): Promise<string> {
    var known = emptyTreeByRoot.get(root)
    if (known) return known
    var r = await git(['mktree'], { cwd: root, deadline: deadline, input: '' })
    if (r.code !== 0 || !r.stdout.trim()) throw err('git-failed', 'mktree: ' + firstLine(r.stderr))
    emptyTreeByRoot.set(root, r.stdout.trim())
    return r.stdout.trim()
  }

  async function treeOf(root: string, rev: string, deadline: number): Promise<string> {
    var r = await git(['rev-parse', rev + '^{tree}'], { cwd: root, deadline: deadline })
    if (r.code !== 0) throw err('git-failed', 'rev-parse tree: ' + firstLine(r.stderr))
    return r.stdout.trim()
  }

  async function diffTrees(root: string, a: string, b: string, deadline: number, paths?: string[]): Promise<Array<{ s: string; p: string }>> {
    var args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]
    if (paths && paths.length) args = ['--literal-pathspecs'].concat(args, ['--'], paths)
    var r = await git(args, { cwd: root, deadline: deadline })
    if (r.code !== 0) throw err('git-failed', 'diff-tree: ' + firstLine(r.stderr))
    return parseNameStatusZ(r.stdout)
  }

  async function summarize(root: string, a: string, b: string, deadline: number): Promise<{ files: TurnSnapshotFile[]; total: number }> {
    var names = await diffTrees(root, a, b, deadline)
    var r = await git(['diff-tree', '-r', '-z', '--no-renames', '--numstat', a, b], { cwd: root, deadline: deadline })
    var stats = r.code === 0 ? parseNumstatZ(r.stdout) : new Map<string, [number | null, number | null]>()
    var files: TurnSnapshotFile[] = []
    for (var i = 0; i < names.length && files.length < MAX_LISTED_FILES; i++) {
      var st = stats.get(names[i].p)
      files.push({
        path: names[i].p,
        status: statusOf(names[i].s),
        additions: st ? st[0] : null,
        deletions: st ? st[1] : null,
      })
    }
    return { files: files, total: names.length }
  }

  /** Run `git <prefix> -- <paths>` in chunks (argv stays bounded). */
  async function inChunks(prefix: string[], paths: string[], opts: { cwd: string; deadline: number; index?: string }): Promise<void> {
    for (var i = 0; i < paths.length; i += 200) {
      var r = await git(prefix.concat(['--'], paths.slice(i, i + 200)), opts)
      if (r.code !== 0) throw err('git-failed', prefix.filter((x) => x.charAt(0) !== '-').join(' ') + ': ' + firstLine(r.stderr))
    }
  }

  // ── the capture ──

  interface Built {
    tree: string
    capture: 'full' | 'tracked-only'
    untrackedSkipped: number
  }

  /**
   * Build the working tree into the temp index `index` and write its tree.
   * `forcePaths` (a restore's targets) are added with -f even when the
   * untracked pile was over the cap or the file is ignored.
   */
  async function buildTree(repo: Repo, index: string, head: string | null, deadline: number): Promise<Built> {
    var root = repo.root
    var seeded = false
    if (deps.fs && await exists(repo.index)) {
      try {
        var srcStat = await deps.fs.lstat(repo.index)
        await deps.fs.copyFile(repo.index, index)
        // Same mtime as the original: git compares each entry's mtime with the
        // index file's own to spot a file changed in the second it was indexed.
        if (deps.fs.utimes && typeof srcStat.mtimeMs === 'number') {
          await deps.fs.utimes(index, new Date(srcStat.atimeMs ?? srcStat.mtimeMs), new Date(srcStat.mtimeMs))
        }
        seeded = true
      } catch { seeded = false }
    }
    if (!seeded && head) {
      var rt = await git(['read-tree', head], { cwd: root, deadline: deadline, index: index })
      if (rt.code !== 0) throw err('git-failed', 'read-tree: ' + firstLine(rt.stderr))
    }
    var up = await git(['add', '-u'], { cwd: root, deadline: deadline, index: index })
    if (up.code !== 0 && seeded && head) {
      // A copied index git cannot use here (a split index, an extension this git
      // does not know): start over from HEAD, which costs a full rehash, once.
      try { if (deps.fs) await deps.fs.unlink(index) } catch { /* not there */ }
      var rt2 = await git(['read-tree', head], { cwd: root, deadline: deadline, index: index })
      if (rt2.code !== 0) throw err('git-failed', 'read-tree: ' + firstLine(rt2.stderr))
      up = await git(['add', '-u'], { cwd: root, deadline: deadline, index: index })
    }
    if (up.code !== 0) throw err('git-failed', 'add -u: ' + firstLine(up.stderr))

    // Untracked, honouring .gitignore. A list that overflows the buffer, or more
    // files / bytes than the caps, is a pile nobody meant to keep: tracked only.
    var capture: 'full' | 'tracked-only' = 'full'
    var untrackedSkipped = 0
    var ls = await git(['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd: root, deadline: deadline, index: index, maxBuffer: 2 * 1024 * 1024,
    })
    if (ls.overflow) {
      capture = 'tracked-only'
      untrackedSkipped = -1
    } else if (ls.code !== 0) {
      throw err('git-failed', 'ls-files: ' + firstLine(ls.stderr))
    } else {
      var untracked = ls.stdout.split('\u0000').filter((x) => x.length > 0)
      if (untracked.length > MAX_UNTRACKED_FILES) {
        capture = 'tracked-only'
        untrackedSkipped = untracked.length
      } else if (untracked.length > 0) {
        var keepList: string[] = []
        var total = 0
        var bigOnes = 0
        var p = deps.path
        for (var i = 0; i < untracked.length; i++) {
          var rel = untracked[i]
          var size = 0
          if (deps.fs && p) {
            try {
              var st = await deps.fs.lstat(p.join(root, rel))
              size = st.isFile() ? st.size : 0
            } catch { continue }
          }
          if (size > MAX_UNTRACKED_FILE_BYTES) { bigOnes++; continue }
          total += size
          keepList.push(rel)
        }
        if (total > MAX_UNTRACKED_BYTES) {
          capture = 'tracked-only'
          untrackedSkipped = untracked.length
        } else {
          if (bigOnes > 0) { capture = 'tracked-only'; untrackedSkipped = bigOnes }
          await inChunks(['--literal-pathspecs', 'add'], keepList, { cwd: root, deadline: deadline, index: index })
        }
      }
    }
    return { tree: await writeTree(root, index, deadline), capture: capture, untrackedSkipped: untrackedSkipped }
  }

  async function writeTree(root: string, index: string, deadline: number): Promise<string> {
    var wt = await git(['write-tree'], { cwd: root, deadline: deadline, index: index })
    if (wt.code !== 0 || !wt.stdout.trim()) throw err('git-failed', 'write-tree: ' + firstLine(wt.stderr))
    return wt.stdout.trim()
  }

  /**
   * Add `paths` that exist on disk with -f (over the untracked cap, or
   * ignored) to an index `buildTree` filled, and write the tree again. A
   * restore's targets go through here so its backup holds what it overwrites.
   */
  async function addForced(root: string, index: string, paths: string[], deadline: number): Promise<string> {
    var present: string[] = []
    for (var k = 0; k < paths.length; k++) {
      if (deps.path && await exists(deps.path.join(root, paths[k]))) present.push(paths[k])
    }
    if (present.length) await inChunks(['--literal-pathspecs', 'add', '-f'], present, { cwd: root, deadline: deadline, index: index })
    return writeTree(root, index, deadline)
  }

  // The temp-index dir is created once, lazily: the daemon hands in a path
  // under its own dir that need not exist yet.
  var tmpDirReady: Promise<void> | null = null
  async function tempIndexPath(): Promise<string> {
    var dir = deps.tmpDir || '/tmp'
    if (deps.tmpDir && deps.fs && !tmpDirReady) {
      var fsx = deps.fs
      tmpDirReady = fsx.mkdir(dir, { recursive: true }).then(() => undefined, () => { tmpDirReady = null })
    }
    if (tmpDirReady) await tmpDirReady
    return deps.path ? deps.path.join(dir, 'turn-index-' + randomHex()) : dir + '/turn-index-' + randomHex()
  }

  async function removeTemp(p: string): Promise<void> {
    if (!deps.fs) return
    try { await deps.fs.unlink(p) } catch { /* never created */ }
    try { await deps.fs.unlink(p + '.lock') } catch { /* none */ }
  }

  /** Commit `tree` under the next number and prune past the retention. */
  async function commitSnapshot(
    repo: Repo, sid: string, refs: TurnSnapshotEntry[], head: string | null, built: Built,
    kind: TurnSnapshotKind, deadline: number, extra?: { restoredFrom?: number },
  ): Promise<{ n: number; sha: string; files: TurnSnapshotFile[] }> {
    var root = repo.root
    var prev = refs.length ? refs[refs.length - 1] : null
    var baseTree: string
    var base: 'previous' | 'head' | 'empty'
    if (prev) { baseTree = prev.tree; base = 'previous' } else if (head) { baseTree = await treeOf(root, head, deadline); base = 'head' } else { baseTree = await emptyTree(root, deadline); base = 'empty' }
    var sum = await summarize(root, baseTree, built.tree, deadline)
    var n = prev ? prev.n + 1 : (kind === 'start' ? 0 : 1)
    var meta: Record<string, unknown> = {
      v: 1, sid: sid, kind: kind, at: now(), capture: built.capture,
      files: sum.files.map((f) => [f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M', f.path, f.additions, f.deletions]),
      filesTotal: sum.total, base: base,
    }
    if (built.untrackedSkipped) meta.untrackedSkipped = built.untrackedSkipped
    if (prev) meta.prev = prev.sha
    else if (head) meta.prev = head
    if (extra && typeof extra.restoredFrom === 'number') meta.restoredFrom = extra.restoredFrom
    var args = ['commit-tree', built.tree]
    if (head) args.push('-p', head)
    args.push('-m', 'walnut turn snapshot ' + n + ' (' + kind + ')', '-m', JSON.stringify(meta), '--no-gpg-sign')
    var ct = await git(args, { cwd: root, deadline: deadline })
    if (ct.code !== 0 && /no-gpg-sign/.test(ct.stderr)) {
      ct = await git(args.filter((a) => a !== '--no-gpg-sign'), { cwd: root, deadline: deadline })
    }
    if (ct.code !== 0 || !ct.stdout.trim()) throw err('git-failed', 'commit-tree: ' + firstLine(ct.stderr))
    var sha = ct.stdout.trim()
    // The empty old value: the ref must not exist yet (a second writer took n).
    for (var attempt = 0; attempt < 3; attempt++) {
      var ur = await git(['update-ref', REF_PREFIX + sid + '/' + n, sha, ''], { cwd: root, deadline: deadline })
      if (ur.code === 0) break
      if (attempt === 2) throw err('git-failed', 'update-ref: ' + firstLine(ur.stderr))
      n++
    }
    await prune(root, sid, deadline)
    return { n: n, sha: sha, files: sum.files }
  }

  /** Delete the oldest refs past the retention. Never gc. */
  async function prune(root: string, sid: string, deadline: number): Promise<void> {
    var refs = await listRefs(root, sid, deadline)
    var extra = refs.length - settings.keep
    if (extra <= 0) return
    var lines = ''
    for (var i = 0; i < extra; i++) lines += 'delete ' + REF_PREFIX + sid + '/' + refs[i].n + '\n'
    var r = await git(['update-ref', '--stdin'], { cwd: root, deadline: deadline, input: lines })
    if (r.code !== 0) log('warn', 'turn snapshots: prune failed', { sid: sid, error: firstLine(r.stderr) })
  }

  /** A session this daemon is working for right now: its refs are never swept. */
  function sessionBusy(sid: string): boolean {
    if ((inFlight.get(sid) || 0) > 0 || queued.has(sid)) return true
    try { return !!(deps.turnActive && deps.turnActive(sid)) } catch { return true }
  }

  /**
   * At most once per repository per SWEEP_EVERY_MS: delete every snapshot ref,
   * of any session, whose commit is older than REF_MAX_AGE_MS, except a busy
   * session's. Runs inside the capture's repo turn and budget. Never throws,
   * never gc.
   */
  async function maybeSweep(root: string, deadline: number): Promise<void> {
    var at = now()
    var last = lastSweepAt.get(root)
    if (last !== undefined && at - last < SWEEP_EVERY_MS) return
    if (deadline - at < SWEEP_MIN_BUDGET_MS) return // try again on the next capture
    lastSweepAt.set(root, at)
    remember(lastSweepAt as Map<string, unknown>, root)
    try {
      var r = await git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', REF_PREFIX], { cwd: root, deadline: deadline })
      if (r.code !== 0) { log('warn', 'turn snapshots: sweep list failed', { root: root, error: firstLine(r.stderr) }); return }
      var cutoffSec = (at - REF_MAX_AGE_MS) / 1000
      var dead: string[] = []
      var rows = r.stdout.split('\n')
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i].trim()
        var sp = row.lastIndexOf(' ')
        if (sp <= 0) continue
        var ref = row.slice(0, sp)
        var t = Number(row.slice(sp + 1))
        var m = /^refs\/walnut\/turns\/([^/]+)\/(\d+)$/.exec(ref)
        if (!m || !Number.isFinite(t) || t >= cutoffSec) continue
        if (sessionBusy(m[1])) continue
        dead.push(ref)
      }
      var deleted = 0
      for (var c = 0; c < dead.length; c += SWEEP_CHUNK) {
        var chunk = dead.slice(c, c + SWEEP_CHUNK)
        var u = await git(['update-ref', '--stdin'], { cwd: root, deadline: deadline, input: chunk.map((x) => 'delete ' + x + '\n').join('') })
        if (u.code !== 0) { log('warn', 'turn snapshots: sweep delete failed', { root: root, error: firstLine(u.stderr) }); break }
        deleted += chunk.length
      }
      if (deleted) log('info', 'turn snapshots: swept old refs', { root: root, deleted: deleted })
    } catch (e) {
      log('warn', 'turn snapshots: sweep failed', { root: root, error: (e as Error).message || String(e) })
    }
  }

  async function blockedReason(repo: Repo): Promise<string | null> {
    if (await exists(repo.lock)) return 'index-locked'
    for (var i = 0; i < repo.inProgress.length; i++) {
      if (await exists(repo.inProgress[i].path)) return repo.inProgress[i].reason
    }
    return null
  }

  /** The whole snapshot, run inside the repo's lock. */
  async function captureLocked(
    repo: Repo, sid: string, kind: TurnSnapshotKind, deadline: number,
    opts?: { onlyIfNone?: boolean; always?: boolean; restoredFrom?: number },
  ): Promise<TurnSnapshotOutcome> {
    var blocked = await blockedReason(repo)
    if (blocked) return { status: 'skipped', reason: blocked }
    var head = await headCommit(repo.root, deadline)
    var refs = await listRefs(repo.root, sid, deadline)
    if (opts && opts.onlyIfNone && refs.length > 0) return { status: 'skipped', reason: 'has-snapshots' }
    var index = await tempIndexPath()
    var built: Built
    try {
      built = await buildTree(repo, index, head, deadline)
    } finally {
      await removeTemp(index)
    }
    var prev = refs.length ? refs[refs.length - 1] : null
    if (prev && prev.tree === built.tree && !(opts && opts.always)) {
      return { status: 'unchanged', n: prev.n, sha: prev.sha, tree: built.tree }
    }
    var made = await commitSnapshot(repo, sid, refs, head, built, kind, deadline, opts)
    return { status: 'created', n: made.n, sha: made.sha, tree: built.tree, files: made.files }
  }

  /**
   * Snapshot `cwd`'s repository for `sid` now. Resolves with the outcome; a
   * skip is recorded on the session. Never rejects.
   */
  async function snapshot(sid: string, cwd: string, kind: TurnSnapshotKind, opts?: { onlyIfNone?: boolean }): Promise<TurnSnapshotOutcome> {
    await ready()
    var started = now()
    var repoRoot: string | null = null
    inFlight.set(sid, (inFlight.get(sid) || 0) + 1)
    try {
      if (!settings.enabled) return { status: 'skipped', reason: 'disabled' }
      if (!validSid(sid)) return { status: 'skipped', reason: 'bad-session-id' }
      if (!cwd) return { status: 'skipped', reason: 'no-cwd' }
      // The repo lookup is cheap and never counts as the repo being slow; the
      // budget starts when this snapshot's turn in the repo's queue does.
      var repo = await resolveRepo(cwd, started + Math.max(TIME_BUDGET_MS, 5000))
      if (!repo) { recordSkip(sid, 'not-a-repo'); return { status: 'skipped', reason: 'not-a-repo' } }
      var r = repo
      repoRoot = r.root
      if (deps.allowRepo && !deps.allowRepo(r.root)) return { status: 'skipped', reason: 'not-allowed' }
      var rest = repoBackoffUntil.get(r.root)
      if (rest && rest > now()) { recordSkip(sid, 'resting', 'a recent snapshot of this repository ran out of time'); return { status: 'skipped', reason: 'resting' } }
      var outcome = await inRepo(r.root, async () => {
        var deadline = now() + TIME_BUDGET_MS
        var o = await captureLocked(r, sid, kind, deadline, opts)
        if (o.status !== 'skipped') await maybeSweep(r.root, deadline)
        return o
      })
      if (outcome.status === 'skipped' && outcome.reason !== 'has-snapshots') recordSkip(sid, outcome.reason)
      if (outcome.status !== 'skipped') { confirmedAt.set(sid, now()); remember(confirmedAt as Map<string, unknown>, sid) }
      if (outcome.status === 'created') {
        log('info', 'turn snapshot created', { sid: sid, n: outcome.n, kind: kind, files: outcome.files.length, ms: now() - started })
      }
      return outcome
    } catch (e) {
      var code = (e as { code?: string }).code || 'error'
      var msg = (e as Error).message || String(e)
      if (code === 'timeout' && repoRoot) repoBackoffUntil.set(repoRoot, now() + TIMEOUT_BACKOFF_MS)
      recordSkip(sid, code === 'timeout' ? 'timeout' : 'error', msg)
      log('warn', 'turn snapshot skipped', { sid: sid, kind: kind, reason: code, error: msg, ms: now() - started })
      return { status: 'skipped', reason: code === 'timeout' ? 'timeout' : 'error', detail: msg }
    } finally {
      var left = (inFlight.get(sid) || 1) - 1
      if (left > 0) inFlight.set(sid, left)
      else inFlight.delete(sid)
    }
  }

  /**
   * The tailer saw a session's first turn begin: if it has no snapshot in this
   * repository yet, record the state BEFORE its first turn (snapshot 0), so
   * turn 1 has something to be measured against and restored to.
   */
  function onTurnStart(sid: string, cwd: string): void {
    if (!validSid(sid) || !cwd || baselineChecked.has(sid)) return
    baselineChecked.add(sid)
    remember(baselineChecked as unknown as Map<string, unknown>, sid)
    void ready().then(() => {
      if (!settings.enabled) return
      return snapshot(sid, cwd, 'start', { onlyIfNone: true })
    }).catch(() => {})
  }

  /** The tailer saw a result line (`v` = its end offset). Returns at once. */
  function onTurnEnd(sid: string, cwd: string, v?: number): void {
    if (!validSid(sid) || !cwd) return
    if (typeof v === 'number') {
      var last = lastResultV.get(sid)
      if (last !== undefined && v <= last) return
      lastResultV.set(sid, v)
      remember(lastResultV as Map<string, unknown>, sid)
    }
    lastTurnEnd.set(sid, now())
    remember(lastTurnEnd as Map<string, unknown>, sid)
    if (queued.has(sid)) return
    queued.add(sid)
    // Off the tailer's stack: the result line's own work finishes first.
    setTimeout(() => {
      queued.delete(sid)
      void snapshot(sid, cwd, 'turn').catch(() => {})
    }, 0)
  }

  // ── list ──

  async function list(sid: string, cwd: string): Promise<TurnSnapshotListResult> {
    await ready()
    var base: TurnSnapshotListResult = {
      enabled: settings.enabled, repoRoot: null, snapshots: [],
      skipped: (skips.get(sid) || []).slice(), lastTurnEndAt: lastTurnEnd.get(sid) ?? null,
    }
    if (!validSid(sid) || !cwd) return base
    var deadline = now() + 15_000
    var repo = await resolveRepo(cwd, deadline)
    if (!repo) return base
    base.repoRoot = repo.root
    base.snapshots = await listRefs(repo.root, sid, deadline)
    return base
  }

  // ── one file's diff ──

  async function readBlob(root: string, rev: string, rel: string, deadline: number): Promise<{ present: boolean; text: string; binary?: boolean; tooLarge?: boolean }> {
    var lt = await git(['--literal-pathspecs', 'ls-tree', '-z', rev, '--', rel], { cwd: root, deadline: deadline })
    if (lt.code !== 0) throw err('git-failed', 'ls-tree: ' + firstLine(lt.stderr))
    var rec = lt.stdout.split('\u0000')[0] || ''
    var m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(rec)
    if (!m) return { present: false, text: '' }
    if (m[2] === 'commit') return { present: true, text: 'Subproject commit ' + m[3] + '\n' }
    if (m[2] !== 'blob') return { present: false, text: '' }
    var cat = await git(['cat-file', 'blob', m[3]], { cwd: root, deadline: deadline, buffer: true, maxBuffer: MAX_BLOB_BYTES })
    if (cat.overflow) return { present: true, text: '', tooLarge: true }
    if (cat.code !== 0 || !cat.buf) throw err('git-failed', 'cat-file: ' + firstLine(cat.stderr))
    return decodeContent(cat.buf)
  }

  function decodeContent(buf: Uint8Array): { present: boolean; text: string; binary?: boolean } {
    var limit = Math.min(buf.length, 8000)
    for (var i = 0; i < limit; i++) if (buf[i] === 0) return { present: true, text: '', binary: true }
    return { present: true, text: new TextDecoder().decode(buf) }
  }

  async function readWorktree(root: string, rel: string): Promise<{ present: boolean; text: string; binary?: boolean; tooLarge?: boolean }> {
    if (!deps.fs || !deps.path) return { present: false, text: '' }
    var abs = deps.path.join(root, rel)
    var st: TurnSnapshotStat
    try { st = await deps.fs.lstat(abs) } catch { return { present: false, text: '' } }
    if (st.isSymbolicLink()) {
      try { return { present: true, text: await deps.fs.readlink(abs) } } catch { return { present: false, text: '' } }
    }
    if (!st.isFile()) return { present: false, text: '' }
    if (st.size > MAX_BLOB_BYTES) return { present: true, text: '', tooLarge: true }
    try { return decodeContent(await deps.fs.readFile(abs)) } catch { return { present: false, text: '' } }
  }

  /**
   * `path` (repo-relative) at snapshot `n` against the snapshot before it
   * (`against: 'previous'`), or the working tree against snapshot `n`
   * (`against: 'worktree'`).
   */
  async function fileDiff(sid: string, cwd: string, n: number, rel: string, against: 'previous' | 'worktree'): Promise<TurnSnapshotDiffResult> {
    if (!validSid(sid)) throw err('bad-request', 'bad session id')
    if (!validRel(rel)) throw err('bad-request', 'bad path')
    var deadline = now() + 15_000
    var repo = await resolveRepo(cwd, deadline)
    if (!repo) throw err('not-a-repo', 'not a git repository')
    var refs = await listRefs(repo.root, sid, deadline)
    var idx = -1
    for (var i = 0; i < refs.length; i++) if (refs[i].n === n) idx = i
    if (idx < 0) throw err('not-found', 'no snapshot ' + n)
    var target = refs[idx]
    var before: { present: boolean; text: string; binary?: boolean; tooLarge?: boolean }
    var after: { present: boolean; text: string; binary?: boolean; tooLarge?: boolean }
    var fromN: number | null
    var toN: number | null
    if (against === 'worktree') {
      before = await readBlob(repo.root, target.sha, rel, deadline)
      after = await readWorktree(repo.root, rel)
      fromN = target.n
      toN = null
    } else {
      // What the snapshot's own record was measured against, when it is still
      // there; else the previous retained snapshot; else its parent (HEAD then).
      var prevRev: string | null = null
      if (target.prevSha) {
        var ok = await git(['cat-file', '-e', target.prevSha + '^{commit}'], { cwd: repo.root, deadline: deadline })
        if (ok.code === 0) prevRev = target.prevSha
      }
      if (!prevRev && idx > 0) prevRev = refs[idx - 1].sha
      if (!prevRev && target.base === 'head') {
        var par = await git(['rev-parse', '-q', '--verify', target.sha + '^1'], { cwd: repo.root, deadline: deadline })
        if (par.code === 0) prevRev = par.stdout.trim()
      }
      // The snapshot number of that side, when it is one (null: HEAD then, or empty).
      fromN = null
      for (var j = 0; j < refs.length; j++) if (prevRev && refs[j].sha === prevRev) fromN = refs[j].n
      before = prevRev ? await readBlob(repo.root, prevRev, rel, deadline) : { present: false, text: '' }
      after = await readBlob(repo.root, target.sha, rel, deadline)
      toN = target.n
    }
    var status: TurnSnapshotDiffResult['status'] = !before.present && after.present ? 'added' : before.present && !after.present ? 'deleted' : 'modified'
    var out: TurnSnapshotDiffResult = {
      path: rel,
      filePath: deps.path ? deps.path.join(repo.root, rel) : repo.root + '/' + rel,
      before: before.text, after: after.text, status: status, fromN: fromN, toN: toN,
    }
    if (before.binary || after.binary) out.binary = true
    if (before.tooLarge || after.tooLarge) out.tooLarge = true
    return out
  }

  // ── restore ──

  /**
   * Put snapshot `n`'s version of `paths` (all files that differ, when absent)
   * back into the working tree. First snapshots the current state (`backupN`,
   * restore to it to undo), then the restored state (`afterN`). A dry run
   * answers the plan and writes nothing (no ref, no file).
   */
  async function restore(input: { sid: string; cwd: string; n: number; paths?: string[]; dryRun?: boolean }): Promise<TurnSnapshotRestoreResult> {
    await ready()
    var sid = input.sid
    if (!validSid(sid)) throw err('bad-request', 'bad session id')
    if (!input.cwd) throw err('bad-request', 'no working directory')
    if (input.paths) for (var q = 0; q < input.paths.length; q++) if (!validRel(input.paths[q])) throw err('bad-request', 'bad path: ' + String(input.paths[q]))
    if (!input.dryRun && deps.turnActive && deps.turnActive(sid)) throw err('turn-running', 'a turn of this session is running; restore after it ends')
    var deadline = now() + 60_000
    var repo = await resolveRepo(input.cwd, deadline)
    if (!repo) throw err('not-a-repo', 'not a git repository')
    var r = repo
    if (deps.allowRepo && !deps.allowRepo(r.root)) throw err('not-allowed', 'snapshots are not allowed in this repository')
    return inRepo(r.root, async () => {
      var blocked = await blockedReason(r)
      if (blocked) throw err(blocked, 'git is busy in this repository (' + blocked + ')')
      var head = await headCommit(r.root, deadline)
      var refs = await listRefs(r.root, sid, deadline)
      var target: TurnSnapshotEntry | null = null
      for (var i = 0; i < refs.length; i++) if (refs[i].n === input.n) target = refs[i]
      if (!target) throw err('not-found', 'no snapshot ' + input.n)
      var t = target
      var only = input.paths && input.paths.length ? new Set(input.paths) : null
      var index = await tempIndexPath()
      var built: Built
      var plan: Array<{ s: string; p: string }>
      try {
        built = await buildTree(r, index, head, deadline)
        var first = (await diffTrees(r.root, t.tree, built.tree, deadline)).filter((e) => !only || only.has(e.p))
        // Files the snapshot has and the capture does not: if one is on disk (an
        // untracked file over the cap, an ignored one), add it, so the backup
        // holds what the restore is about to overwrite.
        var force = first.filter((e) => e.s === 'D').map((e) => e.p)
        if (force.length) {
          var forcedTree = await addForced(r.root, index, force, deadline)
          if (forcedTree !== built.tree) {
            built = { tree: forcedTree, capture: built.capture, untrackedSkipped: built.untrackedSkipped }
            plan = (await diffTrees(r.root, t.tree, built.tree, deadline)).filter((e) => !only || only.has(e.p))
          } else {
            plan = first
          }
        } else {
          plan = first
        }
      } finally {
        await removeTemp(index)
      }
      var write = plan.filter((e) => e.s !== 'A').map((e) => e.p)
      var del: string[] = []
      var keep: string[] = []
      var headPaths = new Set<string>()
      var created = plan.filter((e) => e.s === 'A').map((e) => e.p)
      if (t.capture === 'tracked-only' && created.length && head) {
        // A file the snapshot never recorded may have existed untracked then.
        var inHead = await git(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', head, '--'].concat(created.slice(0, 500)), { cwd: r.root, deadline: deadline })
        if (inHead.code === 0) for (var x of inHead.stdout.split('\u0000')) if (x) headPaths.add(x)
      }
      for (var c = 0; c < created.length; c++) {
        if (t.capture === 'tracked-only' && !headPaths.has(created[c])) keep.push(created[c])
        else del.push(created[c])
      }
      var result: TurnSnapshotRestoreResult = { n: t.n, write: write, delete: del, keep: keep, dryRun: !!input.dryRun, backupN: null, afterN: null }
      if (input.dryRun || (write.length === 0 && del.length === 0)) return result
      if (deps.turnActive && deps.turnActive(sid)) throw err('turn-running', 'a turn of this session is running; restore after it ends')

      // 1. The backup: the state right now, unless the newest snapshot already is it.
      var latest = refs.length ? refs[refs.length - 1] : null
      if (latest && latest.tree === built.tree) {
        result.backupN = latest.n
      } else {
        var made = await commitSnapshot(r, sid, refs, head, built, 'pre-restore', deadline)
        result.backupN = made.n
      }
      // 2. Write the files from the snapshot through a temp index seeded with
      //    the backup tree (the user's index is never touched).
      var idx2 = await tempIndexPath()
      try {
        var rt = await git(['read-tree', built.tree], { cwd: r.root, deadline: deadline, index: idx2 })
        if (rt.code !== 0) throw err('git-failed', 'read-tree: ' + firstLine(rt.stderr))
        if (write.length) await inChunks(['--literal-pathspecs', 'checkout', t.sha], write, { cwd: r.root, deadline: deadline, index: idx2 })
      } finally {
        await removeTemp(idx2)
      }
      for (var d = 0; d < del.length; d++) {
        var abs = deps.path ? deps.path.join(r.root, del[d]) : r.root + '/' + del[d]
        var relBack = deps.path ? deps.path.relative(r.root, abs) : del[d]
        if (!relBack || relBack.indexOf('..') === 0 || (deps.path && deps.path.isAbsolute(relBack))) continue
        try {
          var st = deps.fs ? await deps.fs.lstat(abs) : null
          if (st && (st.isFile() || st.isSymbolicLink()) && deps.fs) await deps.fs.unlink(abs)
        } catch { /* already gone */ }
      }
      // 3. The state after, so the next turn is measured from here.
      var after = await captureLocked(r, sid, 'restored', deadline, { always: true, restoredFrom: t.n })
      if (after.status === 'created') result.afterN = after.n
      log('info', 'turn snapshot restored', { sid: sid, n: t.n, backupN: result.backupN, afterN: result.afterN, write: write.length, delete: del.length })
      return result
    })
  }

  // ── files against the newest snapshot (the rewind guard's first fact) ──

  /**
   * For absolute paths, the current content and whether it still matches this
   * session's newest snapshot (a backup taken before a restore does not count:
   * it records someone else's state). `snapshotStale` = the session ended a
   * turn after that snapshot (the later turn's snapshot was skipped), so a
   * difference may be the session's own.
   */
  async function compareToLatest(sid: string, cwd: string, files: string[], budgetMs?: number): Promise<TurnSnapshotCompareResult> {
    await ready()
    var deadline = now() + (budgetMs ?? 8000)
    var result: TurnSnapshotCompareResult = { repoRoot: null, snapshotN: null, snapshotAt: null, snapshotStale: false, files: [] }
    var list = (files || []).filter((f) => typeof f === 'string' && f.length > 0 && f.length < 4096).slice(0, 500)
    if (!list.length || !cwd) return result
    var p = deps.path
    var repo = validSid(sid) ? await resolveRepo(cwd, deadline).catch(() => null) : null
    var latest: TurnSnapshotEntry | null = null
    if (repo) {
      result.repoRoot = repo.root
      var refs = await listRefs(repo.root, sid, deadline).catch(() => [] as TurnSnapshotEntry[])
      for (var i = refs.length - 1; i >= 0; i--) {
        if (refs[i].kind !== 'pre-restore') { latest = refs[i]; break }
      }
      if (latest) {
        result.snapshotN = latest.n
        result.snapshotAt = latest.at
        var endAt = lastTurnEnd.get(sid)
        var seenAt = Math.max(latest.at, confirmedAt.get(sid) ?? 0)
        result.snapshotStale = typeof endAt === 'number' && endAt > seenAt + 1000
      }
    }
    var out: TurnSnapshotCompareFile[] = []
    for (var k = 0; k < list.length; k++) {
      var abs = list[k]
      var rel: string | null = null
      if (repo && p) {
        rel = relInRepo(repo.root, abs)
        if (rel === null && deps.fs && deps.fs.realpath) {
          // The same file through another spelling of its directory.
          var real: string | null = null
          try { real = await deps.fs.realpath(abs) } catch {
            try { real = p.join(await deps.fs.realpath(p.dirname(abs)), abs.slice(abs.lastIndexOf('/') + 1)) } catch { real = null }
          }
          if (real) rel = relInRepo(repo.root, real)
        }
      }
      var text: string | null = null
      var ex = false
      var regular = false
      if (deps.fs) {
        try {
          var st = await deps.fs.lstat(abs)
          ex = true
          regular = st.isFile()
          if (regular && st.size <= MAX_BLOB_BYTES) {
            var dc = decodeContent(await deps.fs.readFile(abs))
            text = dc.binary ? null : dc.text
          }
        } catch { ex = false }
      }
      out.push({ path: abs, rel: rel, exists: ex, regular: regular, text: text, snapshot: 'unknown' })
    }
    if (repo && latest) {
      var inRepoFiles = out.filter((f) => f.rel !== null)
      var inSnap = new Map<string, string>()
      if (inRepoFiles.length) {
        var lt = await git(['--literal-pathspecs', 'ls-tree', '-r', '-z', latest.sha, '--'].concat(inRepoFiles.map((f) => f.rel as string)), { cwd: repo.root, deadline: deadline }).catch(() => null)
        if (lt && lt.code === 0) {
          for (var rec of lt.stdout.split('\u0000')) {
            var m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec)
            if (m) inSnap.set(m[4], m[3])
          }
        }
        // Hashed the way `git add` stored them (clean filters by path).
        var hashable = inRepoFiles.filter((f) => f.exists && f.regular)
        var hashes = new Map<string, string>()
        if (hashable.length) {
          var ho = await git(['hash-object', '--'].concat(hashable.map((f) => f.rel as string)), { cwd: repo.root, deadline: deadline }).catch(() => null)
          if (ho && ho.code === 0) {
            var hl = ho.stdout.split('\n').filter((l) => l.trim())
            for (var h = 0; h < hashable.length && h < hl.length; h++) hashes.set(hashable[h].rel as string, hl[h].trim())
          }
        }
        for (var q = 0; q < inRepoFiles.length; q++) {
          var f = inRepoFiles[q]
          var snapSha = inSnap.get(f.rel as string)
          if (!f.exists) f.snapshot = snapSha ? 'differs' : 'same'
          else if (!snapSha) f.snapshot = 'differs'
          else if (hashes.has(f.rel as string)) f.snapshot = hashes.get(f.rel as string) === snapSha ? 'same' : 'differs'
        }
      }
    }
    result.files = out
    return result
  }

  function relInRepo(root: string, abs: string): string | null {
    var p = deps.path
    if (!p) return null
    var rr = p.relative(root, abs).split(p.sep).join('/')
    return rr && rr !== '..' && rr.indexOf('../') !== 0 && !p.isAbsolute(rr) && validRel(rr) ? rr : null
  }

  /** The repository root of `cwd`, or null. */
  async function repoRootOf(cwd: string): Promise<string | null> {
    if (!cwd) return null
    var repo = await resolveRepo(cwd, now() + 5000).catch(() => null)
    return repo ? repo.root : null
  }

  function getSettings(): { enabled: boolean; keep: number } {
    return { enabled: settings.enabled, keep: settings.keep }
  }

  return {
    ready, configure, settings: getSettings,
    onTurnStart, onTurnEnd, snapshot, list, fileDiff, restore, compareToLatest, repoRootOf,
    // pure parts, for the tests and the source twin's smoke check
    parseRefRecords, parseNameStatusZ, parseNumstatZ, validRel, validSid,
    redirectVars: () => REDIRECT_VARS.slice(),
  }
}

export type TurnSnapshots = ReturnType<typeof createTurnSnapshots>

// Pure methods for the server and the tests, from a factory with no deps.
var pure = createTurnSnapshots({})
export const parseTurnRefRecords = pure.parseRefRecords
export const parseNameStatusZ = pure.parseNameStatusZ
export const parseNumstatZ = pure.parseNumstatZ
export const isValidSnapshotRelPath = pure.validRel
export const TURN_SNAPSHOT_REDIRECT_VARS = pure.redirectVars()
