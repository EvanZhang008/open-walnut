/**
 * Host fixes, shared by both daemon twins: the `host.fix` RPC (capability
 * 'hostfix-v1'). After a preflight (host-runtime-core.ts) finds something
 * missing, the server names ONE action and the daemon runs it host-side:
 *
 *   install-claude-native  the official native installer, verified by running
 *                          ~/.local/bin/claude --version afterwards
 *   update-claude          `claude update` on a claude the native installer put
 *                          there (never an npm, Homebrew or wrapper install),
 *                          the installer when the updater itself fails
 *   install-compiler       gcc plus the C library headers through the host's
 *                          package manager, under `sudo -n` (never a prompt)
 *   build-dtach            compile the vendored dtach into ~/.local/bin/walnut-dtach
 *
 * The daemon never runs anything the server did not name: an action is a fixed
 * argv built here, and the only data the server sends is the dtach source text
 * (so the 48KB of base64 lives once, in src/web/terminal/dtach-sources.ts, and
 * neither twin grows). Every action is idempotent (it reports `skipped` when the
 * thing is already there) and one fix runs at a time per daemon (`busy`).
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createHostFix.toString()` through the `__CREATE_HOST_FIX__`
 * placeholder, exactly like createHostRuntime. So the factory body references
 * NOTHING at module scope (the type import below is erased), and constructing
 * it has no side effects.
 */

import type fsType from 'node:fs'
import type { ClaudeProbe } from './host-runtime-core.js'

export type HostFixAction = 'install-claude-native' | 'update-claude' | 'install-compiler' | 'build-dtach'

export interface HostFixResult {
  action: string
  ok: boolean
  /** Tail of what the steps printed, at most 4KB. */
  log: string
  durationMs: number
  /** Short machine-readable reason; the server turns it into a sentence. */
  error?: string
  /** install-compiler: `sudo -n` refused because it wants a password. */
  needsPassword?: boolean
  /** Nothing was run: the thing was already there. */
  skipped?: boolean
  /** What a human can run instead when the fix could not be done. */
  manualCommand?: string
  /** install-claude-native / update-claude: what is installed now. */
  claude?: { path: string; kind: string; version?: string }
  /** install-claude-native 'shadowed': the claude that comes first on PATH. */
  shadowedBy?: string
  /** install-compiler: the package manager that was used. */
  packageManager?: string
  /** build-dtach: where the binary is. */
  path?: string
}

type ExecCallback = (err: (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null, stdout: string | Buffer, stderr: string | Buffer) => void

export interface HostFixDeps {
  execFile?: (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => unknown
  fs?: Pick<typeof fsType, 'mkdtempSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync' | 'rmdirSync' | 'realpathSync'>
  /** Live reference (process.env). */
  env: Record<string, string | undefined>
  os: { platform: () => string; tmpdir: () => string; uid: () => number }
  /** The daemon's host runtime: PATH lookup and claude classification. */
  runtime: {
    resolveOnPath: (cmd: string, pathStr: string) => string | null
    probeClaude: (command: string, pathStr: string, deadline: number) => Promise<ClaudeProbe & { nodeDir?: string }>
  }
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** process.kill; a negative pid is a whole process group. Test seam. */
  kill?: (pid: number, signal: string) => void
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createHostFix(deps: HostFixDeps) {
  var INSTALL_URL = 'https://claude.ai/install.sh'
  var INSTALL_LINE = 'curl -fsSL ' + INSTALL_URL + ' | bash'
  var ACTIONS = ['install-claude-native', 'update-claude', 'install-compiler', 'build-dtach']
  var ACTION_MS: Record<string, number> = { 'install-claude-native': 300000, 'update-claude': 300000, 'install-compiler': 300000, 'build-dtach': 120000 }
  var LOG_TAIL = 4096
  var PACKAGE_MANAGERS = ['dnf', 'yum', 'apt-get', 'apk', 'zypper']
  var DTACH_C = ['attach.c', 'main.c', 'master.c']
  var DTACH_FILES = DTACH_C.concat(['dtach.h', 'config.h'])
  var MAX_SOURCE_B64 = 512 * 1024
  var running: string | null = null

  type Run = { code: number; stdout: string; stderr: string; timedOut: boolean }
  type Result = Omit<HostFixResult, 'action' | 'durationMs' | 'log'> & { log?: string }

  function now(): number { return deps.now ? deps.now() : Date.now() }
  function home(): string { return deps.env.HOME || '/root' }
  function pathStr(): string { return deps.env.PATH || '' }
  function tail(s: string): string { return s.length > LOG_TAIL ? s.slice(s.length - LOG_TAIL) : s }

  /**
   * execFile with a deadline of our own. Every child starts its own process
   * group (detached), and on the deadline the WHOLE group gets SIGTERM, then
   * SIGKILL 5s later: sudo relays the TERM to the package manager, which then
   * releases the dpkg/rpm lock, and an installer's own children (curl, a
   * download) die with it instead of surviving the fix. The promise answers
   * even when nothing calls back (a setuid child the kill cannot reach).
   * Nothing here reads a prompt, so stdin is closed at once.
   */
  function run(file: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string }): Promise<Run> {
    return new Promise(function (resolve) {
      var done = false
      var timedOut = false
      var child: { pid?: number; stdin?: { end: () => void } | null } | undefined
      var timers: Array<ReturnType<typeof setTimeout>> = []
      var finish = function (r: Run) {
        if (done) return
        done = true
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t])
        resolve(r)
      }
      var killGroup = function (signal: string) {
        var pid = child && child.pid
        if (!pid) return
        var kill = deps.kill || function (p: number, sig: string) { process.kill(p, sig as NodeJS.Signals) }
        try { kill(-pid, signal) } catch { try { kill(pid, signal) } catch { /* gone */ } }
      }
      timers.push(setTimeout(function () {
        timedOut = true
        killGroup('SIGTERM')
        timers.push(setTimeout(function () {
          killGroup('SIGKILL')
          timers.push(setTimeout(function () { finish({ code: -1, stdout: '', stderr: 'timed out', timedOut: true }) }, 1000))
        }, 5000))
      }, Math.max(1, opts.timeoutMs)))
      if (!deps.execFile) return finish({ code: -1, stdout: '', stderr: 'exec unavailable', timedOut: false })
      var env: Record<string, string | undefined> = Object.assign({}, deps.env, opts.env || {})
      try {
        child = deps.execFile(file, args, {
          env: env, cwd: opts.cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, detached: true,
        }, function (err, stdout, stderr) {
          var code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
          var errText = err && typeof err.code !== 'number' ? String(err.message || err) : ''
          finish({
            code: code, stdout: String(stdout || ''), stderr: String(stderr || '') + (errText ? '\n' + errText : ''),
            timedOut: timedOut || !!(err && err.killed),
          })
        }) as { pid?: number; stdin?: { end: () => void } | null } | undefined
      } catch (e) {
        return finish({ code: -1, stdout: '', stderr: String((e as Error).message || e), timedOut: false })
      }
      try { if (child && child.stdin) child.stdin.end() } catch { /* already closed */ }
    })
  }

  function transcript(logs: string[], argv: string[], r: Run): void {
    logs.push('$ ' + argv.join(' ') + '\n' + r.stdout + (r.stderr ? '\n' + r.stderr : '') + (r.code !== 0 ? '\n[exit ' + r.code + (r.timedOut ? ', timed out' : '') + ']' : ''))
  }

  function samePath(a: string, b: string): boolean {
    if (a === b) return true
    if (!deps.fs) return false
    try { return deps.fs.realpathSync(a) === deps.fs.realpathSync(b) } catch { return false }
  }

  function findCompiler(): string | null {
    var ccs = ['cc', 'gcc', 'clang']
    for (var i = 0; i < ccs.length; i++) {
      var p = deps.runtime.resolveOnPath(ccs[i], pathStr())
      if (p) return p
    }
    return null
  }

  function removeDir(dir: string, names: string[]): void {
    if (!deps.fs) return
    for (var i = 0; i < names.length; i++) { try { deps.fs.unlinkSync(dir + '/' + names[i]) } catch { /* not written */ } }
    try { deps.fs.rmdirSync(dir) } catch { /* not empty or gone */ }
  }

  // ── install-compiler ──

  /** apt-get never stops on a changed config file: keep the local one, take defaults. */
  var APT_OPTS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']

  /** Package-manager arguments for gcc plus the C library headers dtach needs (the human form). */
  function packageArgs(pm: string): string[] {
    if (pm === 'apt-get') return ['install', '-y', 'gcc', 'libc6-dev']
    if (pm === 'apk') return ['add', 'gcc', 'musl-dev']
    return ['install', '-y', 'gcc', 'glibc-devel']
  }

  /**
   * Why `sudo -n` exited before the package manager ran, or null when the
   * output is the package manager's own. The messages are sudo's (read in the
   * C locale): a password prompt it may not show, or no permission at all.
   */
  function classifySudo(r: { code: number; stdout: string; stderr: string }): 'password' | 'not-allowed' | null {
    if (r.code === 0) return null
    var text = r.stderr + '\n' + r.stdout
    if (/^sudo: (a password is required|a terminal is required|no tty present)/im.test(text)) return 'password'
    if (/is not in the sudoers file|is not allowed to (execute|run)|may not run sudo/i.test(text)) return 'not-allowed'
    return null
  }

  /** sudo refused the DEBIAN_FRONTEND=... argument (a rule that only names the command). */
  function sudoRefusedEnv(r: { code: number; stdout: string; stderr: string }): boolean {
    return r.code !== 0 && /not allowed to set the following environment variables/i.test(r.stderr + '\n' + r.stdout)
  }

  /** First of dnf, yum, apt-get, apk, zypper that `command -v` finds. */
  async function detectPackageManager(deadline: number): Promise<{ name: string; path: string } | null> {
    for (var i = 0; i < PACKAGE_MANAGERS.length; i++) {
      var pm = PACKAGE_MANAGERS[i]
      var r = await run('/bin/sh', ['-c', 'command -v "$1"', 'sh', pm], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
      var found = r.code === 0 ? r.stdout.trim().split('\n')[0] : ''
      if (found && found.charAt(0) === '/') return { name: pm, path: found }
    }
    return null
  }

  async function installCompiler(deadline: number, logs: string[]): Promise<Result> {
    var platform = deps.os.platform()
    // A Mac's /usr/bin/cc is a stub until the Command Line Tools exist, and
    // installing those opens a GUI dialog: nothing here can do it quietly.
    if (platform === 'darwin') return { ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' }
    if (platform !== 'linux') return { ok: false, error: 'unsupported-os' }
    var existing = findCompiler()
    if (existing) return { ok: true, skipped: true, log: 'compiler already installed: ' + existing }
    var pm = await detectPackageManager(deadline)
    if (!pm) return { ok: false, error: 'no-package-manager', manualCommand: 'sudo yum install -y gcc glibc-devel' }
    var pmArgs = packageArgs(pm.name)
    var manual = 'sudo ' + pm.name + ' ' + pmArgs.join(' ')
    var asRoot = deps.os.uid() === 0
    var sudo = asRoot ? null : deps.runtime.resolveOnPath('sudo', pathStr())
    if (!asRoot && !sudo) return { ok: false, error: 'no-sudo', manualCommand: manual, packageManager: pm.name }
    var apt = pm.name === 'apt-get'
    // sudo resets the environment, so an apt frontend setting rides as a sudo
    // argument; a sudoers rule that only allows the command refuses that, and
    // the next call goes without it.
    var sudoEnv = apt && !asRoot
    var exec = async function (args: string[]): Promise<Run> {
      var cmd = [pm!.path].concat(apt ? APT_OPTS : [], args)
      var argv = asRoot ? cmd : [sudo as string, '-n'].concat(sudoEnv ? ['DEBIAN_FRONTEND=noninteractive'] : [], cmd)
      var r = await run(argv[0], argv.slice(1), { timeoutMs: Math.max(1, deadline - now()), env: { LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' } })
      transcript(logs, argv, r)
      if (sudoEnv && sudoRefusedEnv(r)) { sudoEnv = false; return exec(args) }
      return r
    }
    var r = await exec(pmArgs)
    // A fresh Debian/Ubuntu image ships with no package lists: refresh once.
    if (r.code !== 0 && !r.timedOut && pm.name === 'apt-get' && !classifySudo(r) && /Unable to locate package|has no installation candidate/i.test(r.stdout + r.stderr)) {
      var upd = await exec(['update'])
      if (upd.code === 0) r = await exec(pmArgs)
    }
    var base: Result = { ok: false, manualCommand: manual, packageManager: pm.name }
    if (r.timedOut) return Object.assign(base, { error: 'timeout' })
    if (r.code !== 0) {
      var sudoSays = asRoot ? null : classifySudo(r)
      if (sudoSays === 'password') return Object.assign(base, { error: 'needs-password', needsPassword: true })
      if (sudoSays === 'not-allowed') return Object.assign(base, { error: 'sudo-not-allowed' })
      return Object.assign(base, { error: 'package-manager-failed' })
    }
    var cc = findCompiler()
    if (!cc) return Object.assign(base, { error: 'verify-failed' })
    return { ok: true, packageManager: pm.name }
  }

  // ── install-claude-native ──

  async function claudeVersion(bin: string, nodeDir: string | undefined, deadline: number, logs: string[]): Promise<string | null> {
    var r = await run(bin, ['--version'], { timeoutMs: Math.max(1, Math.min(20000, deadline - now())), env: nodeDir ? { PATH: nodeDir + ':' + pathStr() } : undefined })
    transcript(logs, [bin, '--version'], r)
    var m = r.code === 0 ? /\d+\.\d+\.\d+\S*/.exec(r.stdout) : null
    return m ? m[0] : null
  }

  /** ok when the claude a session would start is the native one at `bin`. */
  async function reportClaude(bin: string, deadline: number, logs: string[], skipped: boolean): Promise<Result> {
    var probe = await deps.runtime.probeClaude(bin, pathStr(), deadline)
    if (!probe.found) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var version = await claudeVersion(bin, probe.nodeDir, deadline, logs)
    if (!version) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var claude = { path: bin, kind: probe.kind || 'unknown', version: version }
    // The spawn gate resolves `claude` on PATH: another one earlier there still wins.
    var first = deps.runtime.resolveOnPath('claude', pathStr())
    if (first && !samePath(first, bin)) {
      var other = await deps.runtime.probeClaude(first, pathStr(), deadline)
      if (other.kind !== 'native') return { ok: false, error: 'shadowed', shadowedBy: first, claude: claude }
    }
    return skipped ? { ok: true, skipped: true, claude: claude } : { ok: true, claude: claude }
  }

  async function installClaudeNative(deadline: number, logs: string[]): Promise<Result> {
    var bin = home() + '/.local/bin/claude'
    var current = await deps.runtime.probeClaude('claude', pathStr(), deadline)
    if (current.found && current.kind === 'native' && current.path) return reportClaude(current.path, deadline, logs, true)
    var local = await deps.runtime.probeClaude(bin, pathStr(), deadline)
    if (local.found && local.kind === 'native') return reportClaude(bin, deadline, logs, true)
    var failed = await runInstaller(deadline, logs)
    return failed || reportClaude(bin, deadline, logs, false)
  }

  /** The official installer, downloaded then run. Null when it succeeded, else why not. */
  async function runInstaller(deadline: number, logs: string[]): Promise<Result | null> {
    var curl = deps.runtime.resolveOnPath('curl', pathStr())
    var wget = curl ? null : deps.runtime.resolveOnPath('wget', pathStr())
    if (!curl && !wget) return { ok: false, error: 'no-downloader', manualCommand: INSTALL_LINE }
    var bash = deps.runtime.resolveOnPath('bash', pathStr())
    if (!bash) return { ok: false, error: 'no-bash', manualCommand: INSTALL_LINE }
    if (!deps.fs) return { ok: false, error: 'internal', log: 'fs unavailable' }
    var dir = deps.fs.mkdtempSync(deps.os.tmpdir().replace(/\/$/, '') + '/walnut-claude-install-')
    var script = dir + '/install.sh'
    try {
      // Download, then run: the same installer as `curl ... | bash`, but a failed
      // download reads as a download failure instead of an empty bash run.
      var dlArgs = curl ? ['-fsSL', '-o', script, INSTALL_URL] : ['-q', '-O', script, INSTALL_URL]
      var dl = await run((curl || wget) as string, dlArgs, { timeoutMs: Math.max(1, Math.min(120000, deadline - now())) })
      transcript(logs, [(curl || wget) as string].concat(dlArgs), dl)
      if (dl.timedOut) return { ok: false, error: 'timeout', manualCommand: INSTALL_LINE }
      if (dl.code !== 0) return { ok: false, error: 'download-failed', manualCommand: INSTALL_LINE }
      var inst = await run(bash, [script], { timeoutMs: Math.max(1, deadline - now()), env: { HOME: home() }, cwd: home() })
      transcript(logs, [bash, script], inst)
      if (inst.timedOut) return { ok: false, error: 'timeout', manualCommand: INSTALL_LINE }
      if (inst.code !== 0) return { ok: false, error: 'installer-failed', manualCommand: INSTALL_LINE }
    } finally {
      removeDir(dir, ['install.sh'])
    }
    return null
  }

  // ── update-claude ──

  /** The CLI's isEnvTruthy. */
  function truthy(v: string | undefined): boolean { return !!v && ['1', 'true', 'yes', 'on'].indexOf(v.trim().toLowerCase()) >= 0 }

  /** have >= need, by major.minor.patch; false when either is not a version. */
  function atLeast(have: string, need: string): boolean {
    var a = /^(\d+)\.(\d+)\.(\d+)/.exec(have)
    var b = /^(\d+)\.(\d+)\.(\d+)/.exec(need)
    if (!a || !b) return false
    for (var i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
    return true
  }

  /** The native installer keeps every version under ~/.local/share/claude/versions/. */
  function isNativeInstall(p: string): boolean {
    var real = p
    try { if (deps.fs) real = deps.fs.realpathSync(p) } catch { return false }
    var roots = [home() + '/.local/share/claude/versions/']
    if (deps.env.XDG_DATA_HOME) roots.push(deps.env.XDG_DATA_HOME.replace(/\/$/, '') + '/claude/versions/')
    for (var i = 0; i < roots.length; i++) if (real.indexOf(roots[i]) === 0) return true
    return false
  }

  /**
   * `claude update` on the claude a session starts, when the native installer
   * put it there: an npm build is the planner's install-claude-native, and a
   * Homebrew install or a wrapper script is never touched.
   * `claude update` answers without a prompt (it defers any consent to the next
   * interactive session); when it fails, the installer runs instead, unless
   * updates were turned off with DISABLE_UPDATES. `minClaudeVersion` is what
   * the server needs: an update that stops short of it is 'still-outdated'.
   */
  async function updateClaude(params: Record<string, unknown>, deadline: number, logs: string[]): Promise<Result> {
    var need = typeof params.minClaudeVersion === 'string' ? params.minClaudeVersion : ''
    var current = await deps.runtime.probeClaude('claude', pathStr(), deadline)
    if (!current.found || !current.path) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var bin = current.path
    if (current.kind !== 'native' || !isNativeInstall(bin)) return { ok: false, error: 'unmanaged-install', log: 'not a native-installer claude: ' + bin }
    var before = await claudeVersion(bin, undefined, deadline, logs)
    if (before && need && atLeast(before, need)) return { ok: true, skipped: true, claude: { path: bin, kind: 'native', version: before } }
    if (truthy(deps.env.DISABLE_UPDATES)) return { ok: false, error: 'updates-disabled', manualCommand: 'claude update' }
    var up = await run(bin, ['update'], { timeoutMs: Math.max(1, Math.min(180000, deadline - now())) })
    transcript(logs, [bin, 'update'], up)
    if (up.timedOut) return { ok: false, error: 'timeout', manualCommand: 'claude update' }
    if (/DISABLE_UPDATES|updates are disabled/i.test(up.stdout + up.stderr)) return { ok: false, error: 'updates-disabled', manualCommand: 'claude update' }
    if (up.code !== 0) {
      var failed = await runInstaller(deadline, logs)
      if (failed) return failed
    }
    var report = await reportClaude(deps.runtime.resolveOnPath('claude', pathStr()) || bin, deadline, logs, false)
    var after = report.claude && report.claude.version
    if (report.ok && after && need && !atLeast(after, need)) {
      return { ok: false, error: 'still-outdated', claude: report.claude, manualCommand: 'claude install latest' }
    }
    if (report.ok && after && before === after) report.skipped = true
    return report
  }

  // ── build-dtach ──

  /**
   * The usage banner, not just the word: a spawn error names the walnut-dtach
   * file too. Same check as DTACH_BANNER in src/web/terminal/dtach-probe-script.ts.
   */
  async function isDtach(p: string, deadline: number): Promise<boolean> {
    var r = await run(p, ['--help'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
    return (r.stdout + r.stderr).toLowerCase().indexOf('dtach - version') >= 0
  }

  /** Exactly the vendored file set, each value plain base64 of a sane size. */
  function validSources(raw: unknown): Record<string, string> | null {
    if (!raw || typeof raw !== 'object') return null
    var src = raw as Record<string, unknown>
    var keys = Object.keys(src)
    if (keys.length !== DTACH_FILES.length) return null
    for (var i = 0; i < DTACH_FILES.length; i++) {
      var v = src[DTACH_FILES[i]]
      if (typeof v !== 'string' || !v || v.length > MAX_SOURCE_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(v)) return null
    }
    return src as Record<string, string>
  }

  async function buildDtach(params: Record<string, unknown>, deadline: number, logs: string[]): Promise<Result> {
    var bin = home() + '/.local/bin/walnut-dtach'
    if (await isDtach(bin, deadline)) return { ok: true, skipped: true, path: bin }
    var sources = validSources(params.sources)
    if (!sources) return { ok: false, error: 'bad-sources' }
    var cc = findCompiler()
    if (!cc) return { ok: false, error: 'no-compiler' }
    // A Mac's /usr/bin/cc exists even without the Command Line Tools, and running
    // it then opens an install dialog on that Mac's screen. `xcode-select -p` asks
    // quietly whether they are there.
    if (deps.os.platform() === 'darwin') {
      var clt = await run('/usr/bin/xcode-select', ['-p'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
      if (clt.code !== 0) return { ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' }
    }
    if (!deps.fs) return { ok: false, error: 'internal', log: 'fs unavailable' }
    var dir = deps.fs.mkdtempSync(deps.os.tmpdir().replace(/\/$/, '') + '/walnut-dtach-build-')
    // Built next to its final path, then renamed: a half-written binary never
    // sits where the terminal probe would trust it, and no EXDEV across mounts.
    var partial = bin + '.' + now() + '.partial'
    try {
      for (var i = 0; i < DTACH_FILES.length; i++) {
        deps.fs.writeFileSync(dir + '/' + DTACH_FILES[i], Buffer.from(sources[DTACH_FILES[i]], 'base64'))
      }
      deps.fs.mkdirSync(home() + '/.local/bin', { recursive: true })
      var args = ['-O2', '-I.', '-o', partial].concat(DTACH_C, ['-lutil'])
      var r = await run(cc, args, { timeoutMs: Math.max(1, deadline - now()), cwd: dir })
      transcript(logs, [cc].concat(args), r)
      if (r.timedOut) return { ok: false, error: 'timeout' }
      if (r.code !== 0) return { ok: false, error: 'build-failed' }
      if (!(await isDtach(partial, deadline))) return { ok: false, error: 'verify-failed' }
      deps.fs.renameSync(partial, bin)
      return { ok: true, path: bin }
    } finally {
      try { deps.fs.unlinkSync(partial) } catch { /* renamed or never built */ }
      removeDir(dir, DTACH_FILES)
    }
  }

  /** host.fix: run ONE named action. Never throws; a refusal is a result. */
  async function fix(action: unknown, params?: Record<string, unknown>): Promise<HostFixResult> {
    var started = now()
    var name = typeof action === 'string' ? action : String(action)
    if (ACTIONS.indexOf(name) < 0) return { action: name, ok: false, error: 'unknown-action', log: '', durationMs: 0 }
    if (running) return { action: name, ok: false, error: 'busy', log: 'another fix is running: ' + running, durationMs: 0 }
    running = name
    var logs: string[] = []
    var deadline = started + ACTION_MS[name]
    var r: Result
    try {
      r = name === 'install-claude-native' ? await installClaudeNative(deadline, logs)
        : name === 'update-claude' ? await updateClaude(params || {}, deadline, logs)
          : name === 'install-compiler' ? await installCompiler(deadline, logs)
            : await buildDtach(params || {}, deadline, logs)
    } catch (e) {
      r = { ok: false, error: 'internal', log: String((e as Error).message || e) }
    } finally {
      running = null
    }
    if (r.log) logs.push(r.log)
    var out: HostFixResult = Object.assign({}, r, { action: name, log: tail(logs.join('\n')), durationMs: now() - started })
    if (deps.log) {
      deps.log(out.ok ? 'info' : 'warn', 'host.fix', {
        action: name, ok: out.ok, error: out.error, skipped: out.skipped, needsPassword: out.needsPassword, durationMs: out.durationMs,
      })
    }
    return out
  }

  return {
    run: fix,
    get running(): string | null { return running },
    packageArgs: packageArgs,
    classifySudo: classifySudo,
    installLine: INSTALL_LINE,
  }
}

export type HostFix = ReturnType<typeof createHostFix>
