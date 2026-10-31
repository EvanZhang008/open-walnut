/**
 * Pack a workspace for a move to another host ('transfer-v1', `transfer.pack`),
 * shared by both daemon twins. Everything runs here, next to the files: async
 * git and tar children with fixed argv and timeouts, never a shell.
 *
 * Into `outDir` (refused when it lies inside the workspace, which would pack itself):
 *   meta.json       always: what the workspace is and how to rebuild it
 *   changes.patch   git: `git diff --binary HEAD` (staged and unstaged), when not empty
 *   untracked.tgz   git: the untracked, not ignored files (every file of a repo with
 *                   no commit yet), unless their total passes maxUntrackedBytes; then
 *                   they are listed in meta.untracked.skipped instead (at most 200)
 *   repo.bundle     git: only when HEAD is on no remote-tracking ref: the commits since
 *                   the merge base with the best remote ref (upstream, origin/HEAD, any),
 *                   or a full bundle of HEAD when there is no remote ref at all
 *   workspace.tgz   not git: the folder without node_modules, .git, .venv, dist, build,
 *                   target, __pycache__; cut and deleted past maxTarBytes (meta.tooLarge)
 *
 * The reply lists each file with its size and a streamed sha256.
 *
 * How each twin gets it: daemon-standalone.ts imports createTransferPack;
 * daemon-source.ts inlines `createTransferPack.toString()` through
 * `__CREATE_TRANSFER_PACK__`. So the factory body references NOTHING at module
 * scope, every capability comes from `deps`, and it carries no backticks.
 */

import type fsType from 'node:fs'
import type pathType from 'node:path'
import type cryptoType from 'node:crypto'

export interface PackChild {
  stdin: { end(data?: unknown): void; on(ev: string, cb: (...a: unknown[]) => void): void } | null
  stdout: { on(ev: string, cb: (b: Buffer) => void): void; pause(): void; resume(): void } | null
  stderr: { on(ev: string, cb: (b: Buffer) => void): void } | null
  on(ev: string, cb: (...a: never[]) => void): void
  kill(sig?: string): boolean
}

export interface TransferPackDeps {
  fs: typeof fsType
  path: typeof pathType
  crypto: typeof cryptoType
  /** child_process.spawn */
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => PackChild
  env: Record<string, string | undefined>
  /** What `~` means on this host (the daemon's HOME_DIR). */
  home: string
  now?: () => number
  timeouts?: { gitMs?: number; tarMs?: number }
}

export interface PackUntracked { count: number; bytes: number; skipped: string[]; skippedCount?: number; nestedRepos?: string[] }

export interface PackMeta {
  kind: 'git' | 'dir'
  root: string
  relCwd: string
  createdAt: string
  // git only
  branch?: string | null
  head?: string | null
  /** A repo with no commit yet: no patch and no bundle, every file is in untracked.tgz. */
  noCommits?: boolean
  remotes?: Array<{ name: string; url: string }>
  upstream?: string | null
  /** The commit identity this repository sets for itself (not the machine's), so the target's
   *  fresh clone, which copies no config, commits under the same one. */
  identity?: { name?: string; email?: string }
  headOnRemote?: boolean
  dirty?: boolean
  untracked?: PackUntracked
  /** null when HEAD is on a remote; `{}` for a full bundle; `{base}` for base..HEAD. */
  bundle?: { base?: string } | null
  /** Every remote is a folder on this host (a `--shared` clone of a local checkout):
   *  the URL that folder's own first remote names, the one another host can clone. */
  upstreamUrl?: string
  /** Commits in repo.bundle (HEAD past its base). */
  ahead?: number
  /** Packed with `paths`: only those files' changes rode; the rest of the checkout's
   *  dirty files belong to someone else and were left (counts, and the first names). */
  limited?: { paths: number; leftOutTracked: number; leftOutUntracked: number; leftOut: string[] }
  // dir only
  tooLarge?: boolean
  /** Bytes of workspace.tgz; a lower bound when tooLarge (the tar was cut there). */
  tarBytes?: number
  /** tar finished with a warning (a file changed or could not be read). */
  tarWarning?: string
}

export interface PackFile { name: string; size: number; sha256: string }
export interface PackReply { outDir: string; meta: PackMeta; files: PackFile[] }

/** `transfer.scan {dir, maxDepth?}` ('task-move-v1'): what a task directory holds. */
export interface ScanReply {
  dir: string
  exists: boolean
  /** Git repositories inside it (a folder holding `.git`), never looked into. */
  repos: Array<{ root: string; rel: string }>
  /** Files outside every repository (build output and dependency folders not counted). */
  loose: { count: number; bytes: number; sample: string[] }
}

/** `transfer.apply` ('task-move-v1'): a pack set up as a working checkout on this host. */
export interface ApplyReply {
  dest: string
  kind: 'git' | 'dir'
  head?: string | null
  branch?: string | null
  /** Where the clone came from: a checkout on this host (`--shared`), or the URL. */
  clonedFrom?: string
  steps: string[]
  untracked?: number
  patched?: boolean
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createTransferPack(deps: TransferPackDeps) {
  var GIT_MS = (deps.timeouts && deps.timeouts.gitMs) || 60000
  var TAR_MS = (deps.timeouts && deps.timeouts.tarMs) || 5 * 60000
  var SKIPPED_CAP = 200
  var NAMES = ['meta.json', 'changes.patch', 'untracked.tgz', 'repo.bundle', 'workspace.tgz']
  var DIR_EXCLUDES = ['node_modules', '.git', '.venv', 'dist', 'build', 'target', '__pycache__']
  // Mirrors GIT_REPO_REDIRECT_VARS in src/lib/git-env.ts: an inherited one outranks cwd.
  var REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']
  var now = deps.now || function () { return Date.now() }

  interface RunResult { code: number; stdout: Buffer; stderr: string; timedOut: boolean; outBytes: number; overLimit: boolean }

  function fail(code: string, message: string): Error {
    var e = new Error(message) as Error & { code?: string }
    e.code = code
    return e
  }

  function childEnv(git: boolean): Record<string, string | undefined> {
    var env: Record<string, string | undefined> = Object.assign({}, deps.env || {})
    if (git) {
      for (var i = 0; i < REDIRECT_VARS.length; i++) delete env[REDIRECT_VARS[i]]
      env.GIT_OPTIONAL_LOCKS = '0'
      env.GIT_TERMINAL_PROMPT = '0'
    }
    // bsdtar on macOS would add AppleDouble `._` members for extended attributes.
    env.COPYFILE_DISABLE = '1'
    env.LC_ALL = 'C'
    return env
  }

  /** One child, its stdout kept in memory or streamed to `outFile` (cut past `maxOut`). */
  function run(argv: string[], o: { cwd: string; git?: boolean; input?: string | Buffer; timeoutMs?: number; outFile?: string; maxOut?: number; env?: Record<string, string> }): Promise<RunResult> {
    return new Promise(function (resolve) {
      var out: Buffer[] = []
      var outBytes = 0
      var errText = ''
      var settled = false
      var timedOut = false
      var overLimit = false
      var sink = o.outFile ? deps.fs.createWriteStream(o.outFile) : null
      var child: PackChild
      var finish = function (code: number) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        var done = function () { resolve({ code: code, stdout: Buffer.concat(out), stderr: errText, timedOut: timedOut, outBytes: outBytes, overLimit: overLimit }) }
        if (sink) sink.end(done)
        else done()
      }
      var stop = function () { try { child.kill('SIGKILL') } catch (_e) { /* gone */ } }
      var timer = setTimeout(function () { timedOut = true; stop(); finish(-1) }, o.timeoutMs || GIT_MS)
      if (sink) sink.on('error', function (e: Error) { errText = errText || String(e.message || e); stop() })
      try {
        child = deps.spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: Object.assign(childEnv(!!o.git), o.env || {}), stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        errText = String((err as Error).message || err)
        finish(-1)
        return
      }
      var stdout = child.stdout
      if (stdout) stdout.on('data', function (b: Buffer) {
        if (overLimit || settled) return
        outBytes += b.length
        if (o.maxOut && outBytes > o.maxOut) { overLimit = true; stop(); return }
        if (!sink) { out.push(b); return }
        if (!sink.write(b) && stdout) {
          stdout.pause()
          sink.once('drain', function () { if (stdout) stdout.resume() })
        }
      })
      if (child.stderr) child.stderr.on('data', function (b: Buffer) { if (errText.length < 256 * 1024) errText += b.toString('utf8') })
      child.on('error', function (e: never) { errText = errText || String((e as unknown as Error).message || e); finish(-1) })
      child.on('close', function (code: never) { finish(typeof code === 'number' ? code : -1) })
      if (child.stdin) {
        child.stdin.on('error', function () { /* the child closed its stdin */ })
        child.stdin.end(o.input != null ? o.input : undefined)
      }
    })
  }

  function git(cwd: string, args: string[], extra?: { outFile?: string; timeoutMs?: number; input?: string; env?: Record<string, string> }): Promise<RunResult> {
    return run(['git'].concat(args), { cwd: cwd, git: true, outFile: extra && extra.outFile, timeoutMs: extra && extra.timeoutMs, input: extra && extra.input, env: extra && extra.env })
  }

  function text(r: RunResult): string { return r.code === 0 ? r.stdout.toString('utf8').trim() : '' }

  function lastLine(s: string): string {
    var lines = String(s || '').split('\n').map(function (l) { return l.trim() }).filter(Boolean)
    var l = lines.length ? lines[lines.length - 1] : ''
    return l.length > 300 ? l.slice(0, 300) : l
  }

  function localPath(p: unknown, what: string): string {
    if (typeof p !== 'string' || !p) throw fail('bad_request', what + ' is required')
    if (p.indexOf('\u0000') >= 0) throw fail('bad_request', what + ' contains a NUL byte')
    var expanded = p === '~' || p.indexOf('~/') === 0 ? deps.home + p.slice(1) : p
    if (!deps.path.isAbsolute(expanded)) throw fail('bad_request', what + ' must be absolute or start with ~/')
    return deps.path.resolve(expanded)
  }

  /** A list of paths relative to the workspace root, or null when absent; never `..` or absolute. */
  function relList(v: unknown, what: string): string[] | null {
    if (v === undefined || v === null) return null
    if (!Array.isArray(v) || v.length > 5000) throw fail('bad_request', what + ' must be a list of at most 5000 relative paths')
    var out: string[] = []
    for (var i = 0; i < v.length; i++) {
      var p = v[i]
      if (typeof p !== 'string' || !p || p.indexOf('\u0000') >= 0 || p.charAt(0) === '/' || p.split('/').indexOf('..') >= 0) {
        throw fail('bad_request', what + ' holds a path that is not relative: ' + String(p).slice(0, 200))
      }
      out.push(p.replace(/^\.\//, '').replace(/\/+$/, ''))
    }
    return out
  }

  function posInt(v: unknown, dflt: number): number {
    return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : dflt
  }

  function inside(child: string, parent: string): boolean {
    var rel = deps.path.relative(parent, child)
    return rel === '' || (rel.indexOf('..') !== 0 && !deps.path.isAbsolute(rel))
  }

  function sha256File(p: string): Promise<string> {
    return new Promise(function (resolve, reject) {
      var h = deps.crypto.createHash('sha256')
      var s = deps.fs.createReadStream(p)
      s.on('data', function (c) { h.update(c as Buffer) })
      s.on('error', reject)
      s.on('end', function () { resolve(h.digest('hex')) })
    })
  }

  /** Credentials never leave the host: `https://user:token@host/x` -> `https://host/x`. */
  function redactUrl(url: string): string {
    return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@\/]+@/i, '$1')
  }

  async function remotes(root: string): Promise<Array<{ name: string; url: string }>> {
    var r = await git(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
    var list: Array<{ name: string; url: string }> = []
    text(r).split('\n').forEach(function (line) {
      var m = /^remote\.(.+)\.url\s+(.*)$/.exec(line.trim())
      if (m) list.push({ name: m[1], url: redactUrl(m[2]) })
    })
    return list
  }

  /** A remote URL that names a folder on this host (`/x`, `~/x`, `file:///x`), as a path; else null. */
  function localRemotePath(url: string): string | null {
    var u = String(url || '')
    if (u.indexOf('file://') === 0) u = u.slice(7)
    if (u === '~' || u.indexOf('~/') === 0) u = deps.home + u.slice(1)
    return u.charAt(0) === '/' ? u : null
  }

  /**
   * Every remote is a folder here (a task directory's `--shared` clone of a shared
   * checkout): its remote-tracking refs are that checkout's local branches, which no
   * other host has. Read that checkout's own remote-tracking tips instead (its objects
   * are this clone's too, through alternates) and the URL it clones from.
   */
  async function deepRemote(list: Array<{ name: string; url: string }>): Promise<{ tips: string[]; url?: string } | null> {
    if (!list.length) return null
    for (var i = 0; i < list.length; i++) if (!localRemotePath(list[i].url)) return null
    for (var j = 0; j < list.length; j++) {
      var dir = localRemotePath(list[j].url) as string
      var refs = text(await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'])).split('\n').filter(Boolean)
      if (!refs.length) continue
      var head = refs.filter(function (l) { return l.indexOf('refs/remotes/origin/HEAD ') === 0 })
      var main = refs.filter(function (l) { return /^refs\/remotes\/origin\/(main|master) /.test(l) })
      var ordered = head.concat(main, refs)
      var tips: string[] = []
      ordered.forEach(function (l) { var sha = l.split(' ')[1]; if (sha && tips.indexOf(sha) < 0) tips.push(sha) })
      var up = await remotes(dir)
      var url = up.filter(function (r) { return !localRemotePath(r.url) })[0]
      return { tips: tips, url: url ? url.url : undefined }
    }
    return null
  }

  /** Files git would carry as untracked (or, with no commit yet, every file), split by size cap. */
  async function untrackedFiles(root: string, noCommits: boolean): Promise<{ files: string[]; bytes: number; nested: string[] }> {
    var args = ['ls-files', '-z', '--others', '--exclude-standard']
    if (noCommits) args.push('--cached')
    var r = await git(root, args)
    if (r.code !== 0) throw fail('git_failed', 'git ls-files: ' + lastLine(r.stderr))
    var names = r.stdout.toString('utf8').split('\u0000').filter(Boolean)
    var seen: Record<string, boolean> = {}
    var files: string[] = []
    var nested: string[] = []
    var bytes = 0
    for (var i = 0; i < names.length; i += 64) {
      var batch = names.slice(i, i + 64)
      var stats = await Promise.all(batch.map(function (n) {
        return deps.fs.promises.lstat(deps.path.join(root, n)).then(function (st) { return st }, function () { return null })
      }))
      for (var j = 0; j < batch.length; j++) {
        var n = batch[j]
        if (seen[n]) continue
        seen[n] = true
        // An untracked repository inside this one is listed as `dir/`: its own repo, not files.
        if (n.charAt(n.length - 1) === '/') { if (nested.length < SKIPPED_CAP) nested.push(n); continue }
        var st = stats[j]
        if (!st || !(st.isFile() || st.isSymbolicLink())) continue
        files.push(n)
        bytes += st.isFile() ? st.size : 0
      }
    }
    return { files: files, bytes: bytes, nested: nested }
  }

  var gnuTar: boolean | null = null
  async function isGnuTar(cwd: string): Promise<boolean> {
    if (gnuTar === null) gnuTar = /GNU tar/.test((await run(['tar', '--version'], { cwd: cwd, timeoutMs: 5000 })).stdout.toString('utf8'))
    return gnuTar
  }

  async function tarList(root: string, outFile: string, files: string[]): Promise<void> {
    // `./` first: GNU tar reads a list line that starts with `-` as an OPTION
    // (`--checkpoint-action=exec=...` is a legal file name), a path never is.
    var list = files.map(function (n) { return './' + n }).join('\u0000') + '\u0000'
    var argv = ['tar', '-czf', outFile, '--null']
    // GNU tar also unquotes backslash escapes in list names; bsdtar does not know the flag.
    if (await isGnuTar(root)) argv.push('--no-unquote')
    argv.push('-T', '-')
    var r = await run(argv, { cwd: root, input: list, timeoutMs: TAR_MS })
    if (r.code !== 0) throw fail('tar_failed', 'tar: ' + (r.timedOut ? 'timed out' : lastLine(r.stderr)))
  }

  /** The ref a bundle can stop at: upstream, else origin/HEAD, else any remote-tracking ref. */
  async function bundleBase(root: string, upstreamRef: string | null): Promise<string | null> {
    var refs = text(await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).split('\n').filter(Boolean)
    if (!refs.length) return null
    var best = upstreamRef && refs.indexOf(upstreamRef) >= 0 ? upstreamRef
      : refs.indexOf('refs/remotes/origin/HEAD') >= 0 ? 'refs/remotes/origin/HEAD' : refs[0]
    return text(await git(root, ['merge-base', 'HEAD', best])) || null
  }

  async function packGit(cwd: string, root: string, outDir: string, maxUntracked: number, written: string[], only: string[] | null): Promise<PackMeta> {
    var realCwd = await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    var relCwd = deps.path.relative(root, realCwd)
    if (relCwd.indexOf('..') === 0 || deps.path.isAbsolute(relCwd)) relCwd = ''
    var head = text(await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])) || null
    var branch = text(await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'])) || null
    var upstreamFull = head ? text(await git(root, ['rev-parse', '--symbolic-full-name', '@{u}'])) || null : null
    var upstream = upstreamFull ? text(await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) || upstreamFull : null
    var remoteList = await remotes(root)
    var deep = head ? await deepRemote(remoteList) : null
    var headOnRemote = head ? !!text(await git(root, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes'])) : false
    if (deep && head) {
      // Measured against the commits another host can get, not the checkout's own branches.
      headOnRemote = false
      for (var t = 0; t < deep.tips.length && !headOnRemote; t++) {
        headOnRemote = (await git(root, ['merge-base', '--is-ancestor', 'HEAD', deep.tips[t]])).code === 0
      }
    }
    var tracked = text(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']))
    var meta: PackMeta = {
      kind: 'git', root: root, relCwd: relCwd, branch: branch, head: head,
      remotes: remoteList, upstream: upstream, headOnRemote: headOnRemote, dirty: false,
      untracked: { count: 0, bytes: 0, skipped: [] }, bundle: null, createdAt: '',
    }
    if (deep && deep.url) meta.upstreamUrl = deep.url
    // Only these paths ride (a shared checkout: the files this task changed there).
    var onlySet: Record<string, boolean> | null = null
    if (only) {
      onlySet = {}
      for (var q = 0; q < only.length; q++) onlySet[only[q]] = true
    }
    var pathspec: string[] = only ? ['--'].concat(only) : []
    if (!head) meta.noCommits = true
    // Only an identity the repository itself sets (its own config, or an includeIf
    // for its directory): the identity git uses outside any repository belongs to
    // this machine, and the target machine has its own.
    var idName = text(await git(root, ['config', '--get', 'user.name']))
    var idEmail = text(await git(root, ['config', '--get', 'user.email']))
    var hostName = text(await git('/', ['config', '--get', 'user.name']))
    var hostEmail = text(await git('/', ['config', '--get', 'user.email']))
    // Field by field: a repository that sets only its email keeps the target's own name.
    if (idName && idName !== hostName) meta.identity = { name: idName }
    if (idEmail && idEmail !== hostEmail) meta.identity = Object.assign(meta.identity || {}, { email: idEmail })

    if (head) {
      var patchPath = deps.path.join(outDir, 'changes.patch')
      var d = only && !only.length
        ? { code: 0, outBytes: 0, timedOut: false, stderr: '' }
        : await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'].concat(pathspec), {
          outFile: patchPath, env: only ? { GIT_LITERAL_PATHSPECS: '1' } : undefined,
        })
      if (d.code !== 0) throw fail('git_failed', 'git diff: ' + (d.timedOut ? 'timed out' : lastLine(d.stderr)))
      if (d.outBytes > 0) written.push('changes.patch')
      else await deps.fs.promises.unlink(patchPath).catch(function () { /* already gone */ })
    }

    var u = await untrackedFiles(root, !head)
    if (onlySet) {
      var set = onlySet
      var changed = text(await git(root, ['diff', '--name-only', '-z', 'HEAD'])).split('\u0000').filter(Boolean)
      var leftTracked = changed.filter(function (n) { return !set[n] })
      var leftUntracked = u.files.filter(function (n) { return !set[n] })
      meta.limited = {
        paths: only!.length, leftOutTracked: leftTracked.length, leftOutUntracked: leftUntracked.length,
        leftOut: leftTracked.concat(leftUntracked).slice(0, 20),
      }
      u = { files: u.files.filter(function (n) { return set[n] }), bytes: 0, nested: u.nested }
      for (var w = 0; w < u.files.length; w++) {
        var stw = await deps.fs.promises.lstat(deps.path.join(root, u.files[w])).then(function (x) { return x }, function () { return null })
        if (stw && stw.isFile()) u.bytes += stw.size
      }
    }
    var untracked: PackUntracked = { count: u.files.length, bytes: u.bytes, skipped: [] }
    if (u.nested.length) untracked.nestedRepos = u.nested
    if (u.files.length && u.bytes > maxUntracked) {
      untracked.skipped = u.files.slice(0, SKIPPED_CAP)
      untracked.skippedCount = u.files.length
    } else if (u.files.length) {
      await tarList(root, deps.path.join(outDir, 'untracked.tgz'), u.files)
      written.push('untracked.tgz')
    }
    meta.untracked = untracked
    meta.dirty = onlySet ? written.indexOf('changes.patch') >= 0 || u.files.length > 0 : !!tracked || u.files.length > 0

    if (head && !headOnRemote) {
      var base: string | null = null
      if (deep) {
        for (var b2 = 0; b2 < deep.tips.length && !base; b2++) base = text(await git(root, ['merge-base', 'HEAD', deep.tips[b2]])) || null
      }
      if (!base) base = await bundleBase(root, upstreamFull && upstreamFull.indexOf('refs/remotes/') === 0 ? upstreamFull : null)
      var args = ['bundle', 'create', deps.path.join(outDir, 'repo.bundle')]
      if (base) args.push('^' + base)
      args.push('HEAD')
      if (branch) args.push('refs/heads/' + branch)
      var b = await git(root, args)
      if (b.code !== 0) throw fail('git_failed', 'git bundle: ' + (b.timedOut ? 'timed out' : lastLine(b.stderr)))
      written.push('repo.bundle')
      meta.bundle = base ? { base: base } : {}
      var ahead = Number(text(await git(root, ['rev-list', '--count', 'HEAD'].concat(base ? ['^' + base] : []))))
      if (isFinite(ahead)) meta.ahead = ahead
    }
    return meta
  }

  async function packDir(cwd: string, outDir: string, maxTar: number, written: string[], exclude: string[]): Promise<PackMeta> {
    var root = await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    var meta: PackMeta = { kind: 'dir', root: root, relCwd: '', createdAt: '' }
    var tarPath = deps.path.join(outDir, 'workspace.tgz')
    var argv = ['tar', '-cz', '-f', '-']
    DIR_EXCLUDES.forEach(function (x) { argv.push('--exclude=' + x) })
    // Anchored to the root: a repository of this folder rides in its own pack.
    exclude.forEach(function (x) { argv.push('--exclude=./' + x) })
    argv.push('.')
    var r = await run(argv, { cwd: root, outFile: tarPath, maxOut: maxTar, timeoutMs: TAR_MS })
    if (r.overLimit) {
      await deps.fs.promises.unlink(tarPath).catch(function () { /* already gone */ })
      meta.tooLarge = true
      meta.tarBytes = r.outBytes
      return meta
    }
    // Exit 1 is "some file changed or could not be read": the archive holds the rest.
    if (r.code !== 0 && r.code !== 1) {
      await deps.fs.promises.unlink(tarPath).catch(function () { /* already gone */ })
      throw fail('tar_failed', 'tar: ' + (r.timedOut ? 'timed out' : lastLine(r.stderr)))
    }
    if (r.code === 1) meta.tarWarning = lastLine(r.stderr) || 'tar exited with code 1'
    meta.tarBytes = r.outBytes
    written.push('workspace.tgz')
    return meta
  }

  /**
   * What a task directory holds ('task-move-v1', `transfer.scan`): every git
   * repository in it (a folder holding `.git`, a worktree's file included), never
   * looked into, and the files outside them. Dependency and build folders are
   * skipped, symlinks are not followed, the walk stops at maxDepth (4) and 20000
   * entries.
   */
  async function scan(cmd: Record<string, unknown>): Promise<ScanReply> {
    var dir = localPath(cmd.dir, 'dir')
    var maxDepth = Math.min(posInt(cmd.maxDepth, 4), 8)
    var out: ScanReply = { dir: dir, exists: false, repos: [], loose: { count: 0, bytes: 0, sample: [] } }
    var st = await deps.fs.promises.stat(dir).then(function (s) { return s }, function () { return null })
    if (!st || !st.isDirectory()) return out
    out.exists = true
    var seen = 0
    async function walk(abs: string, rel: string, depth: number): Promise<void> {
      if (seen > 20000) return
      var names: string[] = await deps.fs.promises.readdir(abs).then(function (n) { return n as string[] }, function () { return [] as string[] })
      if (names.indexOf('.git') >= 0) {
        out.repos.push({ root: abs, rel: rel })
        return
      }
      for (var i = 0; i < names.length; i++) {
        if (++seen > 20000) return
        var name = names[i]
        var childAbs = deps.path.join(abs, name)
        var childRel = rel ? rel + '/' + name : name
        var cst = await deps.fs.promises.lstat(childAbs).then(function (s) { return s }, function () { return null })
        if (!cst || cst.isSymbolicLink()) continue
        if (cst.isDirectory()) {
          if (DIR_EXCLUDES.indexOf(name) >= 0 || depth >= maxDepth) continue
          await walk(childAbs, childRel, depth + 1)
        } else if (cst.isFile()) {
          out.loose.count++
          out.loose.bytes += cst.size
          if (out.loose.sample.length < 20) out.loose.sample.push(childRel)
        }
      }
    }
    await walk(dir, '', 0)
    return out
  }

  /** The folder is missing or empty (a clone may go there). */
  async function emptyOrMissing(dir: string): Promise<boolean> {
    var names = await deps.fs.promises.readdir(dir).then(function (n) { return n as string[] }, function (e: NodeJS.ErrnoException) { return e && e.code === 'ENOENT' ? [] : null })
    return !!names && names.length === 0
  }

  function stepFail(step: string, r: RunResult, steps: string[], dest: string): Error {
    var e = fail('apply_failed', step + ': ' + (r.timedOut ? 'timed out' : lastLine(r.stderr) || 'exit ' + r.code)) as Error & { data?: Record<string, unknown> }
    e.data = { step: step, steps: steps, dest: dest }
    return e
  }

  /**
   * Set a pack up as a working checkout at `dest` on this host ('task-move-v1',
   * `transfer.apply {dest, bundleDir, cloneFrom?, url?}`), the same steps the
   * instructions of workspace.ts name, run here so a move needs no session to do it:
   * a plain folder's workspace.tgz unpacks into dest; a repository is cloned into an
   * empty dest (`--shared` from `cloneFrom`, a checkout of it on this host, else from
   * `url`), its commits fetched from repo.bundle (from the remote too when the bundle
   * needs a base the clone lacks), the branch checked out at the packed commit, the
   * source's own identity set, changes.patch applied unstaged and untracked.tgz
   * unpacked. A failed step answers `apply_failed` with the step and what was done.
   */
  async function apply(cmd: Record<string, unknown>): Promise<ApplyReply> {
    var dest = localPath(cmd.dest, 'dest')
    var bundleDir = localPath(cmd.bundleDir, 'bundleDir')
    var CLONE_MS = posInt(cmd.cloneTimeoutMs, 10 * 60000)
    var meta = JSON.parse(await deps.fs.promises.readFile(deps.path.join(bundleDir, 'meta.json'), 'utf8')) as PackMeta
    var has = async function (name: string) {
      return deps.fs.promises.stat(deps.path.join(bundleDir, name)).then(function (s) { return s.isFile() }, function () { return false })
    }
    var steps: string[] = []
    if (inside(dest, bundleDir) || inside(bundleDir, dest)) throw fail('bad_request', 'dest and bundleDir must not hold each other')
    if (meta.kind === 'dir') {
      await deps.fs.promises.mkdir(dest, { recursive: true })
      if (await has('workspace.tgz')) {
        var x = await run(['tar', '-xzf', deps.path.join(bundleDir, 'workspace.tgz'), '--no-same-owner', '-C', dest], { cwd: dest, timeoutMs: TAR_MS })
        if (x.code !== 0) throw stepFail('unpack', x, steps, dest)
        steps.push('unpacked workspace.tgz')
      }
      return { dest: dest, kind: 'dir', steps: steps }
    }
    if (!(await emptyOrMissing(dest))) throw fail('dest_not_empty', 'dest is not an empty folder: ' + dest)
    await deps.fs.promises.mkdir(deps.path.dirname(dest), { recursive: true })
    var cloneFrom = typeof cmd.cloneFrom === 'string' && cmd.cloneFrom ? localPath(cmd.cloneFrom, 'cloneFrom') : null
    var url = typeof cmd.url === 'string' && cmd.url ? String(cmd.url) : ''
    if (url && (url.charAt(0) === '-' || /[\s\u0000]/.test(url))) throw fail('bad_request', 'url is not a repository address')
    var clonedFrom: string | undefined
    if (meta.noCommits) {
      await deps.fs.promises.mkdir(dest, { recursive: true })
      var init = await git(dest, ['init', '-q'])
      if (init.code !== 0) throw stepFail('init', init, steps, dest)
      steps.push('git init')
    } else {
      var cloned: RunResult | null = null
      if (cloneFrom) {
        cloned = await git(deps.path.dirname(dest), ['clone', '-q', '--shared', '--no-checkout', cloneFrom, dest], { timeoutMs: CLONE_MS })
        if (cloned.code === 0) { clonedFrom = cloneFrom; steps.push('cloned --shared from ' + cloneFrom) }
        else await deps.fs.promises.rm(dest, { recursive: true, force: true }).catch(function () { /* none */ })
      }
      if (!clonedFrom && url) {
        cloned = await git(deps.path.dirname(dest), ['clone', '-q', '--no-checkout', '--', url, dest], { timeoutMs: CLONE_MS })
        if (cloned.code === 0) { clonedFrom = url; steps.push('cloned ' + url) }
      }
      if (!clonedFrom) {
        if (cloned) throw stepFail('clone', cloned, steps, dest)
        throw fail('apply_failed', 'clone: no checkout of this repository on this host and no URL to clone it from')
      }
      // A clone of a checkout here fetches later commits from the real remote.
      if (url && clonedFrom !== url) {
        var su = await git(dest, ['remote', 'set-url', 'origin', url])
        if (su.code === 0) steps.push('origin set to ' + url)
      }
    }
    var headRef = meta.head || ''
    var fetchedOrigin = false
    var fetchOrigin = async function (): Promise<boolean> {
      if (fetchedOrigin || meta.noCommits) return false
      fetchedOrigin = true
      var f = await git(dest, ['fetch', '-q', 'origin'], { timeoutMs: CLONE_MS })
      if (f.code === 0) steps.push('fetched origin')
      return f.code === 0
    }
    if (await has('repo.bundle')) {
      var bundle = deps.path.join(bundleDir, 'repo.bundle')
      var refspec = meta.branch ? '+refs/heads/' + meta.branch + ':refs/walnut-move/head' : '+HEAD:refs/walnut-move/head'
      var fb = await git(dest, ['fetch', '-q', '--no-tags', bundle, refspec], { timeoutMs: CLONE_MS })
      if (fb.code !== 0 && (await fetchOrigin())) fb = await git(dest, ['fetch', '-q', '--no-tags', bundle, refspec], { timeoutMs: CLONE_MS })
      if (fb.code !== 0) throw stepFail('fetch the bundle', fb, steps, dest)
      steps.push('fetched the commits no remote has')
    }
    if (headRef) {
      var known = (await git(dest, ['cat-file', '-e', headRef + '^{commit}'])).code === 0
      if (!known && (await fetchOrigin())) known = (await git(dest, ['cat-file', '-e', headRef + '^{commit}'])).code === 0
      if (!known) throw fail('apply_failed', 'check out: commit ' + headRef + ' is not in the clone or its remote')
      var co = meta.branch
        ? await git(dest, ['checkout', '-q', '-f', '-B', meta.branch, headRef])
        : await git(dest, ['checkout', '-q', '-f', '--detach', headRef])
      if (co.code !== 0) throw stepFail('check out', co, steps, dest)
      await git(dest, ['update-ref', '-d', 'refs/walnut-move/head'])
      steps.push('checked out ' + (meta.branch || headRef.slice(0, 12)) + ' at ' + headRef.slice(0, 12))
      // The branch follows the remote's branch of the same name when there is one.
      if (meta.branch && (await git(dest, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/' + meta.branch])).code === 0) {
        await git(dest, ['branch', '-q', '--set-upstream-to=origin/' + meta.branch, meta.branch])
      }
    }
    if (meta.identity && (meta.identity.name || meta.identity.email)) {
      if (meta.identity.name) await git(dest, ['config', 'user.name', meta.identity.name])
      if (meta.identity.email) await git(dest, ['config', 'user.email', meta.identity.email])
      steps.push('commit identity ' + [meta.identity.name, meta.identity.email].filter(Boolean).join(' '))
    }
    var patched = false
    if (await has('changes.patch')) {
      var patch = deps.path.join(bundleDir, 'changes.patch')
      var ap = await git(dest, ['apply', '--binary', '--whitespace=nowarn', patch])
      if (ap.code !== 0) {
        ap = await git(dest, ['apply', '--3way', '--binary', '--whitespace=nowarn', patch])
        // --3way stages what it applied; the source had these changes unstaged.
        if (ap.code === 0) await git(dest, ['reset', '-q'])
      }
      if (ap.code !== 0) throw stepFail('apply the uncommitted changes', ap, steps, dest)
      patched = true
      steps.push('applied the uncommitted changes')
    }
    var untracked = 0
    if (await has('untracked.tgz')) {
      var ux = await run(['tar', '-xzf', deps.path.join(bundleDir, 'untracked.tgz'), '--no-same-owner', '-C', dest], { cwd: dest, timeoutMs: TAR_MS })
      if (ux.code !== 0) throw stepFail('unpack the untracked files', ux, steps, dest)
      untracked = meta.untracked ? meta.untracked.count : 0
      steps.push('unpacked ' + untracked + ' untracked file' + (untracked === 1 ? '' : 's'))
    }
    var nowHead = text(await git(dest, ['rev-parse', '-q', '--verify', 'HEAD'])) || null
    if (headRef && nowHead !== headRef) throw fail('apply_failed', 'check: HEAD is ' + nowHead + ', the source was at ' + headRef)
    return { dest: dest, kind: 'git', head: nowHead, branch: meta.branch || null, clonedFrom: clonedFrom, steps: steps, untracked: untracked, patched: patched }
  }

  async function pack(cmd: Record<string, unknown>): Promise<PackReply> {
    var cwd = localPath(cmd.cwd, 'cwd')
    var outDir = localPath(cmd.outDir, 'outDir')
    var st = await deps.fs.promises.stat(cwd).then(function (s) { return s }, function () { return null })
    if (!st || !st.isDirectory()) throw fail('not_found', 'cwd is not a folder: ' + cwd)
    var maxUntracked = posInt(cmd.maxUntrackedBytes, 50 * 1024 * 1024)
    var maxTar = posInt(cmd.maxTarBytes, 200 * 1024 * 1024)
    var only = relList(cmd.paths, 'paths')
    var exclude = relList(cmd.exclude, 'exclude') || []
    // A task directory may sit inside a repository (a HOME kept in git): packed as a folder.
    var top = cmd.asDir === true ? '' : text(await git(cwd, ['rev-parse', '--show-toplevel']))
    var root = top ? deps.path.resolve(top) : await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    await deps.fs.promises.mkdir(outDir, { recursive: true })
    var realOut = await deps.fs.promises.realpath(outDir)
    if (inside(realOut, root) || inside(outDir, root)) throw fail('bad_request', 'outDir must lie outside the workspace ' + root)
    for (var i = 0; i < NAMES.length; i++) await deps.fs.promises.unlink(deps.path.join(outDir, NAMES[i])).catch(function () { /* none */ })
    var written: string[] = []
    var meta = top ? await packGit(cwd, root, outDir, maxUntracked, written, only) : await packDir(cwd, outDir, maxTar, written, exclude)
    meta.createdAt = new Date(now()).toISOString()
    await deps.fs.promises.writeFile(deps.path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    written.unshift('meta.json')
    var files: PackFile[] = []
    for (var k = 0; k < written.length; k++) {
      var p = deps.path.join(outDir, written[k])
      var size = (await deps.fs.promises.stat(p)).size
      files.push({ name: written[k], size: size, sha256: await sha256File(p) })
    }
    return { outDir: outDir, meta: meta, files: files }
  }

  return { pack: pack, scan: scan, apply: apply }
}
