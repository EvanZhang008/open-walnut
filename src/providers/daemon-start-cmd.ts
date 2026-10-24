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

/** The daemon files the Mac starts in a daemon dir, as `<dir>/<name> --start` (the binary) or `<runtime> <dir>/daemon.cjs --start`. */
const DAEMON_BINARY_NAMES = ['daemon-linux-x64', 'daemon-linux-arm64', 'daemon-darwin-arm64', 'daemon-darwin-x64']

/**
 * Shell helpers for "is this pid the daemon of that dir": `w_args <pid>` prints
 * its command line (Linux /proc; ps elsewhere, which a slim Linux image does not
 * have), and `w_daemon <pid> <dir>` is true when that line runs a daemon file of
 * `<dir>` the way the Mac starts one (the rule buildDaemonStopCmd applies), or
 * is an OS service's daemon (`<install root>/versions/<sha>/daemon --service`).
 * A pid file whose pid now names another process (a restarted container reuses
 * pids) is no live daemon: taking it for one pointed every connect at the dead
 * daemon's port, again on every try, until that process ended.
 */
export const DAEMON_PID_SH: readonly string[] = [
  `w_args() { if [ -r /proc/self/cmdline ]; then tr '\\000' ' ' < "/proc/$1/cmdline" 2>/dev/null; else ps -o args= -p "$1" 2>/dev/null; fi; }`,
  // /proc ends the line with one NUL (now a space); the leading space makes `<dir>/<binary> --start` a suffix match too.
  'w_daemon() { a=$(w_args "$1"); a=" ${a% }"; case "$a" in '
    + [...DAEMON_BINARY_NAMES, 'daemon.cjs'].map((name) => `*" $2/${name} --start"`).join('|')
    + '|*"/daemon --service") return 0;; esac; return 1; }',
]

/**
 * Stops the unmanaged daemon in `dir` and confirms it is gone (prints
 * `walnut-daemon-stop-confirmed`). The pid is checked to be that daemon (its
 * command line) and followed by its start time, so a reused pid is never
 * signalled. Linux reads both from /proc: a slim image has no ps, and asking it
 * there failed every stop, so a host without procps could never take a new
 * daemon. Elsewhere ps answers. `procRoot` is for tests only.
 */
export function buildDaemonStopCmd(dir = '/tmp/open-walnut', procRoot = '/proc'): string {
  const pidFile = shq(`${dir}/daemon.pid`)
  return [
    `if [ ! -e ${pidFile} ]; then printf '%s\\n' walnut-daemon-stop-confirmed; exit 0; fi`,
    `PID=$(cat ${pidFile}) || exit 1`,
    'case "$PID" in ""|*[!0-9]*) exit 1;; esac',
    '[ "$PID" -gt 1 ] || exit 1',
    'export LC_ALL=C',
    'ERROR_FILE=$(mktemp) || exit 1',
    'trap \'rm -f "$ERROR_FILE"\' EXIT',
    `PROC=${shq(procRoot)}`,
    'if [ -r "$PROC/self/stat" ]; then',
    // Field 22 (the start time) is the 20th after "<pid> (<comm>) "; comm may hold ") ", so strip to the last one.
    // A stat file that is there but parses empty is a failure (2), never "gone": only a pid with no stat is gone.
    '  read_identity() { [ -r "$PROC/$PID/stat" ] || return 1; value=$(sed \'s/.*) //\' "$PROC/$PID/stat" 2>/dev/null | cut -d\' \' -f20); if [ -z "$value" ]; then [ -e "$PROC/$PID/stat" ] && return 2; return 1; fi; printf \'%s\\n\' "$value"; }',
    '  read_command() { [ -r "$PROC/$PID/cmdline" ] || return 1; tr \'\\000\' \' \' < "$PROC/$PID/cmdline" | sed \'s/ *$//\'; }',
    'else',
    '  read_identity() { value=$(ps -p "$PID" -o lstart= 2>"$ERROR_FILE"); code=$?; [ ! -s "$ERROR_FILE" ] || return 2; printf \'%s\\n\' "$value"; return "$code"; }',
    '  read_command() { ps -p "$PID" -o command= 2>"$ERROR_FILE"; }',
    'fi',
    'IDENTITY=$(read_identity); STATUS=$?',
    'if [ "$STATUS" -eq 1 ] && [ -z "$IDENTITY" ]; then printf \'%s\\n\' walnut-daemon-stop-confirmed; exit 0; fi',
    '[ "$STATUS" -eq 0 ] && [ -n "$IDENTITY" ] || exit 1',
    'COMMAND=$(read_command) || exit 1',
    '[ ! -s "$ERROR_FILE" ] || exit 1',
    `case "$COMMAND" in ${DAEMON_BINARY_NAMES.map((name) => shq(`${dir}/${name} --start`)).join('|')}|*${shq(` ${dir}/daemon.cjs --start`)}) ;; *) exit 1;; esac`,
    'CURRENT=$(read_identity); STATUS=$?',
    'if [ "$STATUS" -eq 1 ] && [ -z "$CURRENT" ]; then printf \'%s\\n\' walnut-daemon-stop-confirmed; exit 0; fi',
    '[ "$STATUS" -eq 0 ] && [ "$CURRENT" = "$IDENTITY" ] || exit 1',
    'if ! kill -TERM "$PID"; then',
    '  CURRENT=$(read_identity); STATUS=$?',
    '  if [ "$STATUS" -eq 1 ] && [ -z "$CURRENT" ]; then printf \'%s\\n\' walnut-daemon-stop-confirmed; exit 0; fi',
    '  exit 1',
    'fi',
    'i=0',
    'while [ "$i" -lt 30 ]; do',
    '  CURRENT=$(read_identity); STATUS=$?',
    '  if { [ "$STATUS" -eq 1 ] && [ -z "$CURRENT" ]; } || { [ "$STATUS" -eq 0 ] && [ -n "$CURRENT" ] && [ "$CURRENT" != "$IDENTITY" ]; }; then',
    '    printf \'%s\\n\' walnut-daemon-stop-confirmed; exit 0',
    '  fi',
    '  [ "$STATUS" -eq 0 ] && [ -n "$CURRENT" ] || exit 1',
    '  i=$((i+1)); sleep 1',
    'done',
    'printf \'%s\\n\' \'Daemon shutdown is still pending; no replacement was started\' >&2',
    'exit 1',
  ].join('\n')
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
  // Ready means a daemon wrote the files SINCE this start (they differ from
  // what the dir held before nohup: a daemon writes its port, then its pid), or
  // this start yielded to the daemon already running (it exits 0 after
  // printing that daemon's port). A live pid alone proves nothing: a dead
  // daemon's files stay, and after a restart (a container's above all) its pid
  // may name another process, which `kill -0` takes for the daemon. The old
  // port was then reported as the new daemon's, and every connect went to it.
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
  //
  // A runtime that dies on its own before writing the pid file (SIGILL on a
  // CPU the build does not support, a loader error) prints nothing: a killed
  // background job has no shell left to report it. So the poll also watches
  // the job itself, and once it is gone, reaps it ONCE and appends
  // `walnut-daemon-exit=<status>` to the start log. The server reads that line
  // to decide whether to fall back to another runtime (remote-runtime.ts).
  // A zombie still answers kill -0, so `ps` confirms; a `ps` that cannot answer
  // (busybox without -p) reads as alive, never as dead: `wait` on a live job
  // would block the whole start.
  // Every path is single-quoted: a fallback dir under a HOME with a space
  // ("/home/John Smith/.cache/open-walnut") must stay one word.
  const log = shq(`${dir}/daemon-start.log`)
  const pidFile = shq(`${dir}/daemon.pid`)
  const portFile = shq(`${dir}/daemon.port`)
  const script = shq(`${dir}/daemon.cjs`)
  const exec = opts.execPath ? shq(opts.execPath) : ''
  const files = `$(cat ${portFile} ${pidFile} 2>/dev/null)`
  const before = `WALNUT_BEFORE="${files}"; `
  const waitReady =
    'WALNUT_BG=$!; WALNUT_BG_DONE=; WALNUT_BG_RC=; WALNUT_READY=; for i in $(seq 1 22); do ' +
    `DPID=$(cat ${pidFile} 2>/dev/null); ` +
    `if [ -s ${portFile} ] && [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null; then ` +
    `if [ "${files}" != "$WALNUT_BEFORE" ] || [ "$WALNUT_BG_RC" = 0 ]; then WALNUT_READY=1; break; fi; fi; ` +
    `[ "$i" -ge 2 ] && grep -Eq "^(nohup|env): " ${log} 2>/dev/null && break; ` +
    'if [ -z "$WALNUT_BG_DONE" ]; then WALNUT_BG_GONE=; ' +
    'if ! kill -0 "$WALNUT_BG" 2>/dev/null; then WALNUT_BG_GONE=1; ' +
    'else case "$(ps -o stat= -p "$WALNUT_BG" 2>/dev/null)" in Z*) WALNUT_BG_GONE=1;; esac; fi; ' +
    'if [ -n "$WALNUT_BG_GONE" ]; then WALNUT_BG_DONE=1; wait "$WALNUT_BG"; WALNUT_BG_RC=$?; ' +
    `if [ "$WALNUT_BG_RC" -ne 0 ]; then echo "walnut-daemon-exit=$WALNUT_BG_RC" >> ${log}; break; fi; continue; fi; fi; ` +
    'sleep 2; done'

  // `[ -n "$DPID" ]` guards against an empty pid file (cat succeeds but
  // yields empty → `kill -0 ""` behavior is shell-dependent; some emit the
  // current shell's pid). Nothing is confirmed unless the poll saw the daemon ready.
  const confirmRunning =
    `[ -n "$WALNUT_READY" ] && cat ${portFile} && echo && ` +
    `DPID=$(cat ${pidFile} 2>/dev/null) && ` +
    `[ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && echo "{\\"running\\":true}"`

  switch (opts.runtime) {
    case 'bun':
      // Source deployed under bun — exec bun by absolute path (no preamble).
      // The daemon source itself sources ~/.zshrc / ~/.bashrc on startup to
      // populate process.env.PATH so cmdStart's spawn('claude', ...) finds
      // the CLI. See daemon-source.ts "PATH setup" block.
      return `${before}nohup ${envPrefix}${exec} ${script} --start > ${log} 2>&1 & ` +
        `${waitReady}; ${confirmRunning}`
    case 'binary':
      // Binary deploy — run directly, no PATH setup needed. Binary has a
      // `--status` subcommand (the pid alive AND the daemon answering on its
      // port), so use it as the liveness confirmation.
      return `${before}nohup ${envPrefix}${exec} --start > ${log} 2>&1 & ` +
        `${waitReady}; [ -n "$WALNUT_READY" ] && cat ${portFile} && echo && ${envPrefix}${exec} --status`
    case 'node':
      // Source deploy under node — needs the shell preamble for node PATH
      // discovery (rc files, nvm init).
      return `${opts.preamble ?? 'true'}; ${before}nohup ${envPrefix}node ${script} --start > ${log} 2>&1 & ` +
        `${waitReady}; ${confirmRunning}`
  }
}
