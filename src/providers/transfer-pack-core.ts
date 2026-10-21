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
  headOnRemote?: boolean
  dirty?: boolean
  untracked?: PackUntracked
  /** null when HEAD is on a remote; `{}` for a full bundle; `{base}` for base..HEAD. */
  bundle?: { base?: string } | null
  // dir only
  tooLarge?: boolean
  /** Bytes of workspace.tgz; a lower bound when tooLarge (the tar was cut there). */
  tarBytes?: number
  /** tar finished with a warning (a file changed or could not be read). */
  tarWarning?: string
}

export interface PackFile { name: string; size: number; sha256: string }
export interface PackReply { outDir: string; meta: PackMeta; files: PackFile[] }

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
  function run(argv: string[], o: { cwd: string; git?: boolean; input?: string | Buffer; timeoutMs?: number; outFile?: string; maxOut?: number }): Promise<RunResult> {
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
        child = deps.spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: childEnv(!!o.git), stdio: ['pipe', 'pipe', 'pipe'] })
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

  function git(cwd: string, args: string[], extra?: { outFile?: string; timeoutMs?: number }): Promise<RunResult> {
    return run(['git'].concat(args), { cwd: cwd, git: true, outFile: extra && extra.outFile, timeoutMs: extra && extra.timeoutMs })
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

  async function packGit(cwd: string, root: string, outDir: string, maxUntracked: number, written: string[]): Promise<PackMeta> {
    var realCwd = await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    var relCwd = deps.path.relative(root, realCwd)
    if (relCwd.indexOf('..') === 0 || deps.path.isAbsolute(relCwd)) relCwd = ''
    var head = text(await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])) || null
    var branch = text(await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'])) || null
    var upstreamFull = head ? text(await git(root, ['rev-parse', '--symbolic-full-name', '@{u}'])) || null : null
    var upstream = upstreamFull ? text(await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) || upstreamFull : null
    var headOnRemote = head ? !!text(await git(root, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes'])) : false
    var tracked = text(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']))
    var meta: PackMeta = {
      kind: 'git', root: root, relCwd: relCwd, branch: branch, head: head,
      remotes: await remotes(root), upstream: upstream, headOnRemote: headOnRemote, dirty: false,
      untracked: { count: 0, bytes: 0, skipped: [] }, bundle: null, createdAt: '',
    }
    if (!head) meta.noCommits = true

    if (head) {
      var patchPath = deps.path.join(outDir, 'changes.patch')
      var d = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'], { outFile: patchPath })
      if (d.code !== 0) throw fail('git_failed', 'git diff: ' + (d.timedOut ? 'timed out' : lastLine(d.stderr)))
      if (d.outBytes > 0) written.push('changes.patch')
      else await deps.fs.promises.unlink(patchPath).catch(function () { /* already gone */ })
    }

    var u = await untrackedFiles(root, !head)
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
    meta.dirty = !!tracked || u.files.length > 0

    if (head && !headOnRemote) {
      var base = await bundleBase(root, upstreamFull && upstreamFull.indexOf('refs/remotes/') === 0 ? upstreamFull : null)
      var args = ['bundle', 'create', deps.path.join(outDir, 'repo.bundle')]
      if (base) args.push('^' + base)
      args.push('HEAD')
      if (branch) args.push('refs/heads/' + branch)
      var b = await git(root, args)
      if (b.code !== 0) throw fail('git_failed', 'git bundle: ' + (b.timedOut ? 'timed out' : lastLine(b.stderr)))
      written.push('repo.bundle')
      meta.bundle = base ? { base: base } : {}
    }
    return meta
  }

  async function packDir(cwd: string, outDir: string, maxTar: number, written: string[]): Promise<PackMeta> {
    var root = await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    var meta: PackMeta = { kind: 'dir', root: root, relCwd: '', createdAt: '' }
    var tarPath = deps.path.join(outDir, 'workspace.tgz')
    var argv = ['tar', '-cz', '-f', '-']
    DIR_EXCLUDES.forEach(function (x) { argv.push('--exclude=' + x) })
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

  async function pack(cmd: Record<string, unknown>): Promise<PackReply> {
    var cwd = localPath(cmd.cwd, 'cwd')
    var outDir = localPath(cmd.outDir, 'outDir')
    var st = await deps.fs.promises.stat(cwd).then(function (s) { return s }, function () { return null })
    if (!st || !st.isDirectory()) throw fail('not_found', 'cwd is not a folder: ' + cwd)
    var maxUntracked = posInt(cmd.maxUntrackedBytes, 50 * 1024 * 1024)
    var maxTar = posInt(cmd.maxTarBytes, 200 * 1024 * 1024)
    var top = text(await git(cwd, ['rev-parse', '--show-toplevel']))
    var root = top ? deps.path.resolve(top) : await deps.fs.promises.realpath(cwd).then(function (p) { return p }, function () { return cwd })
    await deps.fs.promises.mkdir(outDir, { recursive: true })
    var realOut = await deps.fs.promises.realpath(outDir)
    if (inside(realOut, root) || inside(outDir, root)) throw fail('bad_request', 'outDir must lie outside the workspace ' + root)
    for (var i = 0; i < NAMES.length; i++) await deps.fs.promises.unlink(deps.path.join(outDir, NAMES[i])).catch(function () { /* none */ })
    var written: string[] = []
    var meta = top ? await packGit(cwd, root, outDir, maxUntracked, written) : await packDir(cwd, outDir, maxTar, written)
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

  return { pack: pack }
}
