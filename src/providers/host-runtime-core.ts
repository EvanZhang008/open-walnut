/**
 * Host runtime discovery, shared by both daemon twins: which PATH the daemon runs
 * with, whether `claude` is installed, whether it is the npm build that needs
 * Node.js, and where a node that actually RUNS lives (an AL2-class host keeps
 * nvm nodes that die with "GLIBC_2.27 not found", so presence is not enough).
 *
 * How each consumer gets it:
 *   - daemon-standalone.ts (bun binary) and session-io.ts import it normally.
 *   - daemon-source.ts cannot import: it inlines `createHostRuntime.toString()`
 *     through the `__CREATE_HOST_RUNTIME__` placeholder, like the fold functions.
 *     So the factory body must reference NOTHING at module scope: every helper
 *     lives inside it and every capability (fs, exec, env) is passed in `deps`.
 *     Constructing it must stay side-effect free (the module-level exports below
 *     build one with no deps just to read its pure methods).
 */

import type {
  ClaudeKind, ClaudeProbe, EnsureClaudeResult, HostPreflightResult, HostRuntimeDeps,
} from './host-runtime-types.js'

// Types and the shell snippet live in host-runtime-types.ts; this module stays their import path.
export { NODE_DISCOVERY_SHELL } from './host-runtime-types.js'
export type { ClaudeKind, ClaudeProbe, EnsureClaudeResult, HostPreflightResult, HostRuntimeDeps }

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createHostRuntime(deps: HostRuntimeDeps) {
  var INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
  var messages = {
    install: INSTALL,
    // Word for word what host-readiness-problems.ts claudeMissingMessage /
    // claudeNeedsNodeMessage say for a host called "this host" (the daemon never
    // knows the label; the server swaps in the label by code, see
    // remote-session-manager.ts spawnGateSentence). The install command rides
    // the readiness problem's `commands`, not the sentence.
    claudeMissing: 'Claude Code is not installed on this host.',
    claudeNeedsNode: 'Claude Code on this host is the npm build and no working Node.js was found.'
      + ' Install the native build, which needs no Node.',
  }
  var LOGIN_MARK = '__WALNUT_LOGIN_PATH__='
  var nodeCache: { key: string; path: string; dir: string | null; version: string } | null = null

  function now(): number { return deps.now ? deps.now() : Date.now() }
  function home(): string { return deps.env.HOME || '/root' }
  function base(p: string): string { var parts = p.split('/'); return parts[parts.length - 1] || '' }

  /** First bytes of a file (latin1) → what it needs to run. */
  function classifyHead(head: string): { kind: ClaudeKind; needsNode: boolean; interpreter?: string } {
    var magic = head.slice(0, 4)
    if (magic === '\x7fELF') return { kind: 'native', needsNode: false }
    var machO = ['\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xce\xfa\xed\xfe', '\xcf\xfa\xed\xfe', '\xca\xfe\xba\xbe']
    if (machO.indexOf(magic) >= 0) return { kind: 'native', needsNode: false }
    if (head.slice(0, 2) !== '#!') return { kind: 'unknown', needsNode: false }
    var nl = head.indexOf('\n')
    var tokens = head.slice(2, nl < 0 ? head.length : nl).trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) return { kind: 'unknown', needsNode: false }
    var isNode = function (t: string) { var b = base(t); return b === 'node' || b === 'nodejs' }
    if (base(tokens[0]) === 'env') {
      // `env [-S] [VAR=val ...] node [flags]`: the program is the first plain word.
      for (var i = 1; i < tokens.length; i++) {
        var t = tokens[i]
        if (t.charAt(0) === '-' || t.indexOf('=') > 0) continue
        return isNode(t) ? { kind: 'npm', needsNode: true } : { kind: 'unknown', needsNode: false }
      }
      return { kind: 'unknown', needsNode: false }
    }
    if (isNode(tokens[0])) return { kind: 'npm', needsNode: true, interpreter: tokens[0] }
    return { kind: 'unknown', needsNode: false }
  }

  /** Newest first; names that are not versions sort last. */
  function compareVersionsDesc(a: string, b: string): number {
    var pa = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(a)
    var pb = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(b)
    if (!pa || !pb) return pa ? -1 : pb ? 1 : (a < b ? -1 : a > b ? 1 : 0)
    for (var i = 1; i <= 3; i++) {
      var d = Number(pb[i] || 0) - Number(pa[i] || 0)
      if (d) return d
    }
    return 0
  }

  /**
   * Where a runnable node may live, in search order: nvm (newest first), fnm,
   * volta, asdf, then the plain install dirs. Pure given `listDir`.
   */
  function nodeCandidateDirs(homeDir: string, env: Record<string, string | undefined>, listDir: (dir: string) => string[]): string[] {
    var out: string[] = []
    var versionsUnder = function (root: string, suffix: string) {
      var names = listDir(root).slice().sort(compareVersionsDesc)
      for (var i = 0; i < names.length; i++) out.push(root + '/' + names[i] + suffix)
    }
    versionsUnder((env.NVM_DIR || homeDir + '/.nvm') + '/versions/node', '/bin')
    var fnmRoots = [env.FNM_DIR, homeDir + '/.fnm', (env.XDG_DATA_HOME || homeDir + '/.local/share') + '/fnm', homeDir + '/Library/Application Support/fnm']
    for (var f = 0; f < fnmRoots.length; f++) {
      var fr = fnmRoots[f]
      if (fr) versionsUnder(fr + '/node-versions', '/installation/bin')
    }
    var volta = env.VOLTA_HOME || homeDir + '/.volta'
    versionsUnder(volta + '/tools/image/node', '/bin')
    out.push(volta + '/bin')
    var asdf = env.ASDF_DATA_DIR || homeDir + '/.asdf'
    versionsUnder(asdf + '/installs/nodejs', '/bin')
    out.push(asdf + '/shims')
    out.push(homeDir + '/.local/bin', homeDir + '/.npm-global/bin', '/usr/local/bin')
    var seen: Record<string, boolean> = {}
    return out.filter(function (d) { if (seen[d]) return false; seen[d] = true; return true })
  }

  /** The daemon's own fallback dirs. ~/.toolbox/bin leads the FALLBACKS only. */
  function defaultExtraPaths(homeDir: string): string[] {
    return [
      homeDir + '/.toolbox/bin', homeDir + '/.local/bin', homeDir + '/.npm-global/bin',
      homeDir + '/.cargo/bin', homeDir + '/.pyenv/shims', homeDir + '/.bun/bin',
      '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin',
    ]
  }

  /**
   * Daemon PATH = the user's own shell PATH, then our fallbacks, then whatever
   * the daemon inherited, first occurrence wins. The old order put the fallbacks
   * (/usr/local/bin, /usr/bin, ...) ahead of the user's rc PATH, so a node in a
   * system dir beat the one the user's rc chose; the inherited PATH is last
   * because it is whatever shell happened to launch the server.
   */
  function buildDaemonPath(userPath: string, extraPaths: string[], inheritedPath: string): string {
    var all = userPath.split(':').concat(extraPaths, inheritedPath.split(':'))
    var seen: Record<string, boolean> = {}
    var out: string[] = []
    for (var i = 0; i < all.length; i++) {
      var p = all[i]
      if (!p || seen[p]) continue
      seen[p] = true
      out.push(p)
    }
    return out.join(':')
  }

  /** Script for `<shell> -lc`: login files + the interactive rc, then a marked PATH line. */
  function loginShellScript(shellPath: string): string | null {
    var b = base(shellPath)
    if (['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh'].indexOf(b) < 0) return null
    var rc = b === 'zsh' ? '.zshrc' : b === 'bash' ? '.bashrc' : ''
    var source = rc ? '[ -f "$HOME/' + rc + '" ] && . "$HOME/' + rc + '" >/dev/null 2>&1; ' : ''
    return source + 'printf "\\n' + LOGIN_MARK + '%s\\n" "$PATH"'
  }

  function parseLoginShellPath(stdout: string): string | null {
    var lines = stdout.split('\n')
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf(LOGIN_MARK) !== 0) continue
      var v = lines[i].slice(LOGIN_MARK.length).trim()
      return v.indexOf('/') >= 0 ? v : null
    }
    return null
  }

  function isExecutable(p: string): boolean {
    if (!deps.fs) return false
    try {
      if (!deps.fs.statSync(p).isFile()) return false
      deps.fs.accessSync(p, deps.fs.constants.X_OK)
      return true
    } catch { return false }
  }

  function resolveOnPath(cmd: string, pathStr: string): string | null {
    if (cmd.indexOf('/') >= 0) return isExecutable(cmd) ? cmd : null
    var dirs = pathStr.split(':')
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i] && isExecutable(dirs[i] + '/' + cmd)) return dirs[i] + '/' + cmd
    }
    return null
  }

  function listDir(dir: string): string[] {
    try { return deps.fs ? (deps.fs.readdirSync(dir) as string[]) : [] } catch { return [] }
  }

  function readHead(p: string): string {
    if (!deps.fs) return ''
    var fd = -1
    try {
      fd = deps.fs.openSync(p, 'r')
      var buf = Buffer.alloc(256)
      var n = deps.fs.readSync(fd, buf, 0, 256, 0)
      return buf.toString('latin1', 0, n)
    } catch { return '' } finally {
      if (fd >= 0) { try { deps.fs.closeSync(fd) } catch { /* closed */ } }
    }
  }

  /** Capture the user's login-shell PATH from a CLEAN env, so the daemon's own PATH cannot leak into it. */
  function captureLoginShellPathSync(): string | null {
    var shell = deps.env.SHELL
    if (!shell || !deps.execFileSync || !isExecutable(shell)) return null
    var script = loginShellScript(shell)
    if (!script) return null
    var clean: Record<string, string> = { PATH: '/usr/bin:/bin', TERM: 'dumb' }
    var keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']
    for (var i = 0; i < keep.length; i++) { var v = deps.env[keep[i]]; if (v) clean[keep[i]] = v }
    var out = ''
    try {
      out = String(deps.execFileSync(shell, ['-lc', script], {
        env: clean, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
      }))
    } catch (e) { out = e && (e as { stdout?: unknown }).stdout ? String((e as { stdout?: unknown }).stdout) : '' }
    return parseLoginShellPath(out)
  }

  /** The previous approach, kept as the fallback: source an rc file in the inherited env. */
  function rcSourcedPathSync(homeDir: string): string | null {
    if (!deps.execFileSync || !deps.fs) return null
    var rcFiles = [homeDir + '/.zshrc', homeDir + '/.bashrc']
    for (var r = 0; r < rcFiles.length; r++) {
      var rc = rcFiles[r]
      if (!deps.fs.existsSync(rc)) continue
      var shells = r === 0 ? ['/bin/zsh', '/usr/bin/zsh', '/bin/bash'] : ['/bin/bash', '/bin/sh']
      for (var s = 0; s < shells.length; s++) {
        if (!deps.fs.existsSync(shells[s])) continue
        try {
          var res = String(deps.execFileSync(shells[s], ['-c', 'source ' + JSON.stringify(rc) + ' 2>/dev/null; echo "$PATH"'], {
            env: deps.env, encoding: 'utf-8', timeout: 5000,
          })).trim()
          if (res && res.indexOf('/') >= 0 && res.length > 20) return res
        } catch { continue }
      }
    }
    return null
  }

  /**
   * PATH the daemon should run with, plus where the user part came from (for the
   * boot log). Decision: a session sees the PATH the user's own terminal sees.
   * Trade-off: ~/.toolbox/bin no longer beats a user rc that puts ~/.local/bin
   * first, so a not-logged-in ~/.local/bin/claude can win there, exactly as it
   * would in that user's terminal.
   */
  function computeDaemonPath(): { path: string; source: 'login-shell' | 'rc' | 'none' } {
    var h = home()
    var login = captureLoginShellPathSync()
    var source: 'login-shell' | 'rc' | 'none' = 'login-shell'
    if (!login) { login = rcSourcedPathSync(h); source = login ? 'rc' : 'none' }
    var guarded = testGuardedPath(h)
    if (guarded && guarded.pinned) return { path: buildDaemonPath(guarded.path, [], ''), source: source }
    if (guarded) return { path: buildDaemonPath(guarded.path, defaultExtraPaths(h), login || ''), source: source }
    return { path: buildDaemonPath(login || '', defaultExtraPaths(h), deps.env.PATH || ''), source: source }
  }

  /**
   * A daemon a test started (WALNUT_TEST_EXEC_GUARD, set only by the test
   * harness's tests/setup/exec-guard.ts) runs what the test controls first: the
   * PATH entries it put ahead of the guard, then the bins under its HOME (always
   * a fake one there, where twin tests keep their mock claude), then the
   * harness's refusing claude/ssh dir, and only then the machine (the rest of
   * the inherited PATH, the login shell's, the system dirs). So neither
   * /usr/bin/ssh nor a real claude on the login PATH can run. A test that pinned
   * a PATH without the guard (`PATH: '/usr/bin:/bin'`, a host with no claude)
   * gets exactly that plus its HOME's bins (`pinned`): nothing of the machine's,
   * where a real claude could sit. Null outside the harness, which changes
   * nothing there.
   */
  function testGuardedPath(homeDir: string): { path: string; pinned: boolean } | null {
    var guard = deps.env.WALNUT_TEST_EXEC_GUARD
    if (!guard) return null
    var inherited = (deps.env.PATH || '').split(':').filter(function (d) { return !!d })
    var at = inherited.indexOf(guard)
    var homeBins = defaultExtraPaths(homeDir).filter(function (d) { return d.indexOf(homeDir + '/') === 0 })
    if (at < 0) return { path: inherited.concat(homeBins).join(':'), pinned: true }
    return { path: inherited.slice(0, at).concat(homeBins, [guard], inherited.slice(at + 1)).join(':'), pinned: false }
  }

  /**
   * The harness's refusing claude is no install. A readiness check that found it
   * answers "not installed", as on CI, instead of running it for a version; a
   * session start still runs it, and the guard fails that test.
   */
  function isTestGuardStub(p: string | undefined): boolean {
    var guard = deps.env.WALNUT_TEST_EXEC_GUARD
    return !!guard && !!p && p.slice(0, p.lastIndexOf('/')) === guard
  }

  function run(file: string, args: string[], timeoutMs: number, prefixDir?: string | null): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise(function (resolve) {
      if (!deps.execFile) return resolve({ code: -1, stdout: '', stderr: 'exec unavailable', timedOut: false })
      var env: Record<string, string | undefined> = Object.assign({}, deps.env)
      if (prefixDir) env.PATH = prefixDir + ':' + (deps.env.PATH || '')
      try {
        deps.execFile(file, args, {
          timeout: Math.max(1, timeoutMs), env: env, encoding: 'utf-8', maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
        }, function (err, stdout, stderr) {
          var code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
          resolve({ code: code, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && (err.killed || err.signal === 'SIGKILL')) })
        })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String((e as Error).message || e), timedOut: false })
      }
    })
  }

  async function nodeRuns(nodePath: string, deadline: number): Promise<string | null> {
    var left = Math.min(5000, deadline - now())
    if (left <= 0) return null
    var r = await run(nodePath, ['-v'], left)
    var m = /v\d+\.\d+\.\d+\S*/.exec(r.stdout)
    return r.code === 0 && m ? m[0] : null
  }

  /**
   * A node that RUNS. dir = the directory to prepend to PATH, or null when the
   * PATH (or an absolute shebang) already reaches it. Only a success is cached:
   * a host where the user installs node after a failure must see it next time.
   */
  async function findNode(pathStr: string, interpreter: string | undefined, deadline: number): Promise<{ path: string; dir: string | null; version: string } | null> {
    var key = pathStr + '\0' + (interpreter || '')
    if (nodeCache && nodeCache.key === key && isExecutable(nodeCache.path)) return nodeCache
    var hit: { path: string; dir: string | null; version: string } | null = null
    if (interpreter && interpreter.charAt(0) === '/') {
      var iv = isExecutable(interpreter) ? await nodeRuns(interpreter, deadline) : null
      hit = iv ? { path: interpreter, dir: null, version: iv } : null
    } else {
      var onPath = resolveOnPath('node', pathStr)
      var pv = onPath ? await nodeRuns(onPath, deadline) : null
      if (onPath && pv) hit = { path: onPath, dir: null, version: pv }
      var dirs = hit ? [] : nodeCandidateDirs(home(), deps.env, listDir)
      for (var i = 0; i < dirs.length && now() < deadline; i++) {
        var cand = dirs[i] + '/node'
        if (cand === onPath || !isExecutable(cand)) continue
        var cv = await nodeRuns(cand, deadline)
        if (cv) { hit = { path: cand, dir: dirs[i], version: cv }; break }
      }
    }
    if (hit) nodeCache = { key: key, path: hit.path, dir: hit.dir, version: hit.version }
    return hit
  }

  /** Everything spawn and preflight need to know about `command` on `pathStr`. */
  async function probeClaude(command: string, pathStr: string, deadline: number): Promise<ClaudeProbe & { nodeDir?: string; fixedInterpreter?: boolean }> {
    var p = resolveOnPath(command, pathStr)
    if (!p) return { found: false }
    var info = classifyHead(readHead(p))
    var out: ClaudeProbe & { nodeDir?: string; fixedInterpreter?: boolean } = { found: true, path: p, kind: info.kind, needsNode: info.needsNode }
    if (info.interpreter) out.fixedInterpreter = true
    if (!info.needsNode) return out
    var node = await findNode(pathStr, info.interpreter, deadline)
    out.nodeFound = !!node
    if (node) {
      out.nodeVersion = node.version
      if (node.dir) out.nodeDir = node.dir
    }
    return out
  }

  /** Spawn gate: answer the exact reason a CLI could not start, before spawning it. */
  async function ensureClaude(command: string, pathStr: string, budgetMs?: number): Promise<EnsureClaudeResult> {
    var probe = await probeClaude(command || 'claude', pathStr, now() + (budgetMs || 10000))
    if (!probe.found) {
      var name = base(command || 'claude')
      return {
        ok: false, code: 'claude_missing',
        message: name === 'claude' ? messages.claudeMissing : 'The Claude Code command "' + command + '" was not found on this host.',
      }
    }
    if (probe.needsNode && !probe.nodeFound) {
      // fixedInterpreter: the shebang names an absolute node, so no PATH (and no
      // spawn shell) can supply another one.
      return probe.fixedInterpreter
        ? { ok: false, code: 'claude_needs_node', message: messages.claudeNeedsNode, fixedInterpreter: true }
        : { ok: false, code: 'claude_needs_node', message: messages.claudeNeedsNode }
    }
    return probe.nodeDir
      ? { ok: true, path: probe.path as string, kind: probe.kind || 'unknown', nodeDir: probe.nodeDir }
      : { ok: true, path: probe.path as string, kind: probe.kind || 'unknown' }
  }

  /**
   * Second opinion from the spawn shell itself (binary twin only): the CLI runs
   * through `$SHELL -c "<preamble>; exec …"`, whose rc files may reach a claude
   * or node the daemon PATH does not. Never fail a spawn that shell could run.
   * `cmdPath`: what `command -v` printed (a path, or a bare name for a function).
   */
  async function shellCanRun(shell: string, preamble: string, command: string, timeoutMs?: number): Promise<{ hasCmd: boolean; hasNode: boolean; cmdPath?: string; timedOut: boolean }> {
    var q = "'" + command.replace(/'/g, "'\\''") + "'"
    var script = preamble + '; __wc=$(command -v ' + q + ' 2>/dev/null) && printf "\\n__WALNUT_HAS_CMD__=%s\\n" "$__wc"; node -v >/dev/null 2>&1 && echo __WALNUT_HAS_NODE__; true'
    var r = await run(shell, ['-c', script], timeoutMs || 8000)
    var m = /__WALNUT_HAS_CMD__=(.*)$/m.exec(r.stdout)
    var out: { hasCmd: boolean; hasNode: boolean; cmdPath?: string; timedOut: boolean } = { hasCmd: !!m, hasNode: r.stdout.indexOf('__WALNUT_HAS_NODE__') >= 0, timedOut: r.timedOut }
    if (m && m[1].trim()) out.cmdPath = m[1].trim()
    return out
  }

  /** The user's own shell: sessions run shell_setup there, and it is often bash syntax that /bin/sh (dash) rejects. */
  function userShell(): string { return deps.env.SHELL && isExecutable(deps.env.SHELL) ? deps.env.SHELL : '/bin/sh' }

  /**
   * The PATH a session sees after the host's `shell_setup` (config.hosts[].shell_setup),
   * run the way session-io.ts buildRemotePreamble runs it: `{ setup; } || true`.
   * Without it a claude that shell_setup puts on PATH reads as missing or old.
   */
  async function shellSetupPath(setup: string, timeoutMs: number): Promise<{ path: string; timedOut: boolean }> {
    var basePath = deps.env.PATH || ''
    if (!setup) return { path: basePath, timedOut: false }
    var script = '{ ' + setup + '; } >/dev/null 2>&1 || true; printf "\\n' + LOGIN_MARK + '%s\\n" "$PATH"'
    var r = await run(userShell(), ['-c', script], timeoutMs)
    return { path: parseLoginShellPath(r.stdout) || basePath, timedOut: r.timedOut }
  }

  /** `claude --version` (directly, or through the spawn shell when only that shell reaches claude or its node). */
  async function claudeVersion(claude: ClaudeProbe, probe: ClaudeProbe & { nodeDir?: string }, viaShell: string, deadline: number): Promise<void> {
    var left = Math.min(5000, deadline - now())
    if (left <= 0) return
    var qp = "'" + String(probe.path).replace(/'/g, "'\\''") + "'"
    var r = viaShell
      ? await run(userShell(), ['-c', viaShell + '; exec ' + qp + ' --version'], left)
      : await run(probe.path as string, ['--version'], left, probe.nodeDir)
    var m = r.code === 0 ? /\d+\.\d+\.\d+\S*/.exec(r.stdout.trim().split('\n')[0] || '') : null
    if (m) claude.version = m[0]
    else if (r.code !== 0 && !r.timedOut) {
      // The line that names the error (node prints source context first,
      // the stack after it), else the last line of output.
      var lines = (r.stderr + '\n' + r.stdout).split('\n').map(function (l) { return l.trim() }).filter(Boolean)
      var named = lines.filter(function (l) { return /error/i.test(l) })[0]
      var why = (named || lines[lines.length - 1] || '').slice(0, 200)
      claude.error = 'claude --version exited with code ' + r.code + (why ? ': ' + why : '')
    }
  }

  /** The claude block of host.preflight, asked the way this twin's spawn gate asks. */
  async function preflightClaude(setup: string, floor: string | undefined, deadline: number): Promise<{ claude: ClaudeProbe; pathStr: string }> {
    var sp = await shellSetupPath(setup, 5000)
    var pathStr = sp.path
    var probe = await probeClaude('claude', pathStr, deadline - 5000)
    if (probe.found && isTestGuardStub(probe.path)) probe = { found: false }
    // The spawn preamble plus shell_setup: the environment a session really starts in.
    var viaShell = deps.spawnPreamble ? deps.spawnPreamble() + (setup ? '; { ' + setup + '; } >/dev/null 2>&1 || true' : '') : ''
    var shellRuns = false
    var nodeless = probe.found && probe.needsNode && !probe.nodeFound
    if (viaShell && (!probe.found || (nodeless && !probe.fixedInterpreter))) {
      // The spawn gate never refuses what its shell can run: neither may the readiness it feeds.
      var budget = Math.min(8000, deadline - now() - 4000)
      var seen = budget > 0 ? await shellCanRun(userShell(), viaShell, 'claude', budget) : null
      if (!seen || seen.timedOut) return { claude: { found: false, unknown: 'the login shell did not answer in time' }, pathStr: pathStr }
      if (!probe.found && seen.hasCmd) {
        // A bare name is a shell function or alias: the shell may run it, but there is nothing to inspect.
        if (!seen.cmdPath || seen.cmdPath.charAt(0) !== '/') return { claude: { found: false, unknown: 'claude is a shell function or alias' }, pathStr: pathStr }
        probe = await probeClaude(seen.cmdPath, pathStr, deadline - 5000)
        if (probe.found && isTestGuardStub(probe.path)) probe = { found: false }
        shellRuns = probe.found
      }
      if (probe.found && probe.needsNode && !probe.nodeFound && seen.hasNode) { probe.nodeFound = true; shellRuns = true }
    } else if (!probe.found && sp.timedOut) {
      // A slow shell_setup proves nothing about what it would have put on PATH.
      return { claude: { found: false, unknown: 'shell_setup did not finish in time' }, pathStr: pathStr }
    }
    if (!probe.found) return { claude: { found: false, error: messages.claudeMissing }, pathStr: pathStr }
    var claude: ClaudeProbe = { found: true, path: probe.path, kind: probe.kind, needsNode: probe.needsNode }
    if (probe.needsNode) {
      claude.nodeFound = probe.nodeFound
      if (probe.nodeVersion) claude.nodeVersion = probe.nodeVersion
    }
    if (probe.needsNode && !probe.nodeFound) { claude.error = messages.claudeNeedsNode; return { claude: claude, pathStr: pathStr } }
    await claudeVersion(claude, probe, shellRuns ? viaShell : '', deadline)
    // A claude that starts: is it signed in, and new enough for the model?
    if (deps.claudeCheck && !claude.error) {
      Object.assign(claude, await deps.claudeCheck.check({
        path: probe.path as string, version: claude.version, kind: probe.kind, nodeDir: probe.nodeDir, minVersion: floor, deadline: deadline,
      }))
    }
    return { claude: claude, pathStr: pathStr }
  }

  /**
   * host.preflight: what this host can run. Each probe ≤ 5s, the whole thing ≤ 12s.
   * `minClaudeVersion`: the floor of the model the server is set to use.
   */
  async function preflight(args?: { minClaudeVersion?: unknown; shellSetup?: unknown }): Promise<HostPreflightResult> {
    var deadline = now() + 12000
    var floor = args && typeof args.minClaudeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(args.minClaudeVersion) ? args.minClaudeVersion : undefined
    var setup = args && typeof args.shellSetup === 'string' ? args.shellSetup.trim() : ''
    var found = await preflightClaude(setup, floor, deadline)
    var pathStr = found.pathStr
    var compiler: { found: boolean; name?: string } = { found: false }
    var ccs = ['cc', 'gcc', 'clang']
    for (var i = 0; i < ccs.length; i++) {
      if (resolveOnPath(ccs[i], pathStr)) { compiler = { found: true, name: ccs[i] }; break }
    }
    var dtachPath = isExecutable(home() + '/.local/bin/walnut-dtach') ? home() + '/.local/bin/walnut-dtach' : resolveOnPath('dtach', pathStr)
    var out: HostPreflightResult = { claude: found.claude, compiler: compiler, dtach: dtachPath ? { found: true, path: dtachPath } : { found: false } }
    if (deps.platform) out.platform = deps.platform
    if (deps.arch) out.arch = deps.arch
    return out
  }

  return {
    messages: messages,
    classifyHead: classifyHead,
    compareVersionsDesc: compareVersionsDesc,
    nodeCandidateDirs: nodeCandidateDirs,
    defaultExtraPaths: defaultExtraPaths,
    buildDaemonPath: buildDaemonPath,
    loginShellScript: loginShellScript,
    parseLoginShellPath: parseLoginShellPath,
    computeDaemonPath: computeDaemonPath,
    resolveOnPath: resolveOnPath,
    ensureClaude: ensureClaude,
    probeClaude: probeClaude,
    shellCanRun: shellCanRun,
    preflight: preflight,
  }
}

export type HostRuntime = ReturnType<typeof createHostRuntime>

// Pure methods only: this instance has no fs/exec, so its probes find nothing.
const PURE = createHostRuntime({ env: {} })

export const HOST_RUNTIME_MESSAGES = PURE.messages
export const classifyClaudeHead = PURE.classifyHead
export const nodeCandidateDirs = PURE.nodeCandidateDirs
export const buildDaemonPath = PURE.buildDaemonPath
export const defaultDaemonExtraPaths = PURE.defaultExtraPaths

/**
 * Exit-127 stderr from a shell-wrapped CLI spawn (the binary daemon's
 * `$SHELL -c "…; exec claude"`) → the same precise text the spawn gate gives, or
 * null when the stderr says something else.
 */
export function describeClaudeLaunchFailure(stderr: string): string | null {
  if (/env: ['"\u2018\u2019]?node(js)?['"\u2018\u2019]?: No such file or directory/.test(stderr)) {
    return HOST_RUNTIME_MESSAGES.claudeNeedsNode
  }
  // bash/sh: `exec: claude: not found`, `claude: command not found`;
  // zsh: `command not found: claude`, `no such file or directory: claude`.
  if (/(^|\s|:)claude: (command )?not found|claude: No such file or directory|(command not found|no such file or directory): claude\b/im.test(stderr)) {
    return HOST_RUNTIME_MESSAGES.claudeMissing
  }
  return null
}
