/**
 * Host fixes, shared by both daemon twins: the `host.fix` RPC (capability
 * 'hostfix-v1'). After a preflight (host-runtime-core.ts) finds something
 * missing, the server names ONE action and the daemon runs it host-side:
 *
 *   install-claude-native  the native installer's own steps, resumable, else the
 *                          official install.sh (claude-install-core.ts);
 *                          verified by running ~/.local/bin/claude --version
 *   update-claude          `claude update` on a claude the native installer put
 *                          there (never an npm, Homebrew or wrapper install),
 *                          the installer when the updater itself fails
 *   install-compiler       gcc plus the C library headers through the host's
 *                          package manager, under `sudo -n` (never a prompt)
 *   build-dtach            compile the vendored dtach into ~/.local/bin/walnut-dtach
 *                          (dtach-build-core.ts)
 *
 * The daemon never runs anything the server did not name: an action is a fixed
 * argv built here, and the only data the server sends is the dtach source text
 * (so the 48KB of base64 lives once, in src/web/terminal/dtach-sources.ts, and
 * neither twin grows). Every action is idempotent (it reports `skipped` when the
 * thing is already there) and one fix runs at a time per daemon (`busy`).
 * `cancel()` stops the one in flight at once, for a daemon that is stopping.
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createHostFix.toString()` through the `__CREATE_HOST_FIX__`
 * placeholder, exactly like createHostRuntime, and passes the step factories in
 * the same way (`deps.claudeInstall`, `deps.claudeDownload`, `deps.dtachBuild`,
 * each through its own placeholder). So the factory body references
 * NOTHING at module scope (the type imports below are erased), and
 * constructing it has no side effects.
 */

import type fsType from 'node:fs'
import type { ClaudeProbe } from './host-runtime-core.js'
import type { createClaudeInstall } from './claude-install-core.js'
import type { createClaudeDownload } from './claude-download-core.js'
import type { createDtachBuild } from './dtach-build-core.js'

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
  /** Both twins and the in-process fallback pass the whole node fs. */
  fs?: Pick<typeof fsType, 'mkdtempSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync' | 'rmdirSync' | 'realpathSync' | 'statSync' | 'readdirSync' | 'chmodSync'>
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
  /** The pause between download attempts (setTimeout by default). Test seam. */
  sleep?: (ms: number) => Promise<void>
  /** The factories of the steps that live in their own files: the twins import or inline them like this one. */
  claudeInstall: typeof createClaudeInstall
  claudeDownload: typeof createClaudeDownload
  dtachBuild: typeof createDtachBuild
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createHostFix(deps: HostFixDeps) {
  var INSTALL_URL = 'https://claude.ai/install.sh'
  var INSTALL_LINE = 'curl -fsSL ' + INSTALL_URL + ' | bash'
  var ACTIONS = ['install-claude-native', 'update-claude', 'install-compiler', 'build-dtach']
  // 45 minutes for Claude Code: ~330MB takes 44 at 125KB/s (2026-11-03). A cut-off
  // download is kept and the next Install goes on from there (claude-install-core.ts).
  // The asking server's `waitMs` caps each one (fix() below).
  var ACTION_MS: Record<string, number> = { 'install-claude-native': 2700000, 'update-claude': 2700000, 'install-compiler': 300000, 'build-dtach': 120000 }
  var OLD_SERVER_WAIT_MS = 300000
  var LOG_TAIL = 4096
  var PACKAGE_MANAGERS = ['dnf', 'yum', 'apt-get', 'apk', 'zypper']
  var running: string | null = null
  // cancel(): nothing more starts; `active` stops each child running, `wakers` end each wait.
  // Never install-compiler: a package manager killed mid-transaction breaks the host.
  var CANCELLABLE = ['install-claude-native', 'update-claude', 'build-dtach']
  var cancelled = false
  var active: Array<() => void> = []
  var wakers: Array<() => void> = []
  // A test server's isolated daemon on a remote host (WALNUT_INSTALL_HOME, the server's
  // remote-isolation.ts): every install lands in that HOME, never the user's own, and
  // nothing is installed system-wide. A live view of deps.env with HOME swapped and the
  // dirs that would point elsewhere hidden.
  var INSTALL_HOME = deps.env.WALNUT_INSTALL_HOME || ''
  var HIDDEN = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'BUN_INSTALL']
  var hidden = function (k: string | symbol) { return typeof k === 'string' && HIDDEN.indexOf(k) >= 0 }
  var env: Record<string, string | undefined> = !INSTALL_HOME ? deps.env : new Proxy(deps.env, {
    get: function (t, k) { return k === 'HOME' ? INSTALL_HOME : hidden(k) ? undefined : t[k as string] },
    has: function (t, k) { return k === 'HOME' || (!hidden(k) && k in t) },
    ownKeys: function (t) { return Reflect.ownKeys(t).filter(function (k) { return !hidden(k) && k !== 'HOME' }).concat(['HOME']) },
    getOwnPropertyDescriptor: function (t, k) {
      if (k === 'HOME') return { value: INSTALL_HOME, enumerable: true, configurable: true, writable: true }
      return hidden(k) ? undefined : Reflect.getOwnPropertyDescriptor(t, k)
    },
  })

  type Run = { code: number; stdout: string; stderr: string; timedOut: boolean }
  type Result = Omit<HostFixResult, 'action' | 'durationMs' | 'log'> & { log?: string }

  function now(): number { return deps.now ? deps.now() : Date.now() }
  function home(): string { return env.HOME || '/root' }
  function pathStr(): string { return env.PATH || '' }
  function tail(s: string): string { return s.length > LOG_TAIL ? s.slice(s.length - LOG_TAIL) : s }

  /**
   * execFile with a deadline of our own. Every child starts its own process group
   * (detached); on the deadline, or at once on cancel(), the WHOLE group gets SIGTERM,
   * then SIGKILL 5s later: sudo relays the TERM so the package manager releases the
   * dpkg/rpm lock, and an installer's children (curl) die with it. The promise answers
   * even when nothing calls back (a setuid child the kill cannot reach). stdin is closed.
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
        var at = active.indexOf(stop)
        if (at >= 0) active.splice(at, 1)
        resolve(r)
      }
      var killGroup = function (signal: string) {
        var pid = child && child.pid
        // Never 1 or below: -1 is every process this user may signal.
        if (!pid || pid <= 1) return
        var kill = deps.kill || function (p: number, sig: string) { process.kill(p, sig as NodeJS.Signals) }
        try { kill(-pid, signal) } catch { try { kill(pid, signal) } catch { /* gone */ } }
      }
      var stop = function () {
        if (done || timedOut) return
        timedOut = true
        killGroup('SIGTERM')
        timers.push(setTimeout(function () {
          killGroup('SIGKILL')
          timers.push(setTimeout(function () { finish({ code: -1, stdout: '', stderr: 'timed out', timedOut: true }) }, 1000))
        }, 5000))
      }
      if (cancelled) return finish({ code: -1, stdout: '', stderr: 'cancelled', timedOut: true })
      active.push(stop)
      timers.push(setTimeout(stop, Math.max(1, opts.timeoutMs)))
      if (!deps.execFile) return finish({ code: -1, stdout: '', stderr: 'exec unavailable', timedOut: false })
      var childEnv: Record<string, string | undefined> = Object.assign({}, env, opts.env || {})
      try {
        child = deps.execFile(file, args, {
          env: childEnv, cwd: opts.cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, detached: true,
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

  /** `work`, or `onCancel` at once when the fix is cancelled first. */
  function orCancel<T>(work: Promise<T>, onCancel: T): Promise<T> {
    if (cancelled) return Promise.resolve(onCancel)
    return new Promise(function (resolve, reject) {
      var wake = function () { resolve(onCancel) }
      var drop = function () { var at = wakers.indexOf(wake); if (at >= 0) wakers.splice(at, 1) }
      wakers.push(wake)
      work.then(function (v) { drop(); resolve(v) }, function (e) { drop(); reject(e) })
    })
  }

  /** The pause between download attempts; it ends at once on cancel(). */
  function sleep(ms: number): Promise<void> {
    if (cancelled || ms <= 0) return Promise.resolve()
    if (deps.sleep) return orCancel(deps.sleep(ms), undefined)
    var timer: ReturnType<typeof setTimeout> | undefined
    return orCancel(new Promise<void>(function (resolve) { timer = setTimeout(resolve, ms) }), undefined).then(function () { clearTimeout(timer) })
  }

  /** The host runtime's claude probe (its own child, its own timeout); not found once cancelled. */
  function probe(command: string, deadline: number): Promise<ClaudeProbe & { nodeDir?: string }> {
    return cancelled ? Promise.resolve({ found: false }) : orCancel(deps.runtime.probeClaude(command, pathStr(), deadline), { found: false })
  }

  /** Stop the fix in flight now (the daemon is stopping). False when none runs, or it may not be cut. */
  function cancel(): boolean {
    if (!running || CANCELLABLE.indexOf(running) < 0) return false
    cancelled = true
    active.slice().concat(wakers.splice(0, wakers.length)).forEach(function (stop) { stop() })
    return true
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

  // install() answers null when Claude Code got installed, else why not. Every process
  // it starts goes through run(), so cancel() and the deadline reach it.
  var installer = deps.claudeInstall({ fs: deps.fs, env: env, os: deps.os, runtime: deps.runtime, log: deps.log,
    run: run, transcript: transcript, now: now, sleep: sleep, atLeast: atLeast, installUrl: INSTALL_URL, installLine: INSTALL_LINE, download: deps.claudeDownload })

  async function claudeVersion(bin: string, nodeDir: string | undefined, deadline: number, logs: string[]): Promise<string | null> {
    var r = await run(bin, ['--version'], { timeoutMs: Math.max(1, Math.min(20000, deadline - now())), env: nodeDir ? { PATH: nodeDir + ':' + pathStr() } : undefined })
    transcript(logs, [bin, '--version'], r)
    var m = r.code === 0 ? /\d+\.\d+\.\d+\S*/.exec(r.stdout) : null
    return m ? m[0] : null
  }

  /** ok when the claude a session would start is the native one at `bin`. */
  async function reportClaude(bin: string, deadline: number, logs: string[], skipped: boolean): Promise<Result> {
    var found = await probe(bin, deadline)
    if (!found.found) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var version = await claudeVersion(bin, found.nodeDir, deadline, logs)
    if (!version) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var claude = { path: bin, kind: found.kind || 'unknown', version: version }
    // The spawn gate resolves `claude` on PATH: another one earlier there still wins.
    var first = deps.runtime.resolveOnPath('claude', pathStr())
    if (first && !samePath(first, bin)) {
      var other = await probe(first, deadline)
      if (other.kind !== 'native') return { ok: false, error: 'shadowed', shadowedBy: first, claude: claude }
    }
    return skipped ? { ok: true, skipped: true, claude: claude } : { ok: true, claude: claude }
  }

  /**
   * Is this Mac's login keychain locked: true, false (or not a Mac), null for
   * no answer. `claude update` and the installer's `claude install` start the
   * whole CLI, which reads its token from the keychain at start, and with the
   * keychain locked that read asks for its password on the person's screen
   * (2026-11-03, a fleet Mac whose login keychain stayed locked).
   * SecKeychainGetStatus never unlocks; JXA reaches it with no compiler.
   */
  async function keychainLocked(deadline: number): Promise<boolean | null> {
    if (deps.os.platform() !== 'darwin') return false
    // ObjC["import"]: the source twin's injection check refuses any `import(` in this text.
    var js = 'ObjC["import"]("Security"); var kc = Ref(); var st = Ref(); var c = $.SecKeychainCopyDefault(kc);'
      + ' var r = c === 0 ? $.SecKeychainGetStatus(kc[0], st) : c; r === 0 ? "status " + st[0] : "error " + r'
    var r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
    var m = /^status (\d+)\s*$/.exec(r.timedOut || r.code !== 0 ? '' : String(r.stdout))
    // kSecUnlockStateStatus = 1.
    return m ? (Number(m[1]) & 1) === 0 : null
  }

  async function installClaudeNative(params: Record<string, unknown>, deadline: number, logs: string[]): Promise<Result> {
    var need = typeof params.minClaudeVersion === 'string' ? params.minClaudeVersion : ''
    var bin = home() + '/.local/bin/claude'
    var current = await probe('claude', deadline)
    if (current.found && current.kind === 'native' && current.path) return reportClaude(current.path, deadline, logs, true)
    var local = await probe(bin, deadline)
    if (local.found && local.kind === 'native') return reportClaude(bin, deadline, logs, true)
    if (await keychainLocked(deadline) === true) return { ok: false, error: 'keychain-locked', manualCommand: INSTALL_LINE }
    var aside = moveLauncherAside(bin, logs)
    var failed = await installer.install(deadline, logs, need)
    var result = failed || await reportClaude(bin, deadline, logs, false)
    if (aside) {
      if (result.ok) logs.push('the launcher that was there stays as ' + aside + ' (rename it back to undo)')
      else putLauncherBack(aside, bin, logs)
    }
    return result
  }

  /**
   * A launcher at ~/.local/bin/claude that is not the native installer's (an npm
   * build's script, a wrapper) is moved aside before `claude install`, which keeps
   * any file already there: it answered installed while ~/.local/bin/claude stayed
   * the npm script, which then failed for want of node (2026-11-03, CI's fresh
   * Linux dev box; the same with 2.1.312 and --force, checked on a dev box). The
   * moved file's name; null when nothing was there or it is the native one.
   */
  function moveLauncherAside(bin: string, logs: string[]): string | null {
    if (!deps.fs || isNativeInstall(bin)) return null
    var aside = bin + '.walnut-replaced-' + now()
    try {
      deps.fs.renameSync(bin, aside)
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') logs.push('could not move ' + bin + ' aside: ' + String((e as Error).message || e))
      return null
    }
    logs.push('moved the launcher that was at ' + bin + ' (not the native one) to ' + aside)
    return aside
  }

  /** The install did not end with a working native claude: the launcher that was there comes back. */
  function putLauncherBack(aside: string, bin: string, logs: string[]): void {
    try {
      deps.fs!.renameSync(aside, bin)
      logs.push('put the launcher that was there back at ' + bin)
    } catch (e) {
      logs.push('could not put ' + aside + ' back at ' + bin + ': ' + String((e as Error).message || e))
    }
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
    if (env.XDG_DATA_HOME) roots.push(env.XDG_DATA_HOME.replace(/\/$/, '') + '/claude/versions/')
    for (var i = 0; i < roots.length; i++) if (real.indexOf(roots[i]) === 0) return true
    return false
  }

  /**
   * `claude update` on the claude a session starts, when the native installer
   * put it there: an npm build is the planner's install-claude-native, and a
   * Homebrew install or a wrapper script is never touched.
   * `claude update` answers without a prompt (it defers any consent to the next
   * interactive session); when it fails or runs out of time, the installer runs instead, unless
   * updates were turned off with DISABLE_UPDATES. `minClaudeVersion` is what
   * the server needs: an update that stops short of it is 'still-outdated'.
   */
  async function updateClaude(params: Record<string, unknown>, deadline: number, logs: string[]): Promise<Result> {
    var need = typeof params.minClaudeVersion === 'string' ? params.minClaudeVersion : ''
    var current = await probe('claude', deadline)
    if (!current.found || !current.path) return { ok: false, error: 'verify-failed', manualCommand: INSTALL_LINE }
    var bin = current.path
    if (current.kind !== 'native' || !isNativeInstall(bin)) return { ok: false, error: 'unmanaged-install', log: 'not a native-installer claude: ' + bin }
    var before = await claudeVersion(bin, undefined, deadline, logs)
    if (before && need && atLeast(before, need)) return { ok: true, skipped: true, claude: { path: bin, kind: 'native', version: before } }
    if (truthy(env.DISABLE_UPDATES)) return { ok: false, error: 'updates-disabled', manualCommand: 'claude update' }
    if (await keychainLocked(deadline) === true) return { ok: false, error: 'keychain-locked', manualCommand: 'claude update' }
    var up = await run(bin, ['update'], { timeoutMs: Math.max(1, Math.min(180000, deadline - now())) })
    transcript(logs, [bin, 'update'], up)
    if (/DISABLE_UPDATES|updates are disabled/i.test(up.stdout + up.stderr)) return { ok: false, error: 'updates-disabled', manualCommand: 'claude update' }
    // An updater out of its 3 minutes is most often a slow line (it downloads the
    // whole binary itself, with no resume): the resumable installer takes over.
    if (up.code !== 0 || up.timedOut) {
      var failed = await installer.install(deadline, logs, need)
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

  // ── build-dtach (dtach-build-core.ts, on run() like every step) ──

  var dtach = deps.dtachBuild({ fs: deps.fs, env: env, os: deps.os, run: run, transcript: transcript, now: now, findCompiler: findCompiler })

  /** host.fix: run ONE named action. Never throws; a refusal is a result. */
  async function fix(action: unknown, params?: Record<string, unknown>): Promise<HostFixResult> {
    var started = now()
    var name = typeof action === 'string' ? action : String(action)
    if (ACTIONS.indexOf(name) < 0) return { action: name, ok: false, error: 'unknown-action', log: '', durationMs: 0 }
    if (running) return { action: name, ok: false, error: 'busy', log: 'another fix is running: ' + running, durationMs: 0 }
    if (INSTALL_HOME && name === 'install-compiler') {
      return { action: name, ok: false, error: 'isolated', log: 'a test server\'s isolated daemon installs nothing system-wide', durationMs: 0 }
    }
    running = name
    cancelled = false
    wakers.length = 0
    var logs: string[] = []
    // Never past what the asking server waits for: one that names no wait (older than
    // 'waitMs') gives up at 330s, and a fix still running then would answer it busy.
    var wait = params && typeof params.waitMs === 'number' && params.waitMs > 0 ? params.waitMs : OLD_SERVER_WAIT_MS
    var deadline = started + Math.min(ACTION_MS[name], wait)
    var r: Result
    try {
      r = name === 'install-claude-native' ? await installClaudeNative(params || {}, deadline, logs)
        : name === 'update-claude' ? await updateClaude(params || {}, deadline, logs)
          : name === 'install-compiler' ? await installCompiler(deadline, logs)
            : await dtach.buildDtach(params || {}, deadline, logs)
    } catch (e) {
      r = { ok: false, error: 'internal', log: String((e as Error).message || e) }
    } finally {
      running = null
    }
    // What was downloaded stays where the next attempt resumes it.
    if (cancelled && !r.ok) r = Object.assign({}, r, { error: 'cancelled', log: (r.log ? r.log + '\n' : '') + 'stopped: the session daemon is shutting down' })
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
    /** The fix running now is one cancel() stops (a daemon handover need not wait for it). */
    get cancellable(): boolean { return !!running && CANCELLABLE.indexOf(running) >= 0 },
    cancel: cancel,
    packageArgs: packageArgs,
    classifySudo: classifySudo,
    installLine: INSTALL_LINE,
  }
}

export type HostFix = ReturnType<typeof createHostFix>
