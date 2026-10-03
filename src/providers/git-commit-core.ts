/**
 * Commit, push and open a PR for ONE session's changes, host-side, shared by
 * both daemon twins (capability 'git-commit-v1').
 *
 * - plan: for every repo the session touched, the files changed against HEAD,
 *   with this session's files split into hunks and each hunk attributed
 *   (git-attribution-core.ts). Other writers' files are listed whole.
 * - commit: a commit from HEAD plus only the selected hunks/files, built WITHOUT
 *   touching the user's index or working tree: a private GIT_INDEX_FILE seeded
 *   from HEAD, blobs written for each selected file version (HEAD plus the
 *   chosen hunks, placed by content), the repo's pre-commit and commit-msg hooks
 *   run against that private index, commit-tree, then a compare-and-swap
 *   `update-ref` (HEAD moved meanwhile = refused, nothing lost). The real index
 *   is then fixed for the committed paths: an entry that still equals the old
 *   HEAD blob moves to the new one; an entry the user staged differently stays.
 * - push: the current branch to its upstream (or to origin/<branch> when asked
 *   to set one). Explicit refspec without '+', so a non-fast-forward is refused;
 *   never --force.
 * - pr: `gh pr create`, offered only when gh is on PATH and the remote is GitHub.
 *
 * Long operations (hooks can run minutes) are JOBS: start answers at once, the
 * caller polls `job(id)`. One job per repository at a time.
 *
 * How each twin gets it: daemon-standalone.ts imports createGitCommitCore;
 * daemon-source.ts inlines `createGitCommitCore.toString()` through
 * `__CREATE_GIT_COMMIT__`. So the factory body references NOTHING at module
 * scope: every helper lives inside it, every capability comes from `deps`, and
 * it carries no backticks.
 */

import type { createGitAttribution, CommitHunk, AttrOp, ChosenHunk, FileOwner } from './git-attribution-core.js'

export interface GitCommitDeps {
  /** child_process.spawn */
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    pid?: number
    stdin: { end(data?: unknown): void; on(ev: string, cb: (...a: unknown[]) => void): void } | null
    stdout: { on(ev: string, cb: (b: Buffer) => void): void } | null
    stderr: { on(ev: string, cb: (b: Buffer) => void): void } | null
    on(ev: string, cb: (...a: never[]) => void): void
    kill(sig?: string): boolean
  }
  fs: { promises: {
    readFile(p: string): Promise<Buffer>
    lstat(p: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; size: number; mode: number }>
    readlink(p: string): Promise<string>
    access(p: string, mode?: number): Promise<void>
    mkdtemp(prefix: string): Promise<string>
    writeFile(p: string, data: string): Promise<void>
    rm(p: string, opts: { recursive: boolean; force: boolean }): Promise<void>
  } }
  path: {
    join(...p: string[]): string
    resolve(...p: string[]): string
    isAbsolute(p: string): boolean
    basename(p: string): string
    sep: string
  }
  tmpdir: () => string
  /** The daemon's environment (PATH is where gh is looked up). */
  env: Record<string, string | undefined>
  attribution: ReturnType<typeof createGitAttribution>
  now?: () => number
  randomId?: () => string
  /** Kill a hook's whole process group on timeout (the twins own process signals). */
  killGroup?: (pid: number) => void
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  timeouts?: { gitMs?: number; hookMs?: number; pushMs?: number; prMs?: number }
}

/** The changes pipeline's output, as the plan reads it. */
export interface PlanChanges {
  groups: Array<{ repoRoot: string; label?: string; files: Array<{ filePath: string; relPath: string; status?: string; oldRelPath?: string }> }>
  fileMap: Map<string, { ops: AttrOp[] }>
}

export interface CommitPlanFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** 'text' files carry hunks; the rest are offered whole. */
  kind: 'text' | 'binary' | 'large' | 'symlink' | 'filtered' | 'deleted' | 'unread'
  owner: FileOwner
  reason?: string
  /** This session wrote it (its ops name the file). */
  session: boolean
  hunks?: CommitHunk[]
  added?: number
  removed?: number
}

export interface CommitPlanRepo {
  repoRoot: string
  label: string
  branch: string | null
  headSha: string | null
  blocked?: { code: string; message: string }
  files: CommitPlanFile[]
  /** Other writers' files left out past the cap. */
  omitted?: number
  upstream: { remote: string; ref: string; url: string } | null
  /** Where a push would go when the branch has no upstream yet (origin). */
  pushTarget: { remote: string; ref: string; url: string } | null
  ahead: number | null
  behind: number | null
  pr: { available: boolean; reason?: string }
}

export interface CommitJobSnapshot {
  id: string
  kind: 'commit' | 'push' | 'pr'
  repoRoot: string
  state: 'running' | 'succeeded' | 'failed'
  step: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  output: string
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createGitCommitCore(deps: GitCommitDeps) {
  var GIT_MS = (deps.timeouts && deps.timeouts.gitMs) || 60000
  var HOOK_MS = (deps.timeouts && deps.timeouts.hookMs) || 10 * 60000
  var PUSH_MS = (deps.timeouts && deps.timeouts.pushMs) || 5 * 60000
  var PR_MS = (deps.timeouts && deps.timeouts.prMs) || 2 * 60000
  var OUTPUT_CAP = 64 * 1024
  var MAX_OTHER_FILES = 300
  var MAX_TEXT_BYTES = 8 * 1024 * 1024
  var EMPTY_TREE: Record<string, string> = {
    sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
  }
  var REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_LITERAL_PATHSPECS']
  var now = deps.now || function () { return Date.now() }
  var randomId = deps.randomId || function () { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6) }
  var jobs = new Map<string, { snap: CommitJobSnapshot }>()
  var busy = new Map<string, string>()
  var gitVersion: number[] | null = null

  interface RunResult { code: number; stdout: string; stdoutBuf: Buffer; stderr: string; timedOut: boolean }

  /** Code-tagged failure: the code reaches the UI, the message is shown as is. */
  function fail(code: string, message: string): Error {
    var e = new Error(message) as Error & { code?: string }
    e.code = code
    return e
  }

  /** The env for a git child: inherited redirects (GIT_DIR and friends) removed, `extra` on top. */
  function childEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
    var env: Record<string, string | undefined> = Object.assign({}, deps.env || {})
    for (var i = 0; i < REDIRECT_VARS.length; i++) delete env[REDIRECT_VARS[i]]
    for (var k in extra) env[k] = extra[k]
    return env
  }

  /** For Walnut's own plumbing calls: no optional locks, literal paths, never a prompt. */
  function plumbingEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
    return childEnv(Object.assign({ GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' }, extra || {}))
  }

  function run(argv: string[], o: {
    cwd: string; env: Record<string, string | undefined>; input?: string | Buffer; timeoutMs?: number;
    maxBuffer?: number; group?: boolean; onData?: (chunk: string) => void
  }): Promise<RunResult> {
    return new Promise(function (resolve) {
      var child: ReturnType<GitCommitDeps['spawn']>
      try {
        child = deps.spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !!o.group })
      } catch (err) {
        resolve({ code: -1, stdout: '', stdoutBuf: Buffer.alloc(0), stderr: String((err as Error).message || err), timedOut: false })
        return
      }
      var out: Buffer[] = []
      var outLen = 0
      var errText = ''
      var settled = false
      var timedOut = false
      var max = o.maxBuffer || 128 * 1024 * 1024
      var stop = function () {
        if (o.group && child.pid && child.pid > 1 && deps.killGroup) { try { deps.killGroup(child.pid) } catch (_e) { /* gone */ } }
        try { child.kill('SIGKILL') } catch (_e) { /* gone */ }
      }
      var timer = setTimeout(function () { timedOut = true; stop() }, o.timeoutMs || GIT_MS)
      var finish = function (code: number) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        var buf = Buffer.concat(out)
        resolve({ code: code, stdout: buf.toString('utf8'), stdoutBuf: buf, stderr: errText, timedOut: timedOut })
      }
      if (child.stdout) child.stdout.on('data', function (b: Buffer) {
        outLen += b.length
        if (outLen > max) { stop(); return }
        out.push(b)
        if (o.onData) o.onData(b.toString('utf8'))
      })
      if (child.stderr) child.stderr.on('data', function (b: Buffer) {
        if (errText.length < 1024 * 1024) errText += b.toString('utf8')
        if (o.onData) o.onData(b.toString('utf8'))
      })
      child.on('error', function (e: never) { if (!errText) errText = String((e as unknown as Error).message || e); finish(-1) })
      child.on('close', function (code: never) { finish(typeof code === 'number' ? code : -1) })
      if (child.stdin) {
        child.stdin.on('error', function () { /* the child closed its stdin */ })
        if (o.input != null) child.stdin.end(o.input)
        else child.stdin.end()
      }
    })
  }

  function git(cwd: string, args: string[], extra?: { env?: Record<string, string | undefined>; input?: string | Buffer; timeoutMs?: number }): Promise<RunResult> {
    return run(['git'].concat(args), { cwd: cwd, env: (extra && extra.env) || plumbingEnv(), input: extra && extra.input, timeoutMs: extra && extra.timeoutMs })
  }

  function firstLine(s: string): string {
    var t = String(s || '').trim()
    var nl = t.indexOf('\n')
    return nl >= 0 ? t.slice(0, nl) : t
  }

  async function exists(p: string): Promise<boolean> {
    try { await deps.fs.promises.access(p); return true } catch (_e) { return false }
  }

  async function isExecutable(p: string): Promise<boolean> {
    try { await deps.fs.promises.access(p, 1); return true } catch (_e) { return false }
  }

  async function onPath(name: string): Promise<string | null> {
    var dirs = String((deps.env && deps.env.PATH) || '').split(':')
    for (var i = 0; i < dirs.length; i++) {
      if (!dirs[i]) continue
      var p = deps.path.join(dirs[i], name)
      if (await isExecutable(p)) return p
    }
    return null
  }

  async function version(cwd: string): Promise<number[]> {
    if (gitVersion) return gitVersion
    var r = await git(cwd, ['version'])
    var m = /(\d+)\.(\d+)/.exec(r.stdout)
    gitVersion = m ? [Number(m[1]), Number(m[2])] : [0, 0]
    return gitVersion
  }

  /** Credentials never leave the host: `https://user:token@host/x` -> `https://host/x`. */
  function redactUrl(url: string): string {
    return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
  }

  function isGithubUrl(url: string): boolean {
    return /(^|[@/.])github\.com[:/]/i.test(String(url || ''))
  }

  /** A repo-relative path from a caller: no escape, no NUL, no absolute path. */
  function safeRel(p: unknown): string | null {
    if (typeof p !== 'string' || !p || p.indexOf('\u0000') >= 0 || p.charAt(0) === '/') return null
    var parts = p.split('/')
    for (var i = 0; i < parts.length; i++) if (parts[i] === '..' || parts[i] === '' || parts[i] === '.') return null
    if (parts[0] === '.git') return null
    return p
  }

  interface RepoInfo {
    top: string
    gitDir: string
    branch: string | null
    head: string | null
    headTree: string
    objectFormat: string
    blocked?: { code: string; message: string }
  }

  /** Where a repo stands: top level, branch, HEAD, and anything that blocks a commit. */
  async function repoState(root: string): Promise<RepoInfo | { notRepo: string }> {
    var top = await git(root, ['rev-parse', '--show-toplevel'])
    if (top.code !== 0 || !top.stdout.trim()) return { notRepo: firstLine(top.stderr) || 'not a git repository' }
    var topDir = top.stdout.trim()
    var gd = await git(topDir, ['rev-parse', '--absolute-git-dir'])
    var gitDir = gd.stdout.trim()
    var fmt = await git(topDir, ['rev-parse', '--show-object-format'])
    var objectFormat = fmt.code === 0 && fmt.stdout.trim() ? fmt.stdout.trim() : 'sha1'
    var sym = await git(topDir, ['symbolic-ref', '-q', 'HEAD'])
    var ref = sym.code === 0 ? sym.stdout.trim() : ''
    var branch = ref.indexOf('refs/heads/') === 0 ? ref.slice('refs/heads/'.length) : null
    var hd = await git(topDir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
    var head = hd.code === 0 && hd.stdout.trim() ? hd.stdout.trim() : null
    var headTree = EMPTY_TREE[objectFormat] || EMPTY_TREE.sha1
    if (head) {
      var tr = await git(topDir, ['rev-parse', 'HEAD^{tree}'])
      if (tr.code === 0) headTree = tr.stdout.trim()
    }
    var info: RepoInfo = { top: topDir, gitDir: gitDir, branch: branch, head: head, headTree: headTree, objectFormat: objectFormat }
    if (!branch) {
      info.blocked = ref
        ? { code: 'not-a-branch', message: 'HEAD points at ' + ref + ', not a local branch.' }
        : { code: 'detached', message: 'HEAD is detached. Check out a branch to commit.' }
      return info
    }
    var states: Array<[string, string, string]> = [
      ['MERGE_HEAD', 'merge', 'A merge is in progress. Finish or abort it first.'],
      ['rebase-merge', 'rebase', 'A rebase is in progress. Finish or abort it first.'],
      ['rebase-apply', 'rebase', 'A rebase or am is in progress. Finish or abort it first.'],
      ['CHERRY_PICK_HEAD', 'cherry-pick', 'A cherry-pick is in progress. Finish or abort it first.'],
      ['REVERT_HEAD', 'revert', 'A revert is in progress. Finish or abort it first.'],
    ]
    for (var i = 0; i < states.length; i++) {
      var gp = await git(topDir, ['rev-parse', '--git-path', states[i][0]])
      if (gp.code === 0 && await exists(deps.path.resolve(topDir, gp.stdout.trim()))) {
        info.blocked = { code: states[i][1], message: states[i][2] }
        return info
      }
    }
    var lock = await git(topDir, ['rev-parse', '--git-path', 'index.lock'])
    if (lock.code === 0 && await exists(deps.path.resolve(topDir, lock.stdout.trim()))) {
      info.blocked = { code: 'index-lock', message: 'Another git process is running in this repository (index.lock exists). Retry when it is done.' }
    }
    return info
  }

  /** Every path that differs from HEAD (tracked changes plus untracked files), submodules left out. */
  async function changedPaths(info: RepoInfo): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted'; mode: string }>> {
    var base = info.head ? 'HEAD' : info.headTree
    var d = await git(info.top, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', base])
    if (d.code !== 0) throw fail('git', 'git diff failed: ' + firstLine(d.stderr))
    var out: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; mode: string }> = []
    var seen = new Set<string>()
    var parts = d.stdout.split('\u0000')
    for (var i = 0; i + 1 < parts.length; i += 2) {
      var meta = parts[i]
      var p = parts[i + 1]
      if (!meta || meta.charAt(0) !== ':' || !p) continue
      var f = meta.slice(1).split(' ')
      var oldMode = f[0]
      var newMode = f[1]
      var letter = (f[4] || '').charAt(0)
      if (oldMode === '160000' || newMode === '160000') continue
      var status: 'added' | 'modified' | 'deleted' = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
      out.push({ path: p, status: status, mode: status === 'added' ? newMode : oldMode })
      seen.add(p)
    }
    var u = await git(info.top, ['ls-files', '-z', '--others', '--exclude-standard'])
    if (u.code === 0) {
      var names = u.stdout.split('\u0000')
      for (var j = 0; j < names.length; j++) {
        if (names[j] && !seen.has(names[j])) { out.push({ path: names[j], status: 'added', mode: '' }); seen.add(names[j]) }
      }
    }
    return out
  }

  function looksBinary(buf: Buffer): boolean {
    return buf.subarray(0, 8000).includes(0)
  }

  /** A working-tree file as the plan and the commit read it. */
  async function readWork(abs: string): Promise<{ kind: 'absent' | 'symlink' | 'binary' | 'large' | 'text' | 'other'; text?: string; target?: string; exec?: boolean }> {
    var st
    try { st = await deps.fs.promises.lstat(abs) } catch (_e) { return { kind: 'absent' } }
    if (st.isSymbolicLink()) return { kind: 'symlink', target: await deps.fs.promises.readlink(abs) }
    if (!st.isFile()) return { kind: 'other' }
    var exec = (st.mode & 0o111) !== 0
    if (st.size > MAX_TEXT_BYTES) return { kind: 'large', exec: exec }
    var buf = await deps.fs.promises.readFile(abs)
    if (looksBinary(buf)) return { kind: 'binary', exec: exec }
    var text = buf.toString('utf8')
    // Not UTF-8: a text diff would rewrite the bytes, so the file is offered whole.
    if (!Buffer.from(text, 'utf8').equals(buf)) return { kind: 'binary', exec: exec }
    return { kind: 'text', text: text, exec: exec }
  }

  /** Paths whose `filter` attribute is set (LFS and friends): never read through a smudge. */
  async function filteredPaths(info: RepoInfo, paths: string[]): Promise<Set<string>> {
    var out = new Set<string>()
    if (paths.length === 0) return out
    var r = await git(info.top, ['check-attr', '-z', '--stdin', 'filter'], { input: paths.join('\u0000') + '\u0000' })
    if (r.code !== 0) return out
    var parts = r.stdout.split('\u0000')
    for (var i = 0; i + 2 < parts.length; i += 3) {
      if (parts[i + 2] && parts[i + 2] !== 'unspecified' && parts[i + 2] !== 'unset') out.add(parts[i])
    }
    return out
  }

  /** HEAD's version of a path, in working-tree form (eol conversion applied). */
  async function readHead(info: RepoInfo, rel: string): Promise<{ kind: 'absent' | 'text' | 'binary' | 'large'; text?: string }> {
    if (!info.head) return { kind: 'absent' }
    var r = await run(['git', 'cat-file', '--filters', 'HEAD:' + rel], { cwd: info.top, env: plumbingEnv(), maxBuffer: MAX_TEXT_BYTES })
    if (r.code !== 0) {
      if (r.stdoutBuf.length >= MAX_TEXT_BYTES) return { kind: 'large' }
      var raw = await run(['git', 'cat-file', '-e', 'HEAD:' + rel], { cwd: info.top, env: plumbingEnv() })
      return raw.code === 0 ? { kind: 'large' } : { kind: 'absent' }
    }
    if (looksBinary(r.stdoutBuf)) return { kind: 'binary' }
    var text = r.stdoutBuf.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(r.stdoutBuf)) return { kind: 'binary' }
    return { kind: 'text', text: text }
  }

  function lastOpIsDelete(ops: AttrOp[]): boolean {
    for (var i = ops.length - 1; i >= 0; i--) {
      if (ops[i] && !ops[i].failed) return ops[i].kind === 'delete'
    }
    return false
  }

  async function planFile(info: RepoInfo, entry: { path: string; status: 'added' | 'modified' | 'deleted' }, ops: AttrOp[] | null, oldRel: string | null, filtered: Set<string>): Promise<CommitPlanFile> {
    var session = !!(ops && ops.length)
    var base: CommitPlanFile = { path: entry.path, status: entry.status, kind: 'unread', owner: session ? 'unknown' : 'other', session: session }
    if (!session) return base
    var abs = deps.path.join(info.top, entry.path)
    var work = await readWork(abs)
    if (entry.status === 'deleted' || work.kind === 'absent') {
      base.kind = 'deleted'
      base.status = 'deleted'
      base.owner = lastOpIsDelete(ops as AttrOp[]) ? 'mine' : 'unknown'
      return base
    }
    if (work.kind !== 'text') {
      base.kind = work.kind === 'symlink' ? 'symlink' : work.kind === 'large' ? 'large' : 'binary'
      return base
    }
    if (filtered.has(entry.path)) { base.kind = 'filtered'; return base }
    var head = entry.status === 'added' ? { kind: 'absent' as const } : await readHead(info, entry.path)
    if (head.kind === 'binary' || head.kind === 'large') { base.kind = head.kind; return base }
    var renameBase: string | undefined
    if (entry.status === 'added' && oldRel) {
      var rb = await readHead(info, oldRel)
      if (rb.kind === 'text') renameBase = rb.text
    }
    var att = deps.attribution.attribute({ head: head.text || '', work: work.text || '', ops: ops as AttrOp[], renameBase: renameBase })
    if (att.reason === 'too-large' && att.hunks.length === 0) { base.kind = 'large'; return base }
    base.kind = 'text'
    base.owner = att.owner
    if (att.reason) base.reason = att.reason
    base.hunks = att.hunks
    base.added = att.added
    base.removed = att.removed
    return base
  }

  async function remoteInfo(info: RepoInfo): Promise<Pick<CommitPlanRepo, 'upstream' | 'pushTarget' | 'ahead' | 'behind' | 'pr'>> {
    var out: Pick<CommitPlanRepo, 'upstream' | 'pushTarget' | 'ahead' | 'behind' | 'pr'> = {
      upstream: null, pushTarget: null, ahead: null, behind: null, pr: { available: false, reason: 'no-remote' },
    }
    if (!info.branch) return out
    var remote = (await git(info.top, ['config', '--get', 'branch.' + info.branch + '.remote'])).stdout.trim()
    var merge = (await git(info.top, ['config', '--get', 'branch.' + info.branch + '.merge'])).stdout.trim()
    if (remote && merge && remote !== '.') {
      var url = await git(info.top, ['remote', 'get-url', '--push', remote])
      if (url.code === 0) {
        out.upstream = { remote: remote, ref: merge, url: redactUrl(url.stdout.trim()) }
        var counts = await git(info.top, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
        var m = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim())
        if (counts.code === 0 && m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
      }
    }
    if (!out.upstream) {
      var origin = await git(info.top, ['remote', 'get-url', '--push', 'origin'])
      if (origin.code === 0 && origin.stdout.trim()) {
        out.pushTarget = { remote: 'origin', ref: 'refs/heads/' + info.branch, url: redactUrl(origin.stdout.trim()) }
      }
    }
    var target = out.upstream || out.pushTarget
    if (!target) return out
    if (!isGithubUrl(target.url)) { out.pr = { available: false, reason: 'not-github' }; return out }
    if (!(await onPath('gh'))) { out.pr = { available: false, reason: 'no-gh' }; return out }
    out.pr = { available: true }
    return out
  }

  /** One repo of the plan. */
  async function planRepo(root: string, label: string, sessionFiles: Map<string, { ops: AttrOp[]; oldRel: string | null }>): Promise<CommitPlanRepo> {
    var st = await repoState(root)
    var empty: CommitPlanRepo = {
      repoRoot: root, label: label, branch: null, headSha: null, files: [], upstream: null, pushTarget: null,
      ahead: null, behind: null, pr: { available: false, reason: 'no-remote' },
    }
    if ('notRepo' in st) { empty.blocked = { code: 'not-a-repo', message: st.notRepo }; return empty }
    var info = st
    var repo: CommitPlanRepo = Object.assign(empty, { repoRoot: info.top, branch: info.branch, headSha: info.head })
    if (info.blocked) repo.blocked = info.blocked
    var changed = await changedPaths(info)
    var mine = changed.filter(function (c) { return sessionFiles.has(c.path) })
    var others = changed.filter(function (c) { return !sessionFiles.has(c.path) })
    var filtered = await filteredPaths(info, mine.map(function (c) { return c.path }))
    var files: CommitPlanFile[] = new Array(mine.length)
    var next = 0
    var worker = async function () {
      while (next < mine.length) {
        var i = next++
        var sf = sessionFiles.get(mine[i].path) as { ops: AttrOp[]; oldRel: string | null }
        files[i] = await planFile(info, mine[i], sf.ops, sf.oldRel, filtered)
        // The daemon's loop serves every session: yield between files.
        await new Promise(function (r) { setImmediate(r) })
      }
    }
    var pool: Promise<void>[] = []
    for (var w = 0; w < Math.min(4, mine.length); w++) pool.push(worker())
    await Promise.all(pool)
    var shown = others.slice(0, MAX_OTHER_FILES)
    for (var j = 0; j < shown.length; j++) files.push({ path: shown[j].path, status: shown[j].status, kind: 'unread', owner: 'other', session: false })
    if (others.length > shown.length) repo.omitted = others.length - shown.length
    files.sort(function (a, b) {
      if (a.session !== b.session) return a.session ? -1 : 1
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
    repo.files = files
    Object.assign(repo, await remoteInfo(info))
    return repo
  }

  /**
   * The commit view's data: one entry per repo the session touched (plus
   * `repoRoots` the caller names), each with its files and their hunks.
   */
  async function plan(cmd: { repoRoots?: unknown }, changes: PlanChanges | null): Promise<{ attributed: boolean; repos: CommitPlanRepo[] }> {
    var groups: Array<{ root: string; label: string; files: Map<string, { ops: AttrOp[]; oldRel: string | null }> }> = []
    if (changes && Array.isArray(changes.groups)) {
      for (var i = 0; i < changes.groups.length; i++) {
        var g = changes.groups[i]
        var files = new Map<string, { ops: AttrOp[]; oldRel: string | null }>()
        for (var j = 0; j < g.files.length; j++) {
          var f = g.files[j]
          var accum = changes.fileMap.get(f.filePath)
          var oldRel = f.status === 'renamed' && f.oldRelPath && safeRel(f.oldRelPath) ? f.oldRelPath : null
          files.set(f.relPath, { ops: accum ? accum.ops : [], oldRel: oldRel })
          // The path a session moved a file away from: its removal is the session's too.
          if (oldRel && !files.has(oldRel)) files.set(oldRel, { ops: [{ kind: 'delete' }], oldRel: null })
        }
        groups.push({ root: g.repoRoot, label: g.label || deps.path.basename(g.repoRoot), files: files })
      }
    }
    var extra = Array.isArray(cmd.repoRoots) ? cmd.repoRoots : []
    for (var k = 0; k < extra.length; k++) {
      var r = extra[k]
      if (typeof r !== 'string' || !deps.path.isAbsolute(r)) continue
      if (!groups.some(function (x) { return x.root === r })) groups.push({ root: r, label: deps.path.basename(r), files: new Map() })
    }
    var repos: CommitPlanRepo[] = []
    var seen = new Set<string>()
    for (var n = 0; n < groups.length; n++) {
      var repo = await planRepo(groups[n].root, groups[n].label, groups[n].files)
      if (seen.has(repo.repoRoot)) continue
      seen.add(repo.repoRoot)
      repos.push(repo)
    }
    return { attributed: !!changes, repos: repos }
  }

  // ── jobs ──

  function snapshot(j: { snap: CommitJobSnapshot }): CommitJobSnapshot {
    return JSON.parse(JSON.stringify(j.snap)) as CommitJobSnapshot
  }

  function setStep(j: { snap: CommitJobSnapshot }, step: string): void {
    j.snap.step = step
    j.snap.updatedAt = now()
  }

  function appendOutput(j: { snap: CommitJobSnapshot }, text: string): void {
    var o = j.snap.output + text
    j.snap.output = o.length > OUTPUT_CAP ? o.slice(o.length - OUTPUT_CAP) : o
    j.snap.updatedAt = now()
  }

  function prune(): void {
    var cutoff = now() - 60 * 60000
    var ids = Array.from(jobs.keys())
    for (var i = 0; i < ids.length; i++) {
      var s = (jobs.get(ids[i]) as { snap: CommitJobSnapshot }).snap
      if (s.state !== 'running' && (s.finishedAt || 0) < cutoff) jobs.delete(ids[i])
    }
    while (jobs.size > 100) {
      var oldest = Array.from(jobs.entries()).filter(function (e) { return e[1].snap.state !== 'running' })[0]
      if (!oldest) break
      jobs.delete(oldest[0])
    }
  }

  /** git's default cleanup for a message given on the command line: whitespace only. */
  function cleanMessage(msg: string): string {
    var lines = String(msg || '').replace(/\r\n?/g, '\n').split('\n')
    var out: string[] = []
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/\s+$/, '')
      if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue
      out.push(l)
    }
    while (out.length && out[out.length - 1] === '') out.pop()
    return out.length ? out.join('\n') + '\n' : ''
  }

  async function runHook(info: RepoInfo, name: string, args: string[], env: Record<string, string | undefined>, j: { snap: CommitJobSnapshot }): Promise<RunResult> {
    var v = await version(info.top)
    var onData = function (chunk: string) { appendOutput(j, chunk) }
    if (v[0] > 2 || (v[0] === 2 && v[1] >= 36)) {
      return run(['git', 'hook', 'run', '--ignore-missing', name].concat(args.length ? ['--'].concat(args) : []), {
        cwd: info.top, env: env, timeoutMs: HOOK_MS, group: true, onData: onData,
      })
    }
    // Before `git hook run`: the hooks directory, core.hooksPath included.
    var dir = await git(info.top, ['rev-parse', '--git-path', 'hooks'])
    var file = deps.path.resolve(info.top, dir.stdout.trim(), name)
    if (!(await isExecutable(file))) return { code: 0, stdout: '', stdoutBuf: Buffer.alloc(0), stderr: '', timedOut: false }
    return run([file].concat(args), { cwd: info.top, env: env, timeoutMs: HOOK_MS, group: true, onData: onData })
  }

  function hookFailure(name: string, r: RunResult): Error {
    if (r.timedOut) return fail('hook-timeout', 'The ' + name + ' hook did not finish in ' + Math.round(HOOK_MS / 60000) + ' minutes. Nothing was committed.')
    return fail('hook-failed', 'The ' + name + ' hook failed (exit ' + r.code + '). Nothing was committed.')
  }

  interface Selection { path: string; mode: 'hunks' | 'whole'; hunks?: ChosenHunk[] }

  function readSelections(raw: unknown): Selection[] {
    if (!Array.isArray(raw)) throw fail('bad-request', 'Nothing selected.')
    var out: Selection[] = []
    var seen = new Set<string>()
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i] as { path?: unknown; mode?: unknown; hunks?: unknown }
      var rel = safeRel(s && s.path)
      if (!rel) throw fail('bad-request', 'Invalid path in the selection.')
      if (seen.has(rel)) throw fail('bad-request', 'A path is selected twice: ' + rel)
      seen.add(rel)
      if (s.mode === 'whole') { out.push({ path: rel, mode: 'whole' }); continue }
      if (s.mode !== 'hunks' || !Array.isArray(s.hunks) || s.hunks.length === 0) throw fail('bad-request', 'No hunks selected for ' + rel)
      var hunks: ChosenHunk[] = []
      for (var k = 0; k < s.hunks.length; k++) {
        var h = s.hunks[k] as Record<string, unknown>
        var strs = function (v: unknown): string[] | null {
          if (v === undefined) return []
          if (!Array.isArray(v)) return null
          for (var q = 0; q < v.length; q++) if (typeof v[q] !== 'string') return null
          return v as string[]
        }
        var oldLines = strs(h.oldLines)
        var newLines = strs(h.newLines)
        var before = strs(h.before)
        var after = strs(h.after)
        if (typeof h.oldStart !== 'number' || h.oldStart < 0 || !oldLines || !newLines || !before || !after) throw fail('bad-request', 'Invalid hunk for ' + rel)
        hunks.push({ id: typeof h.id === 'string' ? h.id : undefined, oldStart: h.oldStart, oldLines: oldLines, newLines: newLines, seq: typeof h.seq === 'number' ? h.seq : 0, before: before, after: after })
      }
      out.push({ path: rel, mode: 'hunks', hunks: hunks })
    }
    if (out.length === 0) throw fail('nothing-selected', 'Nothing selected.')
    return out
  }

  /** mode + blob per path in a tree (HEAD's modes for paths that stay). */
  async function treeModes(info: RepoInfo, paths: string[]): Promise<Map<string, { mode: string; sha: string }>> {
    var out = new Map<string, { mode: string; sha: string }>()
    if (!info.head || paths.length === 0) return out
    for (var i = 0; i < paths.length; i += 200) {
      var r = await git(info.top, ['ls-tree', '-z', 'HEAD', '--'].concat(paths.slice(i, i + 200)))
      var parts = r.stdout.split('\u0000')
      for (var k = 0; k < parts.length; k++) {
        var tab = parts[k].indexOf('\t')
        if (tab < 0) continue
        var f = parts[k].slice(0, tab).split(' ')
        out.set(parts[k].slice(tab + 1), { mode: f[0], sha: f[2] })
      }
    }
    return out
  }

  async function hashBlob(info: RepoInfo, rel: string, input: string, raw?: boolean): Promise<string> {
    var args = raw ? ['hash-object', '-w', '--no-filters', '--stdin'] : ['hash-object', '-w', '--path=' + rel, '--stdin']
    var r = await git(info.top, args, { input: input })
    if (r.code !== 0) throw fail('git', 'Could not write ' + rel + ': ' + firstLine(r.stderr))
    return r.stdout.trim()
  }

  /** Build the commit, run the hooks, move the branch, fix the real index. */
  async function doCommit(cmd: Record<string, unknown>, j: { snap: CommitJobSnapshot }): Promise<Record<string, unknown>> {
    setStep(j, 'checking')
    var message = cleanMessage(typeof cmd.message === 'string' ? cmd.message : '')
    if (!message) throw fail('empty-message', 'Write a commit message first.')
    var selections = readSelections(cmd.selections)
    var st = await repoState(String(cmd.repoRoot || ''))
    if ('notRepo' in st) throw fail('not-a-repo', st.notRepo)
    var info = st
    if (info.blocked) throw fail(info.blocked.code, info.blocked.message)
    if (typeof cmd.branch === 'string' && cmd.branch && cmd.branch !== info.branch) {
      throw fail('branch-changed', 'The repository is now on ' + info.branch + ', not ' + cmd.branch + '. Reload the commit view.')
    }
    var expected = typeof cmd.expectedHead === 'string' && cmd.expectedHead ? cmd.expectedHead : null
    if (expected !== info.head) throw fail('head-moved', 'HEAD moved since the commit view loaded. Reload and try again.')

    setStep(j, 'building')
    var entries: string[] = []
    var removals: string[] = []
    var stale: string[] = []
    var modes = await treeModes(info, selections.map(function (s) { return s.path }))
    var filtered = await filteredPaths(info, selections.filter(function (s) { return s.mode === 'hunks' }).map(function (s) { return s.path }))
    // A whole file carries its exec bit, as git add would (unless core.fileMode is off).
    var trustExec = (await git(info.top, ['config', '--bool', '--get', 'core.fileMode'])).stdout.trim() !== 'false'
    for (var i = 0; i < selections.length; i++) {
      var sel = selections[i]
      var abs = deps.path.join(info.top, sel.path)
      var work = await readWork(abs)
      var headMode = modes.get(sel.path)
      if (sel.mode === 'whole') {
        if (work.kind === 'absent') { if (headMode) removals.push(sel.path); continue }
        if (work.kind === 'symlink') { entries.push('120000 ' + await hashBlob(info, sel.path, work.target || '', true) + ' 0\t' + sel.path); continue }
        if (work.kind === 'other') throw fail('bad-request', sel.path + ' is not a regular file.')
        var whole = await git(info.top, ['hash-object', '-w', '--', sel.path])
        if (whole.code !== 0) throw fail('git', 'Could not write ' + sel.path + ': ' + firstLine(whole.stderr))
        var mode = headMode && headMode.mode !== '120000' && !trustExec ? headMode.mode : (work.exec ? '100755' : '100644')
        entries.push(mode + ' ' + whole.stdout.trim() + ' 0\t' + sel.path)
        continue
      }
      if (work.kind !== 'text' || filtered.has(sel.path)) throw fail('stale', sel.path + ' can no longer be split into hunks. Reload the commit view.')
      var head = await readHead(info, sel.path)
      if (head.kind !== 'text' && head.kind !== 'absent') throw fail('stale', sel.path + ' can no longer be split into hunks. Reload the commit view.')
      var headText = head.text || ''
      var hunks = sel.hunks as ChosenHunk[]
      if (deps.attribution.verifyPresent(headText, work.text || '', hunks).length > 0) { stale.push(sel.path); continue }
      var applied = deps.attribution.applyHunks(headText, hunks)
      if (!('text' in applied)) { stale.push(sel.path); continue }
      var fileMode = headMode && headMode.mode !== '120000' ? headMode.mode : (work.exec ? '100755' : '100644')
      entries.push(fileMode + ' ' + await hashBlob(info, sel.path, applied.text) + ' 0\t' + sel.path)
    }
    if (stale.length) throw fail('stale', 'These files changed since the commit view loaded: ' + stale.join(', ') + '. Reload and pick again.')

    var tmp = await deps.fs.promises.mkdtemp(deps.path.join(deps.tmpdir(), 'walnut-commit-'))
    try {
      var index = deps.path.join(tmp, 'index')
      var idxEnv = plumbingEnv({ GIT_INDEX_FILE: index })
      var seed = await git(info.top, info.head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env: idxEnv })
      if (seed.code !== 0) throw fail('git', 'Could not read HEAD: ' + firstLine(seed.stderr))
      if (entries.length) {
        var ui = await git(info.top, ['update-index', '-z', '--index-info'], { env: idxEnv, input: entries.join('\u0000') + '\u0000' })
        if (ui.code !== 0) throw fail('git', 'Could not stage the selection: ' + firstLine(ui.stderr))
      }
      if (removals.length) {
        var rm = await git(info.top, ['update-index', '-z', '--force-remove', '--stdin'], { env: idxEnv, input: removals.join('\u0000') + '\u0000' })
        if (rm.code !== 0) throw fail('git', 'Could not stage the deletions: ' + firstLine(rm.stderr))
      }

      // The repo's hooks, against the private index (they may add to it, as git commit allows).
      var hookEnv = childEnv({ GIT_INDEX_FILE: index, GIT_EDITOR: ':' })
      setStep(j, 'pre-commit')
      var pre = await runHook(info, 'pre-commit', [], hookEnv, j)
      if (pre.code !== 0) throw hookFailure('pre-commit', pre)

      setStep(j, 'committing')
      var wt = await git(info.top, ['write-tree'], { env: idxEnv })
      if (wt.code !== 0) throw fail('git', 'Could not write the tree: ' + firstLine(wt.stderr))
      var tree = wt.stdout.trim()
      if (tree === info.headTree) throw fail('nothing', 'The selection matches HEAD: there is nothing to commit.')

      var msgFile = deps.path.join(tmp, 'COMMIT_EDITMSG')
      await deps.fs.promises.writeFile(msgFile, message)
      setStep(j, 'commit-msg')
      var cm = await runHook(info, 'commit-msg', [msgFile], hookEnv, j)
      if (cm.code !== 0) throw hookFailure('commit-msg', cm)
      var finalMsg = cleanMessage((await deps.fs.promises.readFile(msgFile)).toString('utf8'))
      if (!finalMsg) throw fail('empty-message', 'The commit-msg hook left an empty message. Nothing was committed.')
      await deps.fs.promises.writeFile(msgFile, finalMsg)

      setStep(j, 'committing')
      var sign = await git(info.top, ['config', '--bool', '--get', 'commit.gpgSign'])
      var ctArgs = ['commit-tree', tree]
      if (info.head) ctArgs.push('-p', info.head)
      if (sign.stdout.trim() === 'true') ctArgs.push('-S')
      ctArgs.push('-F', msgFile)
      var ct = await git(info.top, ctArgs, { env: plumbingEnv(), timeoutMs: HOOK_MS })
      if (ct.code !== 0) throw fail('git', 'git commit-tree failed: ' + (ct.stderr.trim() || 'exit ' + ct.code))
      var sha = ct.stdout.trim()

      // Compare-and-swap: the branch moves only if it is still where the commit was built.
      var still = await git(info.top, ['symbolic-ref', '-q', 'HEAD'])
      if (still.stdout.trim() !== 'refs/heads/' + info.branch) throw fail('branch-changed', 'The repository switched branches during the commit. Nothing was committed.')
      var subject = firstLine(finalMsg)
      var ur = await git(info.top, ['update-ref', '-m', (info.head ? 'commit: ' : 'commit (initial): ') + subject,
        'refs/heads/' + info.branch, sha, info.head || ''])
      if (ur.code !== 0) throw fail('head-moved', 'HEAD moved while the commit was being made, so the branch was left alone. Reload and try again.')

      setStep(j, 'updating-index')
      var fix = await fixRealIndex(info, info.headTree, tree)

      var post = await runHook(info, 'post-commit', [], childEnv({}), j)
      var result: Record<string, unknown> = {
        sha: sha, shortSha: sha.slice(0, 7), branch: info.branch, subject: subject,
        files: fix.paths, indexUpdated: fix.updated, indexKept: fix.kept,
      }
      if (fix.error) result.indexError = fix.error
      if (post.code !== 0) result.postCommitExit = post.code
      return result
    } finally {
      await deps.fs.promises.rm(tmp, { recursive: true, force: true }).catch(function () { /* best effort */ })
    }
  }

  /**
   * After the branch moved: a real index entry that still equals the old HEAD
   * moves to the committed blob, so `git status` does not show the commit
   * reversed; one the user staged differently is left alone.
   */
  async function fixRealIndex(info: RepoInfo, oldTree: string, newTree: string): Promise<{ paths: number; updated: string[]; kept: string[]; error?: string }> {
    var dt = await git(info.top, ['diff-tree', '-r', '-z', '--no-renames', '--raw', oldTree, newTree])
    var changes: Array<{ path: string; oldMode: string; newMode: string; oldSha: string; newSha: string; status: string }> = []
    var parts = dt.stdout.split('\u0000')
    for (var i = 0; i + 1 < parts.length; i += 2) {
      if (!parts[i] || parts[i].charAt(0) !== ':') continue
      var f = parts[i].slice(1).split(' ')
      changes.push({ path: parts[i + 1], oldMode: f[0], newMode: f[1], oldSha: f[2], newSha: f[3], status: (f[4] || '').charAt(0) })
    }
    var updated: string[] = []
    var kept: string[] = []
    if (changes.length === 0) return { paths: 0, updated: updated, kept: kept }
    var current = new Map<string, Array<{ mode: string; sha: string; stage: string }>>()
    for (var c = 0; c < changes.length; c += 200) {
      var ls = await git(info.top, ['ls-files', '-s', '-z', '--'].concat(changes.slice(c, c + 200).map(function (x) { return x.path })))
      var rows = ls.stdout.split('\u0000')
      for (var r = 0; r < rows.length; r++) {
        var tab = rows[r].indexOf('\t')
        if (tab < 0) continue
        var meta = rows[r].slice(0, tab).split(' ')
        var p = rows[r].slice(tab + 1)
        var list = current.get(p) || []
        list.push({ mode: meta[0], sha: meta[1], stage: meta[2] })
        current.set(p, list)
      }
    }
    var sets: string[] = []
    var removes: string[] = []
    for (var k = 0; k < changes.length; k++) {
      var ch = changes[k]
      var cur = current.get(ch.path)
      if (cur && cur.some(function (e) { return e.stage !== '0' })) { kept.push(ch.path); continue }
      var c0 = cur && cur[0]
      var asOld = ch.status === 'A' ? !c0 : !!c0 && c0.sha === ch.oldSha && c0.mode === ch.oldMode
      if (!asOld) { kept.push(ch.path); continue }
      if (ch.status === 'D') removes.push(ch.path)
      else sets.push(ch.newMode + ' ' + ch.newSha + ' 0\t' + ch.path)
      updated.push(ch.path)
    }
    var error: string | undefined
    if (sets.length) {
      var u = await git(info.top, ['update-index', '-z', '--index-info'], { input: sets.join('\u0000') + '\u0000' })
      if (u.code !== 0) error = firstLine(u.stderr) || 'update-index failed'
    }
    if (removes.length && !error) {
      var d = await git(info.top, ['update-index', '-z', '--force-remove', '--stdin'], { input: removes.join('\u0000') + '\u0000' })
      if (d.code !== 0) error = firstLine(d.stderr) || 'update-index failed'
    }
    if (error) {
      deps.log && deps.log('warn', 'git commit: real index fix-up failed', { repo: info.top, error: error })
      return { paths: changes.length, updated: [], kept: changes.map(function (x) { return x.path }), error: error }
    }
    return { paths: changes.length, updated: updated, kept: kept }
  }

  async function doPush(cmd: Record<string, unknown>, j: { snap: CommitJobSnapshot }): Promise<Record<string, unknown>> {
    setStep(j, 'checking')
    var st = await repoState(String(cmd.repoRoot || ''))
    if ('notRepo' in st) throw fail('not-a-repo', st.notRepo)
    var info = st
    if (!info.branch) throw fail(info.blocked ? info.blocked.code : 'detached', info.blocked ? info.blocked.message : 'HEAD is detached.')
    if (!info.head) throw fail('nothing', 'The branch has no commits yet.')
    if (typeof cmd.branch === 'string' && cmd.branch && cmd.branch !== info.branch) {
      throw fail('branch-changed', 'The repository is now on ' + info.branch + ', not ' + cmd.branch + '. Reload the commit view.')
    }
    var remote = (await git(info.top, ['config', '--get', 'branch.' + info.branch + '.remote'])).stdout.trim()
    var merge = (await git(info.top, ['config', '--get', 'branch.' + info.branch + '.merge'])).stdout.trim()
    var args: string[]
    var target: { remote: string; ref: string }
    if (remote && merge && remote !== '.') {
      target = { remote: remote, ref: merge }
      // Explicit refspec, no '+': a non-fast-forward is refused by git itself.
      args = ['push', '--porcelain', remote, 'refs/heads/' + info.branch + ':' + merge]
    } else {
      if (cmd.setUpstream !== true) throw fail('no-upstream', 'The branch has no upstream yet.')
      var origin = await git(info.top, ['remote', 'get-url', '--push', 'origin'])
      if (origin.code !== 0) throw fail('no-remote', 'This repository has no remote named origin.')
      target = { remote: 'origin', ref: 'refs/heads/' + info.branch }
      args = ['push', '--porcelain', '--set-upstream', 'origin', 'refs/heads/' + info.branch + ':refs/heads/' + info.branch]
    }
    setStep(j, 'pushing')
    var r = await run(['git'].concat(args), {
      cwd: info.top, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }), timeoutMs: PUSH_MS, group: true,
      onData: function (chunk) { appendOutput(j, chunk) },
    })
    if (r.timedOut) throw fail('push-timeout', 'The push did not finish in ' + Math.round(PUSH_MS / 60000) + ' minutes.')
    if (r.code !== 0) {
      var rejected = /\[rejected\]|non-fast-forward|fetch first/i.test(r.stdout + r.stderr)
      throw fail(rejected ? 'push-rejected' : 'push-failed', rejected
        ? 'The remote has commits this branch does not have. Pull (or rebase) first; Walnut never force-pushes.'
        : 'The push failed (exit ' + r.code + ').')
    }
    var url = await git(info.top, ['remote', 'get-url', '--push', target.remote])
    return { remote: target.remote, ref: target.ref, url: redactUrl(url.stdout.trim()), branch: info.branch, sha: info.head, upToDate: /\[up to date\]/.test(r.stdout) }
  }

  async function doPr(cmd: Record<string, unknown>, j: { snap: CommitJobSnapshot }): Promise<Record<string, unknown>> {
    setStep(j, 'checking')
    var st = await repoState(String(cmd.repoRoot || ''))
    if ('notRepo' in st) throw fail('not-a-repo', st.notRepo)
    var info = st
    if (!info.branch) throw fail('detached', 'HEAD is detached.')
    var ri = await remoteInfo(info)
    if (!ri.pr.available) throw fail(ri.pr.reason || 'no-pr', ri.pr.reason === 'no-gh' ? 'The GitHub CLI (gh) is not installed on this host.' : 'The remote is not on GitHub.')
    var gh = (await onPath('gh')) as string
    var title = typeof cmd.title === 'string' ? cmd.title.trim() : ''
    if (!title) throw fail('bad-request', 'A pull request needs a title.')
    var body = typeof cmd.body === 'string' ? cmd.body : ''
    var args = ['pr', 'create', '--head', info.branch, '--title', title, '--body', body]
    if (typeof cmd.base === 'string' && cmd.base) args.push('--base', cmd.base)
    setStep(j, 'creating-pr')
    var r = await run([gh].concat(args), {
      cwd: info.top, env: childEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }), timeoutMs: PR_MS, group: true,
      onData: function (chunk) { appendOutput(j, chunk) },
    })
    var urlMatch = /https?:\/\/\S+/.exec(r.stdout) || /https?:\/\/\S+\/pull\/\d+/.exec(r.stderr)
    if (r.code !== 0) {
      if (urlMatch && /already exists/i.test(r.stderr)) return { url: urlMatch[0], existed: true, branch: info.branch }
      if (r.timedOut) throw fail('pr-timeout', 'gh did not finish in ' + Math.round(PR_MS / 60000) + ' minutes.')
      throw fail('pr-failed', 'gh pr create failed: ' + (firstLine(r.stderr) || 'exit ' + r.code))
    }
    return { url: urlMatch ? urlMatch[0] : '', existed: false, branch: info.branch }
  }

  /** Start a commit/push/pr job. Throws (busy, bad action) before anything runs. */
  function start(cmd: Record<string, unknown>): { job: CommitJobSnapshot; done: Promise<void> } {
    var kind = cmd.action
    if (kind !== 'commit' && kind !== 'push' && kind !== 'pr') throw fail('bad-request', 'Unknown action.')
    var root = typeof cmd.repoRoot === 'string' ? cmd.repoRoot : ''
    if (!root || !deps.path.isAbsolute(root)) throw fail('bad-request', 'A repository path is required.')
    if (busy.has(root)) throw fail('busy', 'Another commit or push is running in this repository.')
    var t = now()
    var j = { snap: { id: 'gc-' + randomId(), kind: kind, repoRoot: root, state: 'running', step: 'queued', startedAt: t, updatedAt: t, output: '' } as CommitJobSnapshot }
    jobs.set(j.snap.id, j)
    busy.set(root, j.snap.id)
    var work = kind === 'commit' ? doCommit(cmd, j) : kind === 'push' ? doPush(cmd, j) : doPr(cmd, j)
    var done = work.then(function (result) {
      j.snap.state = 'succeeded'
      j.snap.result = result
    }, function (err: Error & { code?: string }) {
      j.snap.state = 'failed'
      j.snap.error = { code: err && err.code ? String(err.code) : 'failed', message: err && err.message ? err.message : String(err) }
      deps.log && deps.log('warn', 'git commit job failed', { job: j.snap.id, kind: kind, repo: root, code: j.snap.error.code, message: j.snap.error.message })
    }).then(function () {
      j.snap.finishedAt = now()
      j.snap.updatedAt = j.snap.finishedAt
      busy.delete(root)
      prune()
    })
    return { job: snapshot(j), done: done }
  }

  function job(id: unknown): CommitJobSnapshot | null {
    var j = typeof id === 'string' ? jobs.get(id) : undefined
    return j ? snapshot(j) : null
  }

  return { plan: plan, start: start, job: job, cleanMessage: cleanMessage, redactUrl: redactUrl, isGithubUrl: isGithubUrl, safeRel: safeRel }
}
