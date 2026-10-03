/**
 * Task workspaces, host side: the daemon creates, probes and removes a task's
 * isolated working copy on the host that owns the files ('workspace-v1').
 *
 * Two kinds of provider run here:
 *  - `git-worktree`, built in: a git worktree on a new branch `walnut/<slug>`,
 *    under a Walnut-owned folder on the host (`~/.open-walnut-worktrees/<repo>/<slug>`,
 *    never inside the repository), branched from the source checkout's HEAD or a
 *    named base ref.
 *  - plugin providers: the server pushes an allowlist (`workspace.configure`,
 *    sourced only from local plugin manifests on the Mac). Each entry is an argv the
 *    daemon runs with NO shell, a JSON request on stdin, a JSON reply on stdout
 *    (docs/reference/workspace-providers.md). A provider may ship one adapter
 *    script with the push; it is materialized under the daemon's state dir.
 *
 * Safety rules every operation shares:
 *  - home, `/`, system folders and mount roots are never a repository, a
 *    workspace root or a removal target (checked on the literal path AND the
 *    realpath);
 *  - a created root must be inside an allowed region (the worktrees folder for
 *    git, the user's home or a provider-declared root for plugins), must not hold
 *    the folder it was created from, and a workspace is never created from inside
 *    another one;
 *  - a failed git creation removes what it made (the folder and a branch it
 *    created that still points at the base);
 *  - removal fails closed: every repository is probed first (for a plugin, the
 *    recorded ones plus what listRepos answers now, and a bounded scan of the root
 *    for repositories nobody listed), and ANY dirty, stashed, unreadable or unlisted
 *    one, a detached HEAD no ref holds, or (plugin) a local branch commit no remote
 *    holds, keeps the whole workspace; a branch is deleted only when it is a
 *    `walnut/` branch no worktree has checked out and its commits are reachable
 *    from another ref; git's own refusal (no --force) is the second layer.
 *  - every git spawn gets a clean environment: an inherited GIT_DIR /
 *    GIT_WORK_TREE / GIT_INDEX_FILE would point git at another repository.
 *
 * How each twin gets it: daemon-standalone.ts imports createWorkspaceCore;
 * daemon-source.ts inlines `createWorkspaceCore.toString()` through
 * `__CREATE_WORKSPACE_CORE__`. So the factory body references NOTHING at module
 * scope: every helper lives inside it and every capability comes from `deps`.
 */

/** What the daemon needs from its host process (node or bun). */
/** One entry of `git worktree list --porcelain` (types are erased, so the injected body stays self-contained). */
export interface WorktreeEntry { path: string; branch?: string }

export interface WorkspaceCoreDeps {
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => WorkspaceChild
  fs: {
    promises: {
      stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
      lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>
      realpath(p: string): Promise<string>
      mkdir(p: string, opts?: { recursive?: boolean; mode?: number }): Promise<unknown>
      rmdir(p: string): Promise<void>
      rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
      readdir(p: string): Promise<string[]>
      readdir(p: string, opts: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>
      writeFile(p: string, data: string, opts?: { mode?: number }): Promise<void>
      rename(a: string, b: string): Promise<void>
      chmod(p: string, mode: number): Promise<void>
    }
  }
  path: {
    resolve(...p: string[]): string
    join(...p: string[]): string
    dirname(p: string): string
    basename(p: string, ext?: string): string
    extname(p: string): string
    relative(from: string, to: string): string
    isAbsolute(p: string): boolean
    sep: string
  }
  homedir: () => string
  env: Record<string, string | undefined>
  /** Where provider adapter scripts are materialized (the daemon's state dir). */
  stateDir: string
  /** Override for the git worktrees folder (tests; config). Default `~/.open-walnut-worktrees`. */
  worktreesRoot?: string
  now?: () => number
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
  /** Signal a provider's whole process group (the twins own the signal call). */
  killGroup?: (pid: number, signal: string) => void
  randomId?: () => string
}

/** The slice of ChildProcess the core uses. */
export interface WorkspaceChild {
  pid?: number
  stdout?: { on(ev: 'data', cb: (b: Buffer) => void): unknown; destroy?(): unknown } | null
  stderr?: { on(ev: 'data', cb: (b: Buffer) => void): unknown; destroy?(): unknown } | null
  stdin?: { on(ev: 'error', cb: () => void): unknown; end(data?: string): unknown } | null
  on(ev: 'error', cb: (err: Error & { code?: string }) => void): unknown
  on(ev: 'exit' | 'close', cb: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: string): unknown
}

/** One plugin provider as the server pushes it. */
export interface WorkspaceProviderSpec {
  id: string
  displayName: string
  priority: number
  /** File names whose presence in the anchor or an ancestor claims the folder. */
  markers?: string[]
  /** argv, no shell. `{script}` is replaced by the materialized adapter's path, a leading `~/` by home. */
  command: string[]
  /** Optional single-file adapter shipped with the push. */
  script?: { name: string; content: string }
  /** Extra regions (absolute or `~/…`) a created root may live in, besides home. */
  roots?: string[]
  timeouts?: { createSec?: number; removeSec?: number; otherSec?: number }
  /** Operations it implements; absent = all five. */
  operations?: string[]
  /** JSON-schema-ish description of the inputs (only the server reads it). */
  inputSchema?: unknown
}

export interface WorkspaceConfig { version: 1; hash: string; providers: WorkspaceProviderSpec[] }

export interface WorkspaceRepo { path: string; name?: string; branch?: string }

export interface WorkspaceCreateResult {
  provider: string
  root: string
  cwd: string
  branch?: string
  baseRef?: { name?: string; sha?: string }
  sourceRepo?: string
  repos: WorkspaceRepo[]
  /** A retry found the worktree this task already had and kept it. */
  adopted?: boolean
}

export interface WorkspaceRepoProbe {
  path: string
  name?: string
  exists: boolean
  dirty: boolean
  changes: number
  unreadable: boolean
  error?: string
  branch?: string
  /** true: every commit is reachable from another ref (or there are none); null: not known. */
  merged: boolean | null
  /** Plugin repositories: commits on local branches that no remote-tracking ref holds. */
  unpushed?: number
  /** Plugin repositories: `refs/stash` exists (a removal would lose it). */
  stashed?: boolean
  /** HEAD is detached on a commit no branch, remote or tag holds. */
  lostHead?: boolean
  /** Ignored entries git shows (first few) and their count: a removal deletes them too. */
  ignored?: string[]
  ignoredCount?: number
}

export interface WorkspaceProbe {
  root: string
  rootExists: boolean
  repos: WorkspaceRepoProbe[]
  clean: boolean
  merged: boolean
  problems: string[]
  branch?: string
  branchTip?: string
  branchMerged?: boolean | null
  /** Repositories found under the root that the provider never listed. */
  unlisted?: string[]
}

export interface WorkspaceJob {
  id: string
  kind: 'create' | 'remove'
  provider: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  progress?: string
  result?: Record<string, unknown>
  error?: string
  code?: string
}

export type WorkspaceReply = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string; code?: string; [k: string]: unknown }

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createWorkspaceCore(deps: WorkspaceCoreDeps) {
  var GIT_ID = 'git-worktree'
  var PROTOCOL = 1
  var fsp = deps.fs.promises
  var P = deps.path
  var now = deps.now ?? (() => Date.now())
  var logMsg = deps.log ?? (() => {})
  var CREATE_DEFAULT_S = 180
  var OTHER_DEFAULT_S = 30
  var MAX_TIMEOUT_S = 1800
  var STDOUT_CAP = 1024 * 1024
  var STDERR_TAIL = 8192
  var LINE_CAP = 4096
  var EXIT_GRACE_MS = 1500
  /** The scan for repositories nobody listed: how deep below the root, and how many folders at most. */
  var SCAN_DEPTH = 3
  var SCAN_MAX_DIRS = 4000
  var GIT_TIMEOUT_MS = 60_000
  var JOB_TTL_MS = 60 * 60 * 1000
  var MAX_JOBS = 200
  var MAX_RUNNING = 4
  var REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']

  var config: WorkspaceConfig | null = null
  var scriptPaths = new Map<string, string>()
  var jobs = new Map<string, WorkspaceJob>()
  /** provider|target keys a running job owns: a second create of the same place waits its turn. */
  var busy = new Set<string>()

  // ── small helpers ──

  function fail(error: string, code?: string, extra?: Record<string, unknown>): WorkspaceReply {
    return Object.assign({ ok: false as const, error: error }, code ? { code: code } : {}, extra || {})
  }
  function errText(err: unknown): string {
    return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
  }
  function home(): string {
    return P.resolve(deps.homedir())
  }
  function expandHome(p: string): string {
    if (p === '~') return home()
    if (p.indexOf('~/') === 0) return P.join(home(), p.slice(2))
    return p
  }
  function isInside(child: string, parent: string): boolean {
    if (child === parent) return true
    var base = parent.endsWith(P.sep) ? parent : parent + P.sep
    return child.indexOf(base) === 0
  }
  function isAbsPathString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0 && v.length <= 4096 && v.indexOf('\0') < 0 && P.isAbsolute(expandHome(v))
  }
  async function exists(p: string): Promise<boolean> {
    try { await fsp.lstat(p); return true } catch { return false }
  }
  async function isDir(p: string): Promise<boolean> {
    try { return (await fsp.stat(p)).isDirectory() } catch { return false }
  }
  /** realpath of the deepest existing ancestor, with the missing tail re-attached. */
  async function realish(p: string): Promise<string> {
    var abs = P.resolve(p)
    var tail: string[] = []
    var cur = abs
    for (var i = 0; i < 64; i++) {
      try {
        var real = await fsp.realpath(cur)
        return tail.length ? P.join.apply(null, [real].concat(tail.reverse())) : real
      } catch {
        var parent = P.dirname(cur)
        if (parent === cur) return abs
        tail.push(P.basename(cur))
        cur = parent
      }
    }
    return abs
  }

  /** Never a repository, a workspace root or a removal target. Literal path only; see checkForbidden. */
  function forbiddenReason(p: string): string | null {
    var abs = P.resolve(p)
    var h = home()
    if (abs === '/') return 'the filesystem root'
    if (abs === h) return 'the home folder'
    var exact = ['/Users', '/home', '/root', '/tmp', '/private', '/private/tmp', '/var', '/private/var', '/var/tmp',
      '/var/folders', '/private/var/folders', '/usr', '/usr/local', '/opt', '/opt/homebrew', '/Applications',
      '/Volumes', '/mnt', '/media', '/srv', '/snap', '/nix', '/run', '/cores', '/Network']
    if (exact.indexOf(abs) >= 0) return 'a system folder (' + abs + ')'
    var subtree = ['/System', '/Library', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec',
      '/usr/share', '/usr/include', '/etc', '/private/etc', '/dev', '/proc', '/sys', '/boot', '/lib', '/lib64']
    for (var i = 0; i < subtree.length; i++) {
      if (isInside(abs, subtree[i])) return 'a system folder (' + subtree[i] + ')'
    }
    var secrets = ['.ssh', '.gnupg', '.aws']
    for (var j = 0; j < secrets.length; j++) {
      if (isInside(abs, P.join(h, secrets[j]))) return 'a credentials folder (~/' + secrets[j] + ')'
    }
    var parts = abs.split('/').filter(Boolean)
    if ((parts[0] === 'Volumes' || parts[0] === 'mnt') && parts.length === 2) return 'a mount root (' + abs + ')'
    if (parts[0] === 'media' && parts.length <= 3) return 'a mount root (' + abs + ')'
    if (parts[0] === 'run' && parts[1] === 'media' && parts.length <= 4) return 'a mount root (' + abs + ')'
    return null
  }
  /** The literal path AND its realpath (a symlink must not launder `/` into a workspace). */
  async function checkForbidden(p: string, what: string): Promise<string | null> {
    var lit = forbiddenReason(p)
    if (lit) return what + ' ' + p + ' is ' + lit
    var real = await realish(p)
    var viaReal = forbiddenReason(real)
    if (viaReal) return what + ' ' + p + ' resolves to ' + real + ', which is ' + viaReal
    return null
  }

  function slugify(name: unknown): string {
    var s = String(name ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')
    s = s.replace(/^[-.]+/, '').replace(/[-.]+$/, '')
    if (s.length > 64) s = s.slice(0, 64).replace(/[-.]+$/, '')
    return s || 'task'
  }
  function validRef(v: unknown): v is string {
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(v) && v.indexOf('..') < 0 && !v.endsWith('/') && !v.endsWith('.lock')
  }

  /** The host env minus every var that redirects which repository git touches. */
  function cleanEnv(extra?: Record<string, string>): Record<string, string | undefined> {
    var env: Record<string, string | undefined> = Object.assign({}, deps.env)
    for (var i = 0; i < REDIRECT_VARS.length; i++) delete env[REDIRECT_VARS[i]]
    env.GIT_TERMINAL_PROMPT = '0'
    return Object.assign(env, extra || {})
  }

  /** Spawn and collect: one shape for git and for providers. */
  function run(cmd: string, args: string[], opts: {
    cwd?: string; input?: string; timeoutMs: number; env?: Record<string, string | undefined>;
    group?: boolean; onStderrLine?: (line: string) => void; stdoutCap?: number
  }): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; overflow: boolean; spawnError?: string }> {
    return new Promise((resolve) => {
      var out: Buffer[] = []
      var outBytes = 0
      var errText2 = ''
      var settled = false
      var timedOut = false
      var overflow = false
      var cap = opts.stdoutCap ?? STDOUT_CAP
      var child: WorkspaceChild
      var killTimer: ReturnType<typeof setTimeout> | null = null
      var settleTimer: ReturnType<typeof setTimeout> | null = null
      var exitTimer: ReturnType<typeof setTimeout> | null = null
      function finish(code: number | null, signal: string | null, spawnError?: string) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (settleTimer) clearTimeout(settleTimer)
        if (exitTimer) clearTimeout(exitTimer)
        resolve({
          code: code, signal: signal, stdout: Buffer.concat(out).toString('utf8'),
          stderr: errText2.slice(-STDERR_TAIL), timedOut: timedOut, overflow: overflow,
          ...(spawnError ? { spawnError: spawnError } : {}),
        })
      }
      try {
        child = deps.spawn(cmd, args, {
          cwd: opts.cwd, env: opts.env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'],
          detached: opts.group === true,
        })
      } catch (err) {
        resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, overflow: false, spawnError: errText(err) })
        return
      }
      function stop(signal: string) {
        var pid = child.pid
        if (opts.group && deps.killGroup && typeof pid === 'number' && pid > 1) {
          try { deps.killGroup(pid, signal); return } catch { /* fall through to the child itself */ }
        }
        try { child.kill(signal) } catch { /* already gone */ }
      }
      var timer = setTimeout(() => {
        timedOut = true
        stop('SIGTERM')
        killTimer = setTimeout(() => stop('SIGKILL'), 3000)
        settleTimer = setTimeout(() => finish(null, 'SIGKILL'), 6000)
      }, opts.timeoutMs)
      child.on('error', (err) => finish(null, null, err && err.code === 'ENOENT' ? 'command not found: ' + cmd : errText(err)))
      if (child.stdout) child.stdout.on('data', (b: Buffer) => {
        if (overflow) return
        outBytes += b.length
        if (outBytes > cap) { overflow = true; stop('SIGKILL'); return }
        out.push(b)
      })
      var lineBuf = ''
      if (child.stderr) child.stderr.on('data', (b: Buffer) => {
        var s = b.toString('utf8')
        errText2 = (errText2 + s).slice(-STDERR_TAIL * 2)
        if (opts.onStderrLine) {
          lineBuf += s
          var lines = lineBuf.split(/\r?\n|\r/)
          lineBuf = lines.pop() || ''
          // A line that never ends (a progress bar without newlines) must not grow forever.
          if (lineBuf.length > LINE_CAP) { lines.push(lineBuf.slice(-LINE_CAP)); lineBuf = '' }
          for (var i = 0; i < lines.length; i++) {
            var t = lines[i].trim()
            if (t) opts.onStderrLine(t)
          }
        }
      })
      // 'close' waits for every holder of the pipes: a grandchild that kept stdout
      // open would pin the run until its timeout. The child's own exit, plus a
      // short grace for the reply still in the pipe, settles it.
      child.on('exit', (code, signal) => {
        if (settled || exitTimer) return
        exitTimer = setTimeout(() => {
          try { if (child.stdout && child.stdout.destroy) child.stdout.destroy() } catch { /* gone */ }
          try { if (child.stderr && child.stderr.destroy) child.stderr.destroy() } catch { /* gone */ }
          finish(code, signal)
        }, EXIT_GRACE_MS)
      })
      child.on('close', (code, signal) => finish(code, signal))
      if (child.stdin) {
        child.stdin.on('error', () => { /* closed early: harmless */ })
        child.stdin.end(opts.input ?? '')
      }
    })
  }

  async function git(args: string[], cwd?: string, timeoutMs?: number) {
    var r = await run('git', args, { cwd: cwd, timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS, env: cleanEnv({ LC_ALL: 'C' }) })
    return {
      ok: r.code === 0 && !r.spawnError && !r.timedOut,
      code: r.code,
      out: r.stdout.trim(),
      err: (r.spawnError || (r.timedOut ? 'git timed out' : '') || r.stderr).trim(),
    }
  }
  function gitErr(r: { err: string; code: number | null }): string {
    var line = r.err.split('\n').filter(Boolean).slice(-2).join(' ')
    return line || ('git exited ' + r.code)
  }

  function worktreesRoot(): string {
    var raw = deps.worktreesRoot || deps.env.WALNUT_WORKTREES_ROOT || P.join(home(), '.open-walnut-worktrees')
    return P.resolve(expandHome(raw))
  }

  // ── jobs ──

  function pruneJobs() {
    var t = now()
    jobs.forEach((j, id) => { if (j.state !== 'running' && j.endedAt && t - j.endedAt > JOB_TTL_MS) jobs.delete(id) })
    if (jobs.size > MAX_JOBS) {
      var done = Array.from(jobs.values()).filter((j) => j.state !== 'running').sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
      for (var i = 0; i < done.length && jobs.size > MAX_JOBS; i++) jobs.delete(done[i].id)
    }
  }
  function runningCount(): number {
    var n = 0
    jobs.forEach((j) => { if (j.state === 'running') n++ })
    return n
  }
  function startJob(id: string, kind: 'create' | 'remove', provider: string, busyKey: string,
    work: (job: WorkspaceJob) => Promise<Record<string, unknown>>): WorkspaceReply {
    pruneJobs()
    var existing = jobs.get(id)
    if (existing) return { ok: true, jobId: id, state: existing.state, existing: true }
    if (busy.has(busyKey)) return fail('another workspace operation is running for this place', 'busy')
    if (runningCount() >= MAX_RUNNING) return fail('too many workspace operations are running on this host', 'busy')
    var job: WorkspaceJob = { id: id, kind: kind, provider: provider, state: 'running', startedAt: now() }
    jobs.set(id, job)
    busy.add(busyKey)
    logMsg('info', 'workspace job started', { jobId: id, kind: kind, provider: provider })
    Promise.resolve().then(() => work(job)).then((result) => {
      job.state = 'done'
      job.result = result
    }, (err) => {
      job.state = 'failed'
      job.error = errText(err)
      if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') job.code = (err as { code: string }).code
      if (err && typeof err === 'object' && 'detail' in err) job.result = (err as { detail: Record<string, unknown> }).detail
    }).then(() => {
      job.endedAt = now()
      busy.delete(busyKey)
      logMsg(job.state === 'done' ? 'info' : 'warn', 'workspace job ended', {
        jobId: id, kind: kind, provider: provider, state: job.state, ms: (job.endedAt || 0) - job.startedAt, error: job.error,
      })
    })
    return { ok: true, jobId: id, state: 'running' }
  }
  function coded(message: string, code: string, detail?: Record<string, unknown>): Error {
    var e = new Error(message) as Error & { code?: string; detail?: Record<string, unknown> }
    e.code = code
    if (detail) e.detail = detail
    return e
  }

  // ── provider allowlist ──

  function validateSpec(raw: unknown): WorkspaceProviderSpec | string {
    if (!raw || typeof raw !== 'object') return 'provider is not an object'
    var s = raw as Record<string, unknown>
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s.id) || s.id === GIT_ID) return 'invalid provider id'
    if (!Array.isArray(s.command) || s.command.length === 0 || s.command.length > 32
      || s.command.some((t) => typeof t !== 'string' || !t || t.length > 4096 || t.indexOf('\0') >= 0)) {
      return 'provider ' + s.id + ': command must be a non-empty argv of strings'
    }
    var markers = Array.isArray(s.markers) ? s.markers.filter((m): m is string => typeof m === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(m) && m !== '..' && m !== '.').slice(0, 16) : undefined
    var roots = Array.isArray(s.roots) ? s.roots.filter((r): r is string => isAbsPathString(r)).slice(0, 16) : undefined
    var script: WorkspaceProviderSpec['script']
    if (s.script !== undefined) {
      var sc = s.script as Record<string, unknown>
      if (!sc || typeof sc.content !== 'string' || sc.content.length > 512 * 1024 || typeof sc.name !== 'string') return 'provider ' + s.id + ': invalid script'
      script = { name: String(sc.name), content: sc.content }
    }
    var ops = Array.isArray(s.operations) ? s.operations.filter((o): o is string => typeof o === 'string') : undefined
    var t = (s.timeouts && typeof s.timeouts === 'object') ? s.timeouts as Record<string, unknown> : {}
    var num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(MAX_TIMEOUT_S, Math.floor(v)) : undefined)
    return {
      id: s.id,
      displayName: typeof s.displayName === 'string' && s.displayName ? s.displayName.slice(0, 80) : s.id,
      priority: typeof s.priority === 'number' && Number.isFinite(s.priority) ? s.priority : 50,
      command: (s.command as string[]).slice(),
      ...(markers && markers.length ? { markers: markers } : {}),
      ...(roots && roots.length ? { roots: roots } : {}),
      ...(script ? { script: script } : {}),
      ...(ops ? { operations: ops } : {}),
      timeouts: { createSec: num(t.createSec), removeSec: num(t.removeSec), otherSec: num(t.otherSec) },
    }
  }

  /** Write a provider's adapter into the state dir (atomically) and answer its path. */
  async function writeAdapter(spec: WorkspaceProviderSpec): Promise<string> {
    var dir = P.join(deps.stateDir, 'workspace-providers')
    var ext = P.extname(spec.script!.name).replace(/[^A-Za-z0-9.]/g, '').slice(0, 8)
    var file = P.join(dir, spec.id + ext)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    var tmp = file + '.tmp-' + now()
    await fsp.writeFile(tmp, spec.script!.content, { mode: 0o700 })
    await fsp.rename(tmp, file)
    await fsp.chmod(file, 0o700)
    return file
  }

  async function configure(raw: unknown): Promise<WorkspaceReply> {
    var c = raw as Record<string, unknown> | null
    if (!c || c.version !== 1 || typeof c.hash !== 'string' || !Array.isArray(c.providers) || c.providers.length > 32) {
      return fail('workspace.configure: invalid config')
    }
    if (config && config.hash === c.hash) return { ok: true, applied: true, changed: false, hash: c.hash }
    var specs: WorkspaceProviderSpec[] = []
    for (var i = 0; i < c.providers.length; i++) {
      var v = validateSpec(c.providers[i])
      if (typeof v === 'string') return fail('workspace.configure: ' + v)
      specs.push(v)
    }
    var paths = new Map<string, string>()
    for (var k = 0; k < specs.length; k++) {
      if (!specs[k].script) continue
      try {
        paths.set(specs[k].id, await writeAdapter(specs[k]))
      } catch (err) {
        return fail('workspace.configure: could not write the ' + specs[k].id + ' adapter: ' + errText(err))
      }
    }
    config = { version: 1, hash: c.hash, providers: specs }
    scriptPaths = paths
    logMsg('info', 'workspace providers configured', { hash: c.hash, providers: specs.map((s) => s.id) })
    return { ok: true, applied: true, changed: true, hash: c.hash }
  }

  /** A plugin provider by id, or a stale-allowlist answer the server re-pushes on. */
  function pluginSpec(id: unknown, hash: unknown): WorkspaceProviderSpec | WorkspaceReply {
    if (!config || typeof hash !== 'string' || hash !== config.hash) {
      return fail('workspace providers are not configured on this host yet', 'providers_stale')
    }
    var spec = config.providers.find((s) => s.id === id)
    if (!spec) return fail('unknown workspace provider: ' + String(id), 'unknown_provider')
    return spec
  }
  function isReply(v: unknown): v is WorkspaceReply {
    return !!v && typeof v === 'object' && 'ok' in v
  }

  // ── the plugin protocol ──

  function parseReply(stdout: string): { ok: boolean; result?: Record<string, unknown>; error?: string; code?: string } | null {
    var text = String(stdout || '').trim()
    if (!text) return null
    var candidates = [text]
    var lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > 1) candidates.push(lines[lines.length - 1])
    for (var i = 0; i < candidates.length; i++) {
      try {
        var v = JSON.parse(candidates[i])
        if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean') continue
        if (v.version !== undefined && v.version !== PROTOCOL) return { ok: false, error: 'provider spoke protocol version ' + String(v.version) + ', expected ' + PROTOCOL }
        return {
          ok: v.ok,
          ...(v.result && typeof v.result === 'object' ? { result: v.result } : {}),
          ...(typeof v.error === 'string' ? { error: v.error.slice(0, 2000) } : {}),
          ...(typeof v.code === 'string' ? { code: v.code.slice(0, 64) } : {}),
        }
      } catch { /* try the next shape */ }
    }
    return null
  }

  function opTimeoutMs(spec: WorkspaceProviderSpec, op: string): number {
    var t = spec.timeouts || {}
    var s = op === 'create' ? (t.createSec ?? CREATE_DEFAULT_S)
      : op === 'remove' ? (t.removeSec ?? CREATE_DEFAULT_S)
        : (t.otherSec ?? OTHER_DEFAULT_S)
    return Math.min(MAX_TIMEOUT_S, Math.max(1, s)) * 1000
  }

  async function runProvider(spec: WorkspaceProviderSpec, op: string, args: Record<string, unknown>,
    onProgress?: (line: string) => void, timeoutOverrideMs?: number): Promise<Record<string, unknown>> {
    if (spec.operations && spec.operations.indexOf(op) < 0) throw coded(spec.displayName + ' does not implement ' + op, 'unsupported')
    var script = scriptPaths.get(spec.id)
    // A daemon's state dir may sit under /tmp, which a janitor sweeps while the
    // allowlist stays hash-skipped: write the adapter again from memory when it is gone.
    if (spec.script && (!script || !(await exists(script)))) {
      try {
        script = await writeAdapter(spec)
        scriptPaths.set(spec.id, script)
      } catch (err) {
        throw coded(spec.displayName + ': could not write its adapter: ' + errText(err), 'bad_provider')
      }
    }
    var argv = spec.command.map((t) => (t === '{script}' ? (script || t) : expandHome(t)))
    if (argv.indexOf('{script}') >= 0) throw coded(spec.displayName + ': its command names {script} but no script was pushed', 'bad_provider')
    var cwdCandidates = [args.root, args.anchor].filter((v): v is string => typeof v === 'string')
    var cwd = home()
    for (var i = 0; i < cwdCandidates.length; i++) {
      if (await isDir(cwdCandidates[i])) { cwd = cwdCandidates[i]; break }
    }
    var timeoutMs = timeoutOverrideMs ?? opTimeoutMs(spec, op)
    var r = await run(argv[0], argv.slice(1), {
      cwd: cwd,
      input: JSON.stringify({ version: PROTOCOL, operation: op, arguments: args }) + '\n',
      timeoutMs: timeoutMs,
      env: cleanEnv({ WALNUT_WORKSPACE_PROVIDER: spec.id, WALNUT_WORKSPACE_OPERATION: op, WALNUT_WORKSPACE_PROTOCOL: String(PROTOCOL) }),
      group: true,
      onStderrLine: onProgress ? (line) => onProgress(line.slice(0, 240)) : undefined,
    })
    var tail = r.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600)
    if (r.spawnError) throw coded(spec.displayName + ' could not start: ' + r.spawnError, 'spawn_failed')
    if (r.timedOut) throw coded(spec.displayName + ' ' + op + ' timed out after ' + Math.round(timeoutMs / 1000) + 's' + (tail ? ': ' + tail : ''), 'timeout')
    if (r.overflow) throw coded(spec.displayName + ' ' + op + ' replied with more than 1 MB', 'bad_reply')
    var reply = parseReply(r.stdout)
    if (!reply) {
      var head = r.stdout.trim().slice(0, 200)
      throw coded(spec.displayName + ' ' + op + ' did not reply with JSON'
        + (r.code ? ' (exit ' + r.code + ')' : '') + (head ? ': ' + head : '') + (tail ? ' | ' + tail : ''), 'bad_reply')
    }
    if (!reply.ok) throw coded(reply.error || (spec.displayName + ' ' + op + ' failed' + (tail ? ': ' + tail : '')), reply.code || 'provider_error')
    return reply.result || {}
  }

  async function findMarker(anchor: string, markers: string[]): Promise<string | null> {
    var cur = P.resolve(anchor)
    var h = home()
    for (var i = 0; i < 16; i++) {
      if (cur === h || forbiddenReason(cur)) return null
      for (var j = 0; j < markers.length; j++) {
        if (await exists(P.join(cur, markers[j]))) return cur
      }
      var parent = P.dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
    return null
  }

  /** The regions a plugin provider's root may live in. */
  async function pluginRegions(spec: WorkspaceProviderSpec): Promise<string[]> {
    var out = [await realish(home())]
    var roots = spec.roots || []
    for (var i = 0; i < roots.length; i++) {
      var r = P.resolve(expandHome(roots[i]))
      if (!forbiddenReason(r)) out.push(await realish(r))
    }
    return out
  }
  /** A created root must be absolute, allowed, not forbidden, and never hold the place it was made from. */
  async function checkCreatedRoot(root: unknown, regions: string[], anchor: string, strictlyInside: boolean): Promise<string | null> {
    if (!isAbsPathString(root) || root.indexOf('~') === 0) return 'the provider returned a root that is not an absolute path'
    var norm = P.resolve(root)
    if (norm !== root && norm + '/' !== root) return 'the provider returned a root that is not normalized: ' + root
    var forb = await checkForbidden(root, 'workspace root')
    if (forb) return forb
    var real = await realish(root)
    var inRegion = regions.some((reg) => isInside(real, reg) && (!strictlyInside || real !== reg))
    if (!inRegion) return 'workspace root ' + root + ' is outside the folders a workspace may live in (' + regions.join(', ') + ')'
    var anchorReal = await realish(anchor)
    if (isInside(anchorReal, real)) return 'workspace root ' + root + ' contains the folder it was created from'
    return null
  }

  // ── git-worktree ──

  async function gitToplevel(dir: string): Promise<{ top: string; mainTop: string } | string> {
    var top = await git(['rev-parse', '--show-toplevel'], dir)
    if (!top.ok || !top.out) return 'not a git repository: ' + dir
    var common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)
    var commonDir = common.ok ? common.out : ''
    if (!commonDir) {
      var rel = await git(['rev-parse', '--git-common-dir'], dir)
      commonDir = rel.ok ? P.resolve(dir, rel.out) : ''
    }
    var mainTop = commonDir && P.basename(commonDir) === '.git' ? P.dirname(commonDir) : top.out
    return { top: top.out, mainTop: mainTop }
  }

  async function gitDetect(anchor: string): Promise<Record<string, unknown>> {
    var base = { provider: GIT_ID, displayName: 'Git worktree', priority: 10, builtin: true }
    if (!(await isDir(anchor))) return Object.assign(base, { claimed: false, reason: 'the folder does not exist on this host' })
    var forbAnchor = await checkForbidden(anchor, 'folder')
    if (forbAnchor) return Object.assign(base, { claimed: false, reason: forbAnchor })
    var tl = await gitToplevel(anchor)
    if (typeof tl === 'string') return Object.assign(base, { claimed: false, reason: 'not a git repository' })
    var forb = (await checkForbidden(tl.top, 'repository')) || (await checkForbidden(tl.mainTop, 'repository'))
    if (forb) return Object.assign(base, { claimed: false, reason: forb })
    var wt = worktreesRoot()
    if (isInside(await realish(anchor), await realish(wt))) {
      return Object.assign(base, { claimed: false, reason: 'already inside a Walnut workspace' })
    }
    var head = await git(['rev-parse', '--verify', '-q', 'HEAD'], anchor)
    if (!head.ok) return Object.assign(base, { claimed: false, reason: 'the repository has no commits yet' })
    var branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], anchor)
    return Object.assign(base, {
      claimed: true, root: tl.mainTop, repoName: slugify(P.basename(tl.mainTop)),
      ...(branch.ok && branch.out ? { branch: branch.out } : {}), head: head.out,
      worktreesRoot: wt,
    })
  }

  function parseWorktreeList(text: string): WorktreeEntry[] {
    var out: WorktreeEntry[] = []
    var cur: WorktreeEntry | null = null
    var lines = text.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i]
      if (l.indexOf('worktree ') === 0) { cur = { path: l.slice(9) }; out.push(cur) } else if (cur && l.indexOf('branch ') === 0) cur.branch = l.slice(7)
    }
    return out
  }

  async function gitCreate(args: Record<string, unknown>, job: WorkspaceJob): Promise<Record<string, unknown>> {
    var anchor = P.resolve(expandHome(String(args.anchor)))
    job.progress = 'Reading the repository'
    if (!(await isDir(anchor))) throw coded('the folder ' + anchor + ' does not exist on this host', 'bad_anchor')
    // A forbidden folder is refused before git ever runs in it.
    var forbAnchor = await checkForbidden(anchor, 'folder')
    if (forbAnchor) throw coded(forbAnchor, 'forbidden_path')
    var tl = await gitToplevel(anchor)
    if (typeof tl === 'string') throw coded(tl, 'not_git')
    var forb = (await checkForbidden(tl.top, 'repository')) || (await checkForbidden(tl.mainTop, 'repository'))
    if (forb) throw coded(forb, 'forbidden_path')
    var wt = worktreesRoot()
    var wtForb = await checkForbidden(wt, 'the worktrees folder')
    if (wtForb) throw coded(wtForb, 'forbidden_path')
    var wtReal = await realish(wt)
    var topReal = await realish(tl.top)
    var mainReal = await realish(tl.mainTop)
    var anchorReal = await realish(anchor)
    if (isInside(wtReal, topReal) || isInside(wtReal, mainReal)) throw coded('the worktrees folder ' + wt + ' is inside the repository', 'nested')
    if (isInside(anchorReal, wtReal)) throw coded(anchor + ' is already inside a Walnut workspace; nested workspaces are refused', 'nested')

    var repoName = slugify(P.basename(tl.mainTop))
    var mainTop = tl.mainTop
    var slug = slugify(args.name)
    var target = P.join(wt, repoName, slug)
    var branch = 'walnut/' + slug
    var rel = P.relative(topReal, anchorReal)
    var sub = rel && rel.indexOf('..') !== 0 && !P.isAbsolute(rel) ? rel : ''

    var baseName: string | undefined
    var baseSha: string
    if (args.baseRef !== undefined && args.baseRef !== null && args.baseRef !== '') {
      if (!validRef(args.baseRef)) throw coded('invalid base ref: ' + String(args.baseRef), 'bad_args')
      var v = await git(['rev-parse', '--verify', '-q', String(args.baseRef) + '^{commit}'], tl.top)
      if (!v.ok || !v.out) throw coded('base ref ' + String(args.baseRef) + ' does not name a commit', 'bad_args')
      baseSha = v.out
      baseName = String(args.baseRef)
    } else {
      var h = await git(['rev-parse', '--verify', '-q', 'HEAD'], anchor)
      if (!h.ok || !h.out) throw coded('the repository has no commits yet', 'no_commits')
      baseSha = h.out
      var b = await git(['symbolic-ref', '--short', '-q', 'HEAD'], anchor)
      if (b.ok && b.out) baseName = b.out
    }

    var result = (adopted: boolean): Record<string, unknown> => ({
      provider: GIT_ID, root: target, cwd: target, branch: branch,
      baseRef: Object.assign({ sha: baseSha }, baseName ? { name: baseName } : {}),
      sourceRepo: mainTop, repos: [{ path: target, name: repoName, branch: branch }],
      ...(adopted ? { adopted: true } : {}),
    })
    var withCwd = async (r: Record<string, unknown>) => {
      if (sub && (await isDir(P.join(target, sub)))) r.cwd = P.join(target, sub)
      return r
    }

    var list = await git(['worktree', 'list', '--porcelain'], tl.mainTop)
    var entries = list.ok ? parseWorktreeList(list.out) : []
    var targetReal = await realish(target)
    for (var i = 0; i < entries.length; i++) {
      if ((await realish(entries[i].path)) !== targetReal) continue
      if (entries[i].branch === 'refs/heads/' + branch && (await isDir(target))) {
        job.progress = 'Reusing the worktree this task already has'
        return withCwd(result(true))
      }
      throw coded('a worktree already exists at ' + target + ' on another branch', 'target_exists')
    }
    if (await exists(target)) throw coded('a folder already exists at ' + target + '; Walnut will not reuse it', 'target_exists')

    var parent = P.dirname(target)
    var parentExisted = await exists(parent)
    await fsp.mkdir(parent, { recursive: true, mode: 0o755 })
    var branchExisted = (await git(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], tl.mainTop)).ok
    job.progress = branchExisted ? 'Checking out branch ' + branch : 'Creating branch ' + branch
    var add = branchExisted
      ? await git(['worktree', 'add', target, branch], tl.mainTop, 10 * 60_000)
      : await git(['worktree', 'add', '-b', branch, target, baseSha], tl.mainTop, 10 * 60_000)
    if (!add.ok) {
      // Leave nothing half-made: the folder (only if it is not a registered worktree) and a branch this attempt created.
      var after = await git(['worktree', 'list', '--porcelain'], tl.mainTop)
      // Unknown counts as registered: then neither the folder nor the branch is touched.
      var registered = !after.ok
      var afterEntries = after.ok ? parseWorktreeList(after.out) : []
      for (var k = 0; k < afterEntries.length && !registered; k++) {
        // realish on both sides: on macOS /tmp and /var are symlinks, so P.resolve compares unequal spellings.
        if ((await realish(afterEntries[k].path)) === targetReal) registered = true
      }
      if (!registered && isInside(target, wt) && target !== wt && (await exists(target))) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      }
      if (!branchExisted && !registered) {
        var tip = await git(['rev-parse', '--verify', '-q', 'refs/heads/' + branch], tl.mainTop)
        if (tip.ok && tip.out === baseSha) await git(['update-ref', '-d', 'refs/heads/' + branch, baseSha], tl.mainTop)
      }
      await git(['worktree', 'prune'], tl.mainTop)
      if (!parentExisted) await fsp.rmdir(parent).catch(() => {})
      throw coded('git worktree add failed: ' + gitErr(add), 'git_failed')
    }
    var check = await git(['rev-parse', '--show-toplevel'], target)
    if (!check.ok || (await realish(check.out)) !== targetReal) throw coded('the new worktree at ' + target + ' did not check out cleanly', 'git_failed')
    job.progress = 'Worktree ready'
    return withCwd(result(false))
  }

  // ── probing (shared by both kinds) ──

  /** Does a branch, remote-tracking ref or tag hold this commit? null: git could not tell. */
  async function onSomeRef(repoPath: string, sha: string): Promise<boolean | null> {
    var refs = await git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], repoPath)
    if (!refs.ok) return null
    return refs.out.split('\n').filter(Boolean).length > 0
  }

  /**
   * One repository: its uncommitted and ignored entries, a detached HEAD no ref
   * holds, and (plugin repositories, whose whole folder a removal deletes) its
   * stash and the commits on local branches that no remote-tracking ref holds.
   */
  async function probeRepo(repo: WorkspaceRepo, kind: 'git' | 'plugin', mergedCheck?: () => Promise<boolean | null>,
    collectIgnored?: string[]): Promise<WorkspaceRepoProbe> {
    var p = P.resolve(repo.path)
    var base = { path: p, ...(repo.name ? { name: repo.name } : {}) }
    if (!(await isDir(p))) return Object.assign(base, { exists: false, dirty: false, changes: 0, unreadable: false, merged: null })
    var st = await git(['status', '--porcelain=v1', '--ignored'], p)
    if (!st.ok) return Object.assign(base, { exists: true, dirty: false, changes: 0, unreadable: true, error: gitErr(st), merged: null })
    var lines = st.out ? st.out.split('\n').filter(Boolean) : []
    var ignored = lines.filter((l) => l.indexOf('!! ') === 0).map((l) => l.slice(3))
    var changes = lines.length - ignored.length
    var out: WorkspaceRepoProbe = Object.assign(base, { exists: true, dirty: changes > 0, changes: changes, unreadable: false, merged: null as boolean | null })
    if (ignored.length) { out.ignored = ignored.slice(0, 8); out.ignoredCount = ignored.length }
    if (collectIgnored) for (var i = 0; i < ignored.length; i++) collectIgnored.push(ignored[i])
    var br = await git(['symbolic-ref', '--short', '-q', 'HEAD'], p)
    var onBranch = br.ok && !!br.out
    if (onBranch) out.branch = br.out
    var head = await git(['rev-parse', '--verify', '-q', 'HEAD'], p)
    // Detached on a commit no ref holds: removing the folder loses it (unknown counts as lost).
    if (head.ok && head.out && !onBranch && (await onSomeRef(p, head.out)) !== true) out.lostHead = true
    if (kind === 'plugin') {
      out.stashed = (await git(['rev-parse', '--verify', '-q', 'refs/stash'], p)).ok
      if (!head.ok) {
        out.unpushed = 0
        out.merged = true
      } else {
        var n = await git(['rev-list', '--count', '--branches', '--not', '--remotes'], p)
        if (n.ok && /^\d+$/.test(n.out)) {
          out.unpushed = Number(n.out)
          out.merged = out.unpushed === 0
        }
      }
    } else if (mergedCheck) {
      try { out.merged = await mergedCheck() } catch { out.merged = null }
    }
    return out
  }

  /** Folders at most `depth` below `start` holding a `.git` entry. `truncated`: the budget ran out or a folder could not be read. */
  async function findRepos(start: string, depth: number, budget: { left: number }): Promise<{ found: string[]; truncated: boolean }> {
    var found: string[] = []
    var truncated = false
    var queue: Array<{ dir: string; d: number }> = [{ dir: start, d: 0 }]
    while (queue.length) {
      var cur = queue.shift()!
      if (budget.left <= 0) { truncated = true; break }
      budget.left--
      var entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
      try { entries = await fsp.readdir(cur.dir, { withFileTypes: true }) } catch { truncated = true; continue }
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        if (e.name === '.git') { found.push(cur.dir); continue }
        if (cur.d < depth && e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules') queue.push({ dir: P.join(cur.dir, e.name), d: cur.d + 1 })
      }
    }
    return { found: found, truncated: truncated }
  }

  async function gitBranchMerged(sourceRepo: string, branch: string, baseRef: { name?: string; sha?: string } | undefined): Promise<{ tip?: string; merged: boolean | null }> {
    var tipR = await git(['rev-parse', '--verify', '-q', 'refs/heads/' + branch], sourceRepo)
    if (!tipR.ok || !tipR.out) return { merged: true }
    var tip = tipR.out
    if (baseRef && baseRef.sha && baseRef.sha === tip) return { tip: tip, merged: true }
    var cands: string[] = []
    if (baseRef && baseRef.name && validRef(baseRef.name)) cands.push(baseRef.name, baseRef.name + '@{upstream}')
    for (var i = 0; i < cands.length; i++) {
      var exists2 = await git(['rev-parse', '--verify', '-q', cands[i]], sourceRepo)
      if (!exists2.ok) continue
      var anc = await git(['merge-base', '--is-ancestor', tip, cands[i]], sourceRepo)
      if (anc.ok) return { tip: tip, merged: true }
    }
    var refs = await git(['for-each-ref', '--contains', tip, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], sourceRepo)
    if (!refs.ok) return { tip: tip, merged: null }
    var others = refs.out.split('\n').filter((r) => r && r !== 'refs/heads/' + branch)
    return { tip: tip, merged: others.length > 0 }
  }

  /** The repositories a plugin workspace holds now: the recorded ones plus what listRepos answers today. */
  async function currentRepos(spec: WorkspaceProviderSpec | null, root: string, recorded: WorkspaceRepo[], inputs: unknown,
    problems: string[]): Promise<{ repos: WorkspaceRepo[]; blocked: boolean }> {
    var repos = recorded.slice()
    if (!spec) {
      problems.push('the provider is not configured on this host, so its repositories cannot be listed')
      return { repos: repos, blocked: true }
    }
    if (spec.operations && spec.operations.indexOf('listRepos') < 0) return { repos: repos, blocked: false }
    try {
      var listed = await runProvider(spec, 'listRepos', { root: root, inputs: inputs && typeof inputs === 'object' ? inputs : {} })
      var raw = Array.isArray(listed.repos) ? listed.repos : []
      var seen: string[] = []
      for (var i = 0; i < repos.length; i++) seen.push(await realish(repos[i].path))
      for (var j = 0; j < raw.length && repos.length < 64; j++) {
        var r = raw[j] as Record<string, unknown>
        if (!r || typeof r.path !== 'string') continue
        var abs = P.resolve(root, r.path)
        if (!isInside(abs, root)) continue
        var real = await realish(abs)
        if (seen.indexOf(real) >= 0) continue
        seen.push(real)
        repos.push({ path: abs, ...(typeof r.name === 'string' ? { name: r.name.slice(0, 120) } : {}) })
      }
      return { repos: repos, blocked: false }
    } catch (err) {
      problems.push('could not list its repositories (' + errText(err) + ')')
      return { repos: repos, blocked: true }
    }
  }

  async function probe(args: Record<string, unknown>, spec: WorkspaceProviderSpec | null): Promise<WorkspaceProbe> {
    var provider = String(args.provider)
    var isGit = provider === GIT_ID
    var root = P.resolve(expandHome(String(args.root)))
    var recorded = Array.isArray(args.repos) ? (args.repos as unknown[]).filter((r): r is WorkspaceRepo => !!r && typeof (r as WorkspaceRepo).path === 'string').slice(0, 64) : []
    recorded = recorded.map((r) => ({ ...r, path: P.isAbsolute(r.path) ? r.path : P.join(root, r.path) }))
    var problems: string[] = []
    var out: WorkspaceProbe = { root: root, rootExists: await isDir(root), repos: [], clean: true, merged: true, problems: problems }
    var blocked = false
    var unlisted: string[] = []
    var repos = recorded
    if (isGit) {
      var branch = typeof args.branch === 'string' && validRef(args.branch) ? args.branch : undefined
      var sourceRepo = typeof args.sourceRepo === 'string' ? P.resolve(args.sourceRepo) : undefined
      var bm: { tip?: string; merged: boolean | null } = { merged: null }
      if (branch && sourceRepo && (await isDir(sourceRepo))) {
        bm = await gitBranchMerged(sourceRepo, branch, args.baseRef as { name?: string; sha?: string } | undefined)
      } else if (branch) {
        problems.push('the source repository ' + (sourceRepo || '(unknown)') + ' is gone, so the branch cannot be checked')
      }
      out.branch = branch
      out.branchTip = bm.tip
      out.branchMerged = bm.merged
      // The worktree is the root itself, whatever the task row says its repositories are.
      var named = recorded[0] && P.resolve(recorded[0].path) === root ? recorded[0].name : undefined
      var ignoredAll: string[] = []
      out.repos.push(await probeRepo({ path: root, ...(named ? { name: named } : {}) }, 'git', async () => bm.merged, ignoredAll))
      // `git worktree remove` deletes ignored folders: one that holds a repository holds work git cannot see.
      var budget = { left: 1000 }
      for (var g = 0; g < ignoredAll.length && out.rootExists; g++) {
        if (!/\/$/.test(ignoredAll[g])) continue
        var inIgnored = await findRepos(P.join(root, ignoredAll[g]), 2, budget)
        unlisted = unlisted.concat(inIgnored.found)
        if (inIgnored.truncated) blocked = true
      }
      if (blocked) problems.push('could not look through every ignored folder for repositories')
    } else {
      if (out.rootExists) {
        var cur = await currentRepos(spec, root, recorded, args.inputs, problems)
        repos = cur.repos
        blocked = cur.blocked
        var known: string[] = []
        for (var k = 0; k < repos.length; k++) known.push(await realish(repos[k].path))
        var scan = await findRepos(root, SCAN_DEPTH, { left: SCAN_MAX_DIRS })
        for (var s = 0; s < scan.found.length; s++) {
          if (known.indexOf(await realish(scan.found[s])) < 0) unlisted.push(scan.found[s])
        }
        if (scan.truncated) {
          blocked = true
          problems.push('could not look through every folder for repositories (more than ' + SCAN_MAX_DIRS + ' folders, or one could not be read)')
        }
      }
      if (repos.length === 0 && out.rootExists) problems.push('the provider listed no repositories to check')
      for (var i = 0; i < repos.length; i++) out.repos.push(await probeRepo(repos[i], 'plugin'))
    }
    if (unlisted.length) {
      out.unlisted = unlisted.slice(0, 20)
      for (var u = 0; u < out.unlisted.length; u++) problems.push(out.unlisted[u] + ': a repository Walnut was not told about')
    }
    for (var j = 0; j < out.repos.length; j++) {
      var r = out.repos[j]
      var label = r.name || P.basename(r.path)
      if (r.unreadable) problems.push(label + ': could not be read (' + (r.error || 'git failed') + ')')
      if (r.dirty) problems.push(label + ': ' + r.changes + ' uncommitted change' + (r.changes === 1 ? '' : 's'))
      if (r.stashed) problems.push(label + ': has stashed changes')
      if (r.lostHead) problems.push(label + ': its HEAD is a detached commit that no branch holds')
      if (r.exists && r.merged === false) {
        problems.push(label + ': ' + (isGit ? 'branch ' + (out.branch || '') + ' has commits that are not merged or pushed anywhere'
          : (r.unpushed || 0) + ' commit' + (r.unpushed === 1 ? '' : 's') + ' on local branches ' + (r.unpushed === 1 ? 'is' : 'are') + ' not pushed'))
      }
      if (r.exists && r.merged === null && !r.unreadable) problems.push(label + ': could not tell whether its commits are ' + (isGit ? 'merged' : 'pushed'))
    }
    // Fail closed: whatever could not be checked, or was never listed, keeps the workspace.
    out.clean = !blocked && unlisted.length === 0
      && out.repos.every((r) => !r.dirty && !r.unreadable && !r.stashed && !r.lostHead)
      && !(!isGit && repos.length === 0 && out.rootExists)
    out.merged = isGit
      ? out.branchMerged === true
      : out.repos.every((r) => !r.exists || r.merged === true)
    return out
  }

  // ── removal ──

  async function removeWork(args: Record<string, unknown>, job: WorkspaceJob, spec: WorkspaceProviderSpec | null): Promise<Record<string, unknown>> {
    var provider = String(args.provider)
    var root = P.resolve(expandHome(String(args.root)))
    var forb = await checkForbidden(root, 'workspace root')
    if (forb) throw coded(forb, 'forbidden_path')
    if (typeof args.anchor === 'string' && isInside(await realish(args.anchor), await realish(root))) {
      throw coded('workspace root ' + root + ' contains the folder the task was started from; Walnut will not remove it', 'forbidden_path')
    }
    job.progress = 'Checking every repository'
    var pr = await probe(args, spec)
    if (!pr.clean) throw coded('kept: ' + pr.problems.join('; '), 'not_clean', { probe: pr })
    // A plugin workspace's unpushed commits live only in the folder the provider deletes,
    // so it must be merged whatever the caller asked; a git worktree's live on its branch.
    var requireMerged = args.requireMerged === true || provider !== GIT_ID
    if (requireMerged && !pr.merged) throw coded('kept: ' + pr.problems.join('; '), 'not_merged', { probe: pr })
    if (provider === GIT_ID) {
      var wt = await realish(worktreesRoot())
      var rootReal = await realish(root)
      var rel = P.relative(wt, rootReal)
      if (!isInside(rootReal, wt) || rootReal === wt || rel.split(P.sep).length < 2) {
        throw coded('workspace root ' + root + ' is not inside the Walnut worktrees folder ' + wt, 'forbidden_path')
      }
      var sourceRepo = typeof args.sourceRepo === 'string' ? P.resolve(args.sourceRepo) : ''
      if (!sourceRepo || !(await isDir(sourceRepo))) throw coded('the source repository ' + (sourceRepo || '(unknown)') + ' is gone', 'source_missing', { probe: pr })
      if (isInside(await realish(sourceRepo), rootReal)) throw coded('workspace root contains the source repository', 'forbidden_path')
      if (pr.rootExists) {
        job.progress = 'Removing the worktree'
        var rm = await git(['worktree', 'remove', root], sourceRepo, 5 * 60_000)
        if (!rm.ok) throw coded('git worktree remove refused: ' + gitErr(rm), 'git_failed', { probe: pr })
      }
      await git(['worktree', 'prune'], sourceRepo)
      var branchDeleted = false
      var branchKept = false
      if (pr.branch && pr.branchTip) {
        // The branch name comes from the task row: delete only a branch Walnut names
        // (walnut/…) that no worktree has checked out, never e.g. a tampered "main".
        var mayDelete = args.deleteBranch === 'if-merged' && pr.branchMerged === true && pr.branch.indexOf('walnut/') === 0
        if (mayDelete) {
          var still = await git(['worktree', 'list', '--porcelain'], sourceRepo)
          mayDelete = still.ok && !parseWorktreeList(still.out).some((e) => e.branch === 'refs/heads/' + pr.branch)
        }
        if (mayDelete) {
          var del = await git(['update-ref', '-d', 'refs/heads/' + pr.branch, pr.branchTip], sourceRepo)
          branchDeleted = del.ok
          branchKept = !del.ok
        } else {
          branchKept = true
        }
      }
      await fsp.rmdir(P.dirname(root)).catch(() => {})
      return { removed: true, root: root, rootGone: !(await exists(root)), branchDeleted: branchDeleted, branchKept: branchKept, probe: pr }
    }
    if (!spec) throw coded('unknown workspace provider: ' + provider, 'unknown_provider')
    var regions = await pluginRegions(spec)
    var rootReal2 = await realish(root)
    if (!regions.some((reg) => isInside(rootReal2, reg) && rootReal2 !== reg)) {
      throw coded('workspace root ' + root + ' is outside the folders a workspace may live in', 'forbidden_path')
    }
    job.progress = 'Asking ' + spec.displayName + ' to remove it'
    await runProvider(spec, 'remove', {
      root: root, repos: pr.repos.map((r) => ({ path: r.path, ...(r.name ? { name: r.name } : {}) })),
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
      ...(typeof args.anchor === 'string' ? { anchor: args.anchor } : {}),
    }, (line) => { job.progress = line })
    return { removed: true, root: root, rootGone: !(await exists(root)), probe: pr }
  }

  // ── plugin create ──

  async function pluginCreate(spec: WorkspaceProviderSpec, args: Record<string, unknown>, job: WorkspaceJob): Promise<Record<string, unknown>> {
    var anchor = P.resolve(expandHome(String(args.anchor)))
    var forb = await checkForbidden(anchor, 'folder')
    if (forb) throw coded(forb, 'forbidden_path')
    var wtReal = await realish(worktreesRoot())
    if (isInside(await realish(anchor), wtReal)) throw coded(anchor + ' is already inside a Walnut workspace; nested workspaces are refused', 'nested')
    job.progress = 'Starting ' + spec.displayName
    var markerRoot = spec.markers ? await findMarker(anchor, spec.markers) : null
    var res = await runProvider(spec, 'create', {
      anchor: anchor, name: slugify(args.name),
      ...(markerRoot ? { markerRoot: markerRoot } : {}),
      ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
      ...(typeof args.title === 'string' ? { title: String(args.title).slice(0, 300) } : {}),
      ...(validRef(args.baseRef) ? { baseRef: args.baseRef } : {}),
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
    }, (line) => { job.progress = line })
    var regions = await pluginRegions(spec)
    var bad = await checkCreatedRoot(res.root, regions, anchor, true)
    if (bad) throw coded(bad + '. Nothing was removed; check the provider.', 'unsafe_result')
    var root = String(res.root)
    if (!(await isDir(root))) throw coded('the provider reported ' + root + ' but no folder exists there', 'unsafe_result')
    var cwd = typeof res.cwd === 'string' && res.cwd ? P.resolve(root, res.cwd) : root
    if (!isInside(cwd, root) || !(await isDir(cwd))) cwd = root
    var reposRaw = Array.isArray(res.repos) ? res.repos : []
    if (reposRaw.length === 0 && (!spec.operations || spec.operations.indexOf('listRepos') >= 0)) {
      try {
        var listed = await runProvider(spec, 'listRepos', { root: root, inputs: args.inputs || {} })
        reposRaw = Array.isArray(listed.repos) ? listed.repos : []
      } catch { /* the probe will say it has nothing to check */ }
    }
    var repos: WorkspaceRepo[] = []
    for (var i = 0; i < reposRaw.length && repos.length < 64; i++) {
      var r = reposRaw[i] as Record<string, unknown>
      if (!r || typeof r.path !== 'string') continue
      var rp = P.resolve(root, r.path)
      if (!isInside(rp, root)) continue
      repos.push({ path: rp, ...(typeof r.name === 'string' ? { name: r.name.slice(0, 120) } : {}), ...(typeof r.branch === 'string' ? { branch: r.branch.slice(0, 200) } : {}) })
    }
    return {
      provider: spec.id, root: root, cwd: cwd, repos: repos,
      ...(typeof res.branch === 'string' ? { branch: res.branch.slice(0, 200) } : {}),
    }
  }

  // ── detect ──

  async function detect(args: Record<string, unknown>): Promise<WorkspaceReply> {
    if (!isAbsPathString(args.anchor)) return fail('workspace.detect: anchor must be an absolute path', 'bad_args')
    var anchor = P.resolve(expandHome(String(args.anchor)))
    var candidates: Record<string, unknown>[] = [await gitDetect(anchor)]
    var specs = config && typeof args.providersHash === 'string' && args.providersHash === config.hash ? config.providers : null
    if (!specs && args.providersHash !== undefined && args.providersHash !== null) {
      return fail('workspace providers are not configured on this host yet', 'providers_stale')
    }
    var budget = typeof args.budgetMs === 'number' && args.budgetMs > 0 ? Math.min(args.budgetMs, 60_000) : 20_000
    var plugin = (specs || []).map(async (spec): Promise<Record<string, unknown>> => {
      var base = { provider: spec.id, displayName: spec.displayName, priority: spec.priority, builtin: false }
      var markerRoot = spec.markers ? await findMarker(anchor, spec.markers) : null
      if (spec.markers && !markerRoot) return Object.assign(base, { claimed: false, reason: 'no ' + spec.markers.join(' / ') + ' here or above' })
      if (spec.operations && spec.operations.indexOf('detect') < 0) {
        return Object.assign(base, { claimed: !!markerRoot, ...(markerRoot ? { root: markerRoot } : { reason: 'no detect step' }) })
      }
      try {
        var res = await runProvider(spec, 'detect', { anchor: anchor, ...(markerRoot ? { markerRoot: markerRoot } : {}) }, undefined, Math.min(budget, opTimeoutMs(spec, 'detect')))
        return Object.assign(base, {
          claimed: res.claimed === true,
          ...(typeof res.root === 'string' ? { root: res.root } : markerRoot ? { root: markerRoot } : {}),
          ...(typeof res.reason === 'string' ? { reason: res.reason.slice(0, 300) } : {}),
        })
      } catch (err) {
        var code = (err as { code?: string }).code
        if (code === 'unsupported' && markerRoot) return Object.assign(base, { claimed: true, root: markerRoot })
        return Object.assign(base, { claimed: false, reason: errText(err).slice(0, 300) })
      }
    })
    candidates = candidates.concat(await Promise.all(plugin))
    candidates.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
    return { ok: true, anchor: anchor, candidates: candidates }
  }

  // ── the command surface ──

  async function handle(name: string, cmd: Record<string, unknown>): Promise<WorkspaceReply> {
    try {
      if (name === 'workspace.configure') return await configure(cmd.config)
      if (name === 'workspace.detect') return await detect(cmd)
      if (name === 'workspace.job') {
        pruneJobs()
        var j = typeof cmd.jobId === 'string' ? jobs.get(cmd.jobId) : undefined
        return { ok: true, job: j ? Object.assign({}, j) : null }
      }
      var provider = cmd.provider
      if (typeof provider !== 'string' || !provider) return fail(name + ': provider is required', 'bad_args')
      var spec: WorkspaceProviderSpec | null = null
      if (provider !== GIT_ID) {
        var found = pluginSpec(provider, cmd.providersHash)
        if (isReply(found)) return found
        spec = found
      }
      if (name === 'workspace.create') {
        if (typeof cmd.jobId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(cmd.jobId)) return fail('workspace.create: jobId is required', 'bad_args')
        if (!isAbsPathString(cmd.anchor)) return fail('workspace.create: anchor must be an absolute path', 'bad_args')
        if (cmd.inputs !== undefined && (typeof cmd.inputs !== 'object' || cmd.inputs === null || JSON.stringify(cmd.inputs).length > 65536)) {
          return fail('workspace.create: inputs must be a small JSON object', 'bad_args')
        }
        var anchor = P.resolve(expandHome(String(cmd.anchor)))
        var key = provider + '|' + anchor + '|' + slugify(cmd.name)
        var s = spec
        return startJob(cmd.jobId, 'create', provider, key, (job) => (s ? pluginCreate(s, cmd, job) : gitCreate(cmd, job)))
      }
      if (!isAbsPathString(cmd.root)) return fail(name + ': root must be an absolute path', 'bad_args')
      if (name === 'workspace.status') return { ok: true, probe: await probe(cmd, spec) }
      if (name === 'workspace.repos') {
        if (!spec) return { ok: true, repos: [{ path: P.resolve(String(cmd.root)) }] }
        var listed = await runProvider(spec, 'listRepos', { root: P.resolve(String(cmd.root)), inputs: cmd.inputs || {} })
        return { ok: true, repos: Array.isArray(listed.repos) ? listed.repos : [] }
      }
      if (name === 'workspace.remove') {
        if (typeof cmd.jobId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(cmd.jobId)) return fail('workspace.remove: jobId is required', 'bad_args')
        var s2 = spec
        return startJob(cmd.jobId, 'remove', provider, provider + '|' + P.resolve(String(cmd.root)), (job) => removeWork(cmd, job, s2))
      }
      return fail('unknown workspace command: ' + name, 'bad_args')
    } catch (err) {
      return fail(name + ' failed: ' + errText(err))
    }
  }

  return {
    handle: handle,
    configure: configure,
    providersHash: () => (config ? config.hash : null),
    // Exposed for tests and the deploy-time smoke.
    forbiddenReason: forbiddenReason,
    checkForbidden: checkForbidden,
    slugify: slugify,
    parseReply: parseReply,
    parseWorktreeList: parseWorktreeList,
    worktreesRoot: worktreesRoot,
    jobCount: () => jobs.size,
  }
}
