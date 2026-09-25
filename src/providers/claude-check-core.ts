/**
 * Claude Code sign-in and version checks for host.preflight, shared by both
 * daemon twins. createHostRuntime's preflight calls `check()` once it knows
 * which claude a session would start and its version.
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createClaudeCheck.toString()` through the `__CREATE_CLAUDE_CHECK__`
 * placeholder, like createHostRuntime. So the factory body references NOTHING
 * at module scope (the type import below is erased), and constructing it has
 * no side effects.
 *
 * Sign-in rule. Read from the CLI's own `claude auth status` handler, and run
 * against the 2.1.240, 2.1.258 and 2.1.280 binaries with an empty
 * CLAUDE_CONFIG_DIR, one provider variable at a time:
 *   1. A CLI at 2.1.41 or newer (the release that added `claude auth`): run
 *      `claude auth status --json`. It starts no session and calls no model: it
 *      reads the CLI's own login state, prints {loggedIn, authMethod,
 *      apiProvider, ...} and exits 0 when signed in, 1 when not. loggedIn means
 *      an OAuth token (the macOS keychain, ~/.claude/.credentials.json
 *      elsewhere), an apiKeyHelper, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 *      CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY,
 *      including values from settings.json `env`. It checks presence, not
 *      validity: a wrong key still reads signed in.
 *      A "not logged in" answer is asked once more through the user's shell with
 *      its rc file sourced, because sessions start that way (the spawn preamble
 *      sources ~/.zshrc or ~/.bashrc) and a provider switch exported there never
 *      reaches the daemon's own env. Only a second "no" is 'not-logged-in'; a
 *      shell pass with no answer (timed out, no time left) is 'unknown'. When
 *      $SHELL is neither zsh nor bash, sessions source no rc file and the
 *      direct answer stands. Every call runs in its own process group and the
 *      cap (4s direct, 6s through the shell) kills the whole group.
 *   2. An older CLI, or no usable answer: presence only. A provider switch or
 *      key variable (daemon env, then settings.json `env` over it, as the CLI
 *      merges them), an `apiKeyHelper`, or <config dir>/.credentials.json reads
 *      'ok'. Anything else is 'unknown', never 'not-logged-in': on macOS the
 *      token lives in the keychain, which this rule does not read.
 * No token or key value is ever read into a result: of the CLI's JSON only
 * loggedIn / authMethod / apiProvider are looked at (its email and org fields
 * are dropped), and variables are only tested for presence.
 */

import type fsType from 'node:fs'

export type ClaudeAuthState = 'ok' | 'not-logged-in' | 'unknown'
/** How the claude a session would start was installed; only 'native' updates itself with `claude update`. */
export type ClaudeInstallMethod = 'native' | 'npm' | 'homebrew' | 'other'

export interface ClaudeCheckResult {
  auth: ClaudeAuthState
  /** How it is signed in ("Bedrock", "a Claude account"), or why the answer is unknown. Never a credential. */
  authDetail?: string
  /** False = older than `minVersion`. Absent when a floor was asked for but the version is unknown. */
  versionOk?: boolean
  minVersion?: string
  installMethod: ClaudeInstallMethod
}

export interface ClaudeCheckInput {
  path: string
  version?: string
  kind?: string
  /** A node dir the npm build needs first on PATH. */
  nodeDir?: string
  minVersion?: string
  /** Absolute ms: every child answers before it. */
  deadline: number
}

type ExecCallback = (err: (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null, stdout: string | Buffer, stderr: string | Buffer) => void

export interface ClaudeCheckDeps {
  fs?: Pick<typeof fsType, 'existsSync' | 'readFileSync' | 'realpathSync' | 'statSync' | 'accessSync' | 'constants'>
  execFile?: (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => unknown
  /** Signals a process group (a negative pid). Defaults to process.kill. */
  kill?: (pid: number, signal: string) => void
  /** Live reference (process.env). */
  env: Record<string, string | undefined>
  now?: () => number
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createClaudeCheck(deps: ClaudeCheckDeps) {
  var AUTH_STATUS_SINCE = '2.1.41'
  var SWITCHES = [['CLAUDE_CODE_USE_BEDROCK', 'Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Vertex AI'], ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry']]
  var KEYS = [['ANTHROPIC_API_KEY', 'an Anthropic API key'], ['ANTHROPIC_AUTH_TOKEN', 'an auth token'], ['CLAUDE_CODE_OAUTH_TOKEN', 'an OAuth token']]
  var METHODS: Record<string, string> = {
    'claude.ai': 'a Claude account', api_key_helper: 'an API key helper', oauth_token: 'an OAuth token', api_key: 'an Anthropic API key',
  }
  var PROVIDERS: Record<string, string> = { bedrock: 'Bedrock', vertex: 'Vertex AI', foundry: 'Microsoft Foundry' }

  type Answer = { state: ClaudeAuthState; detail?: string }

  function now(): number { return deps.now ? deps.now() : Date.now() }
  function home(): string { return deps.env.HOME || '/root' }
  function base(p: string): string { var parts = p.split('/'); return parts[parts.length - 1] || '' }
  /** The CLI's isEnvTruthy. */
  function truthy(v: unknown): boolean { return typeof v === 'string' && ['1', 'true', 'yes', 'on'].indexOf(v.trim().toLowerCase()) >= 0 }

  function parseVersion(v: unknown): number[] | null {
    var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v.trim() : '')
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  /** have >= need; null when either is not a version. Pre-release tags are ignored. */
  function versionAtLeast(have: unknown, need: unknown): boolean | null {
    var a = parseVersion(have)
    var b = parseVersion(need)
    if (!a || !b) return null
    for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
    return true
  }

  /**
   * One child in its own process group (detached), like host-fix-core's run().
   * The cap kills the whole group and answers at once: a wrapper script whose
   * grandchild keeps stdout open would otherwise hold the answer past the cap,
   * because the exec callback waits for the pipe to close. A read-only status
   * call has nothing to clean up, so the kill is SIGKILL with no grace period.
   */
  function run(file: string, args: string[], timeoutMs: number, prefixDir?: string): Promise<{ code: number; stdout: string; timedOut: boolean }> {
    return new Promise(function (resolve) {
      var done = false
      var child: { pid?: number; stdin?: { end: () => void } | null } | undefined
      var timer: ReturnType<typeof setTimeout> | undefined
      var finish = function (r: { code: number; stdout: string; timedOut: boolean }) {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve(r)
      }
      if (!deps.execFile) return finish({ code: -1, stdout: '', timedOut: false })
      var env: Record<string, string | undefined> = Object.assign({}, deps.env)
      if (prefixDir) env.PATH = prefixDir + ':' + (deps.env.PATH || '')
      timer = setTimeout(function () {
        var pid = child && child.pid
        // Never signal pid 0, 1 or a negative one: -1 would reach every process.
        if (typeof pid === 'number' && pid > 1) {
          var kill = deps.kill || function (p: number, sig: string) { process.kill(p, sig as NodeJS.Signals) }
          try { kill(-pid, 'SIGKILL') } catch { try { kill(pid, 'SIGKILL') } catch { /* gone */ } }
        }
        finish({ code: -1, stdout: '', timedOut: true })
      }, Math.max(1, timeoutMs))
      try {
        child = deps.execFile(file, args, {
          env: env, encoding: 'utf-8', maxBuffer: 1024 * 1024, detached: true,
        }, function (err, stdout) {
          var code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
          finish({ code: code, stdout: String(stdout || ''), timedOut: !!(err && (err.killed || err.signal === 'SIGKILL')) })
        }) as { pid?: number; stdin?: { end: () => void } | null } | undefined
      } catch {
        return finish({ code: -1, stdout: '', timedOut: false })
      }
      // Nothing here answers a prompt: an rc file that reads stdin sees EOF.
      try { if (child && child.stdin) child.stdin.end() } catch { /* already closed */ }
    })
  }

  /** `claude auth status --json` output → the answer; null when it is not that JSON. */
  function parseAuthStatus(stdout: string): Answer | null {
    var a = stdout.indexOf('{')
    var b = stdout.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    var j: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown }
    try { j = JSON.parse(stdout.slice(a, b + 1)) } catch { return null }
    if (!j || typeof j.loggedIn !== 'boolean') return null
    if (!j.loggedIn) return { state: 'not-logged-in', detail: 'claude auth status: not logged in' }
    var method = typeof j.authMethod === 'string' ? j.authMethod : ''
    var provider = typeof j.apiProvider === 'string' ? j.apiProvider : ''
    var detail = method === 'third_party' ? (PROVIDERS[provider] || 'a third-party provider') : (METHODS[method] || 'signed in')
    return { state: 'ok', detail: detail }
  }

  function isExecutable(p: string): boolean {
    if (!deps.fs) return false
    try {
      if (!deps.fs.statSync(p).isFile()) return false
      deps.fs.accessSync(p, deps.fs.constants.X_OK)
      return true
    } catch { return false }
  }

  /**
   * The rc file a session's spawn preamble sources, picked by $SHELL the same
   * way (zsh: .zshrc, bash: .bashrc); '' when it sources none.
   */
  function sessionRc(): string {
    var b = base(deps.env.SHELL || '')
    return b === 'zsh' ? '.zshrc' : b === 'bash' ? '.bashrc' : ''
  }

  /** Ask the CLI, directly or through the user's shell with its rc file sourced. */
  async function askCli(input: ClaudeCheckInput, throughShell: boolean): Promise<Answer | null> {
    // The shell pass gets longer: an rc file with a plugin manager and a node
    // version manager takes seconds before claude even starts.
    var left = Math.min(throughShell ? 6000 : 4000, input.deadline - now())
    if (left < 300) return null
    var r
    if (!throughShell) {
      r = await run(input.path, ['auth', 'status', '--json'], left, input.nodeDir)
    } else {
      var shell = deps.env.SHELL || ''
      var rc = sessionRc()
      if (!rc || !isExecutable(shell)) return null
      // The paths ride as $0/$1, never inside the script text.
      var script = '[ -f "$HOME/' + rc + '" ] && . "$HOME/' + rc + '" >/dev/null 2>&1; '
        + (input.nodeDir ? 'PATH="$1:$PATH"; ' : '') + 'exec "$0" auth status --json'
      r = await run(shell, ['-c', script, input.path].concat(input.nodeDir ? [input.nodeDir] : []), left)
    }
    return r.timedOut ? null : parseAuthStatus(r.stdout)
  }

  function readSettings(dir: string): { env: Record<string, unknown>; helper: boolean } {
    var out = { env: {} as Record<string, unknown>, helper: false }
    if (!deps.fs) return out
    try {
      var j = JSON.parse(String(deps.fs.readFileSync(dir + '/settings.json', 'utf8')))
      if (j && j.env && typeof j.env === 'object') out.env = j.env
      out.helper = !!(j && typeof j.apiKeyHelper === 'string' && j.apiKeyHelper.trim())
    } catch { /* absent or not JSON */ }
    return out
  }

  /** Rule 2: presence of a provider switch, a key, a key helper, or the credentials file. */
  function presenceRule(why: string): Answer {
    var dir = (deps.env.CLAUDE_CONFIG_DIR || home() + '/.claude').replace(/\/$/, '')
    var settings = readSettings(dir)
    var merged: Record<string, unknown> = Object.assign({}, deps.env, settings.env)
    for (var i = 0; i < SWITCHES.length; i++) if (truthy(merged[SWITCHES[i][0]])) return { state: 'ok', detail: SWITCHES[i][1] }
    for (var k = 0; k < KEYS.length; k++) {
      var v = merged[KEYS[k][0]]
      if (typeof v === 'string' && v.trim()) return { state: 'ok', detail: KEYS[k][1] }
    }
    if (settings.helper) return { state: 'ok', detail: 'an API key helper' }
    try { if (deps.fs && deps.fs.existsSync(dir + '/.credentials.json')) return { state: 'ok', detail: 'a Claude account' } } catch { /* unreadable */ }
    return { state: 'unknown', detail: why }
  }

  async function authState(input: ClaudeCheckInput): Promise<Answer> {
    var hasCommand = versionAtLeast(input.version, AUTH_STATUS_SINCE)
    if (hasCommand !== true) {
      return presenceRule(hasCommand === false
        ? 'Claude Code ' + input.version + ' cannot report its sign-in (that needs ' + AUTH_STATUS_SINCE + ' or newer)'
        : 'the Claude Code version is unknown, so its sign-in was not asked')
    }
    var direct = await askCli(input, false)
    if (!direct) return presenceRule('claude auth status gave no answer')
    if (direct.state !== 'not-logged-in') return direct
    // Sessions source no rc file under this $SHELL, so they see what the daemon saw.
    if (!sessionRc()) return direct
    // Only a second explicit "no" is 'not-logged-in'. A shell pass that timed
    // out or had no time left proves nothing, and a false "not signed in" sends
    // the user to sign in again (and keeps the setup banner polling).
    var viaShell = await askCli(input, true)
    if (viaShell) return viaShell
    return { state: 'unknown', detail: 'claude auth status read signed out, and the check through ' + base(deps.env.SHELL || '') + ' with ~/' + sessionRc() + ' gave no answer' }
  }

  function installMethod(p: string, kind: string | undefined): ClaudeInstallMethod {
    if (kind === 'npm') return 'npm'
    var real = p
    try { if (deps.fs) real = String(deps.fs.realpathSync(p)) } catch { /* keep the path */ }
    if (real.indexOf('/node_modules/') >= 0) return 'npm'
    var roots = [home() + '/.local/share/claude/versions/']
    if (deps.env.XDG_DATA_HOME) roots.push(deps.env.XDG_DATA_HOME.replace(/\/$/, '') + '/claude/versions/')
    for (var i = 0; i < roots.length; i++) if (real.indexOf(roots[i]) === 0) return 'native'
    if (/\/(Caskroom|Cellar)\//.test(real) || real.indexOf('/linuxbrew/') >= 0) return 'homebrew'
    return 'other'
  }

  /** Sign-in, version floor and install method of the claude at `input.path`. Never throws. */
  async function check(input: ClaudeCheckInput): Promise<ClaudeCheckResult> {
    var out: ClaudeCheckResult = { auth: 'unknown', installMethod: installMethod(input.path, input.kind) }
    if (!input.minVersion) out.versionOk = true
    else {
      out.minVersion = input.minVersion
      var ok = versionAtLeast(input.version, input.minVersion)
      if (ok !== null) out.versionOk = ok
    }
    var a: Answer
    try { a = await authState(input) } catch (e) { a = { state: 'unknown', detail: String((e as Error).message || e).slice(0, 120) } }
    out.auth = a.state
    if (a.detail) out.authDetail = a.detail
    return out
  }

  return {
    check: check,
    versionAtLeast: versionAtLeast,
    parseAuthStatus: parseAuthStatus,
    installMethod: installMethod,
    authStatusSince: AUTH_STATUS_SINCE,
  }
}

export type ClaudeCheck = ReturnType<typeof createClaudeCheck>
