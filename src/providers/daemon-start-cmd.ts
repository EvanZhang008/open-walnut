/**
 * Pure builder for the remote daemon start command.
 *
 * Extracted after the 2026-08-12 clouddev outage: an env prefix was inlined
 * into the command as `nohup VAR=1 cmd`. nohup is not a shell — it exec'd
 * 'VAR=1' as the program, the daemon never booted, and every connect attempt
 * fell into a redeploy loop that surfaced as fake "SSH is broken" errors.
 *
 * Building the command from structured data makes that shape unrepresentable:
 * callers pass env vars as a record, and this module always renders them
 * through `env K='V'` (which nohup can exec). The behavior test executes the
 * generated command against a fake runtime to prove it actually boots —
 * tests/providers/daemon-start-cmd.test.ts.
 */

export interface DaemonStartCmdOpts {
  /** How the daemon runs on the remote host. */
  runtime: 'bun' | 'binary' | 'node'
  /** Absolute path to the bun executable ('bun') or the daemon binary ('binary'). */
  execPath?: string
  /** Env vars for the daemon process — rendered as `nohup env K='V' cmd`. */
  env?: Record<string, string>
  /** Shell preamble prepended for the 'node' runtime (PATH discovery). */
  preamble?: string
  /** Daemon dir on the remote host. Tests override; production default below. */
  dir?: string
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** POSIX single-quote: safe against spaces, $, backticks, semicolons. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildDaemonStartCmd(opts: DaemonStartCmdOpts): string {
  const dir = opts.dir ?? '/tmp/open-walnut'
  const entries = Object.entries(opts.env ?? {})
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid daemon env var name: ${key}`)
    if (value.includes('\n')) throw new Error(`daemon env var ${key} must be single-line`)
  }
  // `env` (never a bare K=V prefix): nohup execvp's its first argument
  // directly, so `nohup K=V cmd` tries to run the program 'K=V' and fails.
  const envPrefix = entries.length
    ? `env ${entries.map(([k, v]) => `${k}=${shq(v)}`).join(' ')} `
    : ''

  if ((opts.runtime === 'bun' || opts.runtime === 'binary') && !opts.execPath) {
    throw new Error(`runtime '${opts.runtime}' requires execPath`)
  }

  // Readiness probe: POLL for the port file + live pid, up to ~45s. A fixed
  // `sleep 2` raced daemon boot on loaded hosts (a busy dev box took ~20s
  // from nohup to port write) — the probe declared failure while the daemon
  // was still booting, connect() threw, and overlapping retries then
  // stop-for-upgrade'd each other's half-booted daemons in a loop (a
  // 43-minute host outage). The poll lets the FIRST attempt succeed.
  //
  // Fail fast on a spawn that can never succeed: if the start log shows the
  // wrapper chain itself failed to exec (as opposed to daemon output), the
  // remaining ~40s of polling is pure spin — bail after one sleep. The error
  // prefix depends on which wrapper hit the failure AND the platform:
  // `nohup: failed to run command '...'` (GNU), `nohup: <path>: No such file`
  // (BSD/macOS), `env: <path>: No such file or directory` (both, when the
  // env prefix is present). The `i -ge 2` guard skips iteration 1 so a STALE
  // error from a previous attempt (log truncates when the new nohup spawns,
  // racing the poll) can't abort a healthy boot.
  const waitReady =
    'for i in $(seq 1 22); do ' +
    `DPID=$(cat "${dir}/daemon.pid" 2>/dev/null); ` +
    `[ -s "${dir}/daemon.port" ] && [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && break; ` +
    `[ "$i" -ge 2 ] && grep -Eq "^(nohup|env): " "${dir}/daemon-start.log" 2>/dev/null && break; ` +
    'sleep 2; done'

  // `[ -n "$DPID" ]` guards against an empty pid file (cat succeeds but
  // yields empty → `kill -0 ""` behavior is shell-dependent; some emit the
  // current shell's pid).
  const confirmRunning =
    `cat "${dir}/daemon.port" && echo && ` +
    `DPID=$(cat "${dir}/daemon.pid" 2>/dev/null) && ` +
    `[ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && echo "{\\"running\\":true}"`

  switch (opts.runtime) {
    case 'bun':
      // Source deployed under bun — exec bun by absolute path (no preamble).
      // The daemon source itself sources ~/.zshrc / ~/.bashrc on startup to
      // populate process.env.PATH so cmdStart's spawn('claude', ...) finds
      // the CLI. See daemon-source.ts "PATH setup" block.
      return `nohup ${envPrefix}${opts.execPath} ${dir}/daemon.cjs --start > ${dir}/daemon-start.log 2>&1 & ` +
        `${waitReady}; ${confirmRunning}`
    case 'binary':
      // Binary deploy — run directly, no PATH setup needed. Binary has a
      // `--status` subcommand, so use it as the liveness confirmation.
      return `nohup ${envPrefix}${opts.execPath} --start > ${dir}/daemon-start.log 2>&1 & ` +
        `${waitReady}; cat "${dir}/daemon.port" && echo && ${opts.execPath} --status`
    case 'node':
      // Source deploy under node — needs the shell preamble for node PATH
      // discovery (rc files, nvm init).
      return `${opts.preamble ?? 'true'}; nohup ${envPrefix}node ${dir}/daemon.cjs --start > ${dir}/daemon-start.log 2>&1 & ` +
        `${waitReady}; ${confirmRunning}`
  }
}
