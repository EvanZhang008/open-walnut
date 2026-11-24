/**
 * The shell a session starts in and the preamble it runs before the CLI, built in one place so
 * that a session start and host.preflight ask the same environment: the daemon spawns
 * `<shell> -c "<preamble>; exec claude ..."`, and host-runtime-core.ts runs its claude probes
 * through the daemon's `spawnPreamble`, which is buildSessionPreamble too
 * (tests/providers/session-shell.test.ts holds them to one function).
 *
 * The shell (pickSessionShell): the daemon's $SHELL, unless that is a plain sh (or unset) and
 * the user's login shell (passwd) is bash or zsh. A service a launcher starts runs with
 * SHELL=/bin/sh, and the preamble sources ~/.bashrc or ~/.zshrc by $SHELL: under sh it sourced
 * neither, and sessions missed the PATH and sign-in variables set there (2026-11-24, "Not
 * logged in"). The session's SHELL is set to the same shell, so its Bash tool runs it too.
 *
 * shell_setup (config.hosts.<key>.shell_setup): runs after the rc files, in the same shell, with
 * no stdin and no stdout (the CLI's stdout is the session's JSONL); a setup that fails, does not
 * parse, or calls `exit` or `return` does not stop the start (shellSetupStep). The leader sends it
 * with each start it sends ('start-shell-setup-v1'); the daemon keeps the last one per Walnut
 * (createShellSetupStore) for the starts the host decides itself (a trigger resume, a start while
 * the leader is away, a bridge resume). The config copy every replica gets leaves shell_setup out
 * because it may carry tokens (config-allowlist.ts), so the store is private to this user (0600
 * files in a 0700 dir) and nothing else reads it. For the same reason the preamble names the
 * store's file and never holds the text: a shell's argv shows in `ps` and /proc/<pid>/cmdline
 * ("a CLI's command line carries paths, never content", docs/reference/agent-guards.md).
 */

import { NODE_DISCOVERY_SHELL } from './host-runtime-core.js'
import { shellQuote } from './host-exec-line.js'

/** A shell that reads no rc file of its own: a login shell from passwd is preferred over it. */
const PLAIN_SH = new Set(['sh', 'dash'])
/** The login shells whose rc file the preamble sources: the only ones taken from passwd. */
const RC_SHELLS = new Set(['bash', 'zsh'])

function baseName(file: string): string {
  return file.split('/').pop() || ''
}

/**
 * Whether `file` can be a session's shell: an executable regular file (a directory has X_OK too,
 * and a spawn of one fails every start).
 */
export function runsAsShell(fs: Pick<typeof import('node:fs'), 'accessSync' | 'statSync' | 'constants'>, file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/**
 * The shell sessions start under. `envShell`: the daemon's $SHELL; `loginShell`: the user's
 * shell in passwd (os.userInfo().shell), read once by the caller; `runs`: an executable file.
 * A user whose login shell is sh, or fish, or anything the preamble cannot source, keeps the
 * shell as before: $SHELL, else bash, else sh (a minimal system may have no bash and no $SHELL,
 * and a $SHELL naming a shell that is gone would fail every spawn).
 */
export function pickSessionShell(opts: { envShell?: string; loginShell?: string | null; runs: (file: string) => boolean }): string {
  const env = opts.envShell && opts.envShell.startsWith('/') && opts.runs(opts.envShell) ? opts.envShell : undefined
  if (env && !PLAIN_SH.has(baseName(env))) return env
  const login = opts.loginShell
  if (login && login.startsWith('/') && RC_SHELLS.has(baseName(login)) && opts.runs(login)) return login
  if (env) return env
  return ['/bin/bash', '/bin/sh'].find(opts.runs) ?? '/bin/sh'
}

/**
 * The step that runs a host's shell_setup inside the session's shell, so what it exports stays.
 * `file`: the store's 0600 file that holds it; the step names the file, never the text.
 *  - Through `eval`, so a setup that does not parse fails alone instead of the whole `-c` script:
 *    `command eval` in sh, dash and bash (an error of a special builtin otherwise ends a POSIX
 *    shell), `builtin eval` in zsh (its `command` runs only programs on PATH). A bash that runs
 *    as /bin/sh is in POSIX mode, where even `command eval` ends the script on a parse error:
 *    `set +o posix` first (the rc files have run; next comes only the rest of the preamble).
 *  - Inside a function, so a `return` in the setup ends the setup, as in a sourced file (at the
 *    top of zsh's `-c` it ended the shell), and with `exit` aliased to `return` while it is
 *    parsed, so an `exit` ends the setup too and keeps what it exported so far. An explicit
 *    `builtin exit`, `\exit` or an `exec` still ends the shell: that is the setup's own choice.
 *  - No errexit: a setup's `set -e` never ends the start, nor stays on for the rest of the preamble
 *    (`set +e` after it). Under bash 4.2 (AL2, CentOS 7) an errexit inside eval ends the shell even
 *    in a `||` list, so there `set` is shadowed while the setup runs by one that turns -e off again (defined
 *    through eval: a POSIX-mode bash parses the whole line before `set +o posix` runs, and refuses a
 *    function named like a special builtin).
 *  - No stdin: the CLI's stdin is the session's FIFO, and a setup that reads would take the first
 *    message. No stdout (the session's JSONL). Its stderr goes to the session's .err log, as the
 *    rc files' does.
 */
export function shellSetupStep(file: string): string {
  return '[ -z "${BASH_VERSION-}" ] || { set +o posix; shopt -s expand_aliases; eval \'set() { builtin set "$@"; builtin set +e; }\'; }; '
    + '__walnut_eval=command; [ -z "${ZSH_VERSION-}" ] || __walnut_eval=builtin; alias exit=return; '
    + '__walnut_setup() { $__walnut_eval eval "$(cat -- ' + shellQuote(file) + ')"; }; '
    + '__walnut_setup </dev/null >/dev/null || true; '
    + 'unalias exit 2>/dev/null; unset -f __walnut_setup; [ -z "${BASH_VERSION-}" ] || unset -f set; unset __walnut_eval; set +e'
}

export interface SessionPreambleOptions {
  /** The daemon's gateway shim dir: `walnut`, the peer-session CLI, is on every session's PATH. */
  shimDir: string
  /** A test server's isolated daemon installs its tools under its own HOME (remote-isolation.ts). */
  installHomeBin?: string | null
  /** A node hostRuntime.ensureClaude() found outside PATH, used only when the rc PATH has no working one. */
  nodeDir?: string
  /** The shim dir first on PATH (a session that reaches its Walnut through this daemon). */
  gatewayFirst?: boolean
  /** The file that holds the host's shell_setup (createShellSetupStore; '' or absent: none). */
  shellSetupFile?: string
  /** The `export PATH=...` step that appends the common tool dirs and the shim dir (the daemon's own). */
  fallbackPathStep: string
}

/**
 * The preamble that gives a session the user's dev environment: the rc file of its shell, the
 * host's shell_setup, the common tool dirs as a fallback, and a node that runs.
 */
export function buildSessionPreamble(o: SessionPreambleOptions): string {
  return [
    // Source RC files FIRST, then add our paths: RC files may hard-reset PATH
    // (e.g. zsh `export PATH=; path=(...)`) which would clobber earlier prepends.
    // Redirect >/dev/null suppresses stdout only: stderr flows to .jsonl.err
    // for debugging. Stdout suppression is load-bearing: the spawned process's
    // stdout IS the JSONL output file, so interactive plugins (oh-my-zsh, p10k)
    // would corrupt the stream with escape codes. No stdin: it is the session's
    // FIFO, and an rc file that reads would take the first message.
    'case "$SHELL" in'
      + ' */zsh) [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" </dev/null >/dev/null ;;'
      + ' */bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" </dev/null >/dev/null ;;'
      + ' esac',
    // The host's own setup after the rc files, so it can add to what they set.
    ...(o.shellSetupFile ? [shellSetupStep(o.shellSetupFile)] : []),
    // The common tool dirs, appended as a fallback, then the gateway shim dir (the caller's: daemon-standalone.ts).
    o.fallbackPathStep,
    ...(o.installHomeBin ? ['export PATH="$PATH":' + shellQuote(o.installHomeBin)] : []),
    ...(o.nodeDir ? ['node -v >/dev/null 2>&1 || export PATH=' + shellQuote(o.nodeDir) + ':"$PATH"'] : []),
    // nvm's default may be compiled against a newer GLIBC than the host provides, so
    // it tries each installed version until one actually executes.
    NODE_DISCOVERY_SHELL,
    // Last, so neither the node dir nor the node discovery above can put another `walnut` ahead.
    ...(o.gatewayFirst ? ['export PATH=' + shellQuote(o.shimDir) + ':"$PATH"'] : []),
  ].join('; ')
}

export interface ShellSetupStoreDeps {
  fs: Pick<typeof import('node:fs'), 'mkdirSync' | 'mkdtempSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'chmodSync'>
  path: Pick<typeof import('node:path'), 'join'>
  crypto: Pick<typeof import('node:crypto'), 'createHash'>
  /** The daemon's own dir for it (one file per Walnut). */
  dir: string
  log?: (level: 'warn', msg: string, data?: Record<string, unknown>) => void
}

/**
 * The last shell_setup each Walnut's leader sent with a start: one file per Walnut, named by a
 * hash of its id, 0600 in a 0700 dir, written whole by rename. An empty setup removes it. Each
 * call answers the FILE a preamble runs (shellSetupStep), '' when there is none to run.
 */
export function createShellSetupStore(deps: ShellSetupStoreDeps) {
  const { fs, path, crypto, dir } = deps
  const cache = new Map<string, string>()
  const fileOf = (walnut: string) => path.join(dir, crypto.createHash('sha256').update(walnut, 'utf8').digest('hex').slice(0, 16))

  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }

  function textOf(walnut: string): string {
    const hit = cache.get(walnut)
    if (hit !== undefined) return hit
    let text = ''
    try { text = fs.readFileSync(fileOf(walnut), 'utf8') } catch { /* none kept */ }
    cache.set(walnut, text)
    return text
  }

  /** The file of this Walnut's last setup, '' when none is kept. */
  function recall(walnut: string): string {
    return textOf(walnut) ? fileOf(walnut) : ''
  }

  /**
   * Keep `setup` as this Walnut's and answer its file. A failed write answers '' (the file on
   * disk may hold the old one, which must not run in its place) and is tried again next time.
   */
  function remember(walnut: string, setup: string): string {
    const text = setup.trim()
    if (textOf(walnut) === text) return recall(walnut)
    const file = fileOf(walnut)
    try {
      if (!text) fs.rmSync(file, { force: true })
      else {
        ensureDir()
        const tmp = file + '.tmp'
        fs.writeFileSync(tmp, text, { mode: 0o600 })
        fs.chmodSync(tmp, 0o600)
        fs.renameSync(tmp, file)
      }
      cache.set(walnut, text)
      return text ? file : ''
    } catch (err) {
      cache.delete(walnut)
      deps.log?.('warn', 'shell_setup: could not keep it; this start runs none', { error: String(err) })
      return ''
    }
  }

  /**
   * A setup that is nobody's to keep (host.preflight's): a 0600 file in a fresh 0700 dir of its
   * own under the store's dir, and `remove` deletes both. Null when it cannot be written.
   */
  function scratch(setup: string): { file: string; remove: () => void } | null {
    const text = setup.trim()
    if (!text) return null
    let tmpDir = ''
    try {
      ensureDir()
      tmpDir = fs.mkdtempSync(path.join(dir, 'scratch-'))
      fs.chmodSync(tmpDir, 0o700)
      const file = path.join(tmpDir, 'setup')
      fs.writeFileSync(file, text, { mode: 0o600 })
      fs.chmodSync(file, 0o600)
      return { file, remove: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* gone */ } } }
    } catch (err) {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* gone */ } }
      deps.log?.('warn', 'shell_setup: could not write it for host.preflight', { error: String(err) })
      return null
    }
  }

  return { recall, remember, scratch }
}
