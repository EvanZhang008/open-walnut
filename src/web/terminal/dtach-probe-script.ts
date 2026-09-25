/**
 * Pure half of dtach provisioning: the shell scripts Walnut runs on a remote
 * host, and the classifier that turns their raw output into a typed result.
 * No I/O here, so the classifier is unit-tested against captured outputs.
 *
 * Two scripts, both fed to `sh -s` over stdin (the remote command is just
 * `sh -s`, which works under any login shell, csh and fish included):
 *
 *   probe  (small, every cold probe): walnut binary → system dtach → compiler?
 *   build  (~48KB of source, once per host ever): compile + install
 *
 * The common case (a binary already exists) is ONE round trip; only a host that
 * needs a build pays a second one, and only once.
 *
 * Every script prints BEGIN_MARKER, then `OS:<uname -s>`, before doing
 * anything else. The OS picks the fix command the UI offers: a Mac without the
 * Command Line Tools needs `xcode-select --install`, not yum. Its absence means
 * the script never ran, so the failure belongs to ssh (auth, VPN, unknown
 * host), never to the compiler. A "no compiler" verdict needs the positive
 * NO_COMPILER marker; silence is never evidence of a missing compiler. That
 * rule exists because the old probe read an empty ssh reply as "no C compiler"
 * and told a user with a broken ssh key to install gcc.
 */

import { shellQuote } from '../../providers/session-io.js'

export const BEGIN_MARKER = 'WALNUT_DTACH_BEGIN'

/** Remote cache path, relative to the remote user's $HOME. */
export const REMOTE_BIN = '.local/bin/walnut-dtach'

/** dtach source filenames, in link order (headers excluded from the cc line). */
export const C_FILES = ['attach.c', 'main.c', 'master.c']
export const ALL_FILES = [...C_FILES, 'dtach.h', 'config.h']

/** Keep this much of a failure's stderr (the tail holds the actual error). */
const STDERR_TAIL = 2000
/** ssh's own exit status for connection/auth errors (see ssh(1)). */
const SSH_ERROR_EXIT = 255

export type DtachSource = 'walnut' | 'system' | 'built'

/** Target OS as far as the fix command cares (from `uname -s`). */
export type HostOs = 'linux' | 'darwin' | 'unknown'

/** Final answer of a provision attempt for one host. */
export type DtachResolution =
  | { kind: 'ok'; path: string; source: DtachSource }
  | { kind: 'ssh_failed'; exitCode: number; stderr: string }
  | { kind: 'no_compiler'; os: HostOs }
  | { kind: 'build_failed'; stderr: string; os: HostOs }

/** One script's outcome: a final answer, or "compile with this cc next". */
export type DtachScriptOutcome = DtachResolution | { kind: 'need_build'; cc: string }

export interface ScriptRun {
  code: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

/** Map a `uname -s` (or Node `process.platform`) value to a HostOs. */
export function toHostOs(name: string | undefined): HostOs {
  if (!name) return 'unknown'
  if (/darwin/i.test(name)) return 'darwin'
  if (/linux/i.test(name)) return 'linux'
  return 'unknown'
}

/** First lines of every script: the start marker, then the OS for the fix hint. */
const PREAMBLE = [`echo ${BEGIN_MARKER}`, 'echo "OS:$(uname -s 2>/dev/null)"']

function tail(s: string): string {
  const t = s.trim()
  return t.length > STDERR_TAIL ? t.slice(-STDERR_TAIL) : t
}

/**
 * Shell predicate: "$1 is a dtach we can drive". `--help` exits non-zero on
 * some builds but always prints a usage naming dtach. A SYSTEM binary must
 * also list the `winch` redraw method, because spawn passes `-r winch` and a
 * dtach older than 0.8 would reject it on every open.
 */
const SH_HELPERS = [
  'is_dtach() { [ -x "$1" ] && "$1" --help 2>&1 | grep -qi dtach; }',
  'is_modern_dtach() { is_dtach "$1" && "$1" --help 2>&1 | grep -qi winch; }',
]

/**
 * Probe script: (1) Walnut's own build at ~/.local/bin, (2) a system dtach
 * (yum/apt/brew). The fixed dirs back up `command -v` because a
 * non-interactive `ssh host sh -s` often lacks the login PATH (brew's prefix
 * is the usual miss). (3) a C compiler to build with, else (4) NO_COMPILER.
 */
export function buildProbeScript(): string {
  return [
    ...PREAMBLE,
    ...SH_HELPERS,
    `B="$HOME/${REMOTE_BIN}"`,
    'if is_dtach "$B"; then echo "DTACH_OK:walnut:$B"; exit 0; fi',
    'for S in "$(command -v dtach 2>/dev/null)" /usr/bin/dtach /usr/local/bin/dtach /opt/homebrew/bin/dtach; do',
    '  if [ -n "$S" ] && is_modern_dtach "$S"; then echo "DTACH_OK:system:$S"; exit 0; fi',
    'done',
    'for c in cc gcc clang; do',
    '  if command -v "$c" >/dev/null 2>&1; then echo "NEED_BUILD:$c"; exit 0; fi',
    'done',
    'echo NO_COMPILER',
    'exit 0',
  ].join('\n')
}

/**
 * Build script: unpack the vendored source into a private temp dir, compile to
 * a temp name, then `mv` into place. The private dir replaces a fixed
 * /tmp/walnut-dtach-build that another user on a shared host could own; the
 * temp-then-mv keeps a half-written binary from ever sitting at the cache path
 * where the next probe would trust it. Compiler output goes to stderr, which
 * the classifier keeps for the UI's Details panel.
 */
export function buildCompileScript(cc: string, sources: Record<string, string>): string {
  const lines = [
    ...PREAMBLE,
    ...SH_HELPERS,
    `B="$HOME/${REMOTE_BIN}"`,
    'D="$(mktemp -d 2>/dev/null || mktemp -d -t walnut-dtach)" || { echo BUILD_FAILED; exit 0; }',
    'mkdir -p "$(dirname "$B")" || { echo BUILD_FAILED; exit 0; }',
  ]
  for (const f of ALL_FILES) {
    const b64 = sources[f]
    if (!b64) throw new Error(`Vendored dtach source missing: ${f}`)
    // The base64 alphabet has no shell metacharacters; quoting is belt and braces.
    lines.push(`printf '%s' ${shellQuote(b64)} | base64 -d > "$D"/${shellQuote(f)}`)
  }
  lines.push(
    `if (cd "$D" && ${shellQuote(cc)} -O2 -I. -o "$B.$$" ${C_FILES.join(' ')} -lutil) && is_dtach "$B.$$" && mv -f "$B.$$" "$B"; then`,
    '  echo "BUILT:$B"',
    'else',
    '  rm -f "$B.$$"; echo BUILD_FAILED',
    'fi',
    'rm -rf "$D"',
    'exit 0',
  )
  return lines.join('\n')
}

/**
 * Classify one script run. Order matters: a positive marker wins over the exit
 * code (ssh can exit non-zero AFTER the script finished, e.g. a mux warning),
 * and a missing BEGIN_MARKER is always ssh's fault.
 */
export function classifyScriptRun(run: ScriptRun): DtachScriptOutcome {
  const { stdout, stderr } = run
  if (!stdout.includes(BEGIN_MARKER)) {
    const why = tail(stderr) || (run.timedOut ? 'ssh timed out before the probe started' : `ssh exited with status ${run.code} and no output`)
    return { kind: 'ssh_failed', exitCode: run.code, stderr: why }
  }

  const os = toHostOs(stdout.match(/^OS:(.*)$/m)?.[1]?.trim())
  const ok = stdout.match(/^DTACH_OK:(walnut|system):(.+)$/m)
  if (ok) return { kind: 'ok', source: ok[1] as 'walnut' | 'system', path: ok[2].trim() }
  const built = stdout.match(/^BUILT:(.+)$/m)
  if (built) return { kind: 'ok', source: 'built', path: built[1].trim() }
  const need = stdout.match(/^NEED_BUILD:(\S+)$/m)
  if (need) return { kind: 'need_build', cc: need[1] }
  if (/^NO_COMPILER$/m.test(stdout)) return { kind: 'no_compiler', os }
  if (/^BUILD_FAILED$/m.test(stdout)) return { kind: 'build_failed', stderr: tail(stderr), os }

  // The script started but printed no verdict: the connection dropped or the
  // remote shell died mid-run. ssh's own error status (or a timeout) is still
  // a transport failure; anything else is the build going wrong.
  if (run.code === SSH_ERROR_EXIT || run.timedOut) {
    return { kind: 'ssh_failed', exitCode: run.code, stderr: tail(stderr) || 'ssh connection dropped during the dtach probe' }
  }
  return { kind: 'build_failed', stderr: tail(stderr) || `probe script exited with status ${run.code}`, os }
}
