/**
 * Which runtime runs the session daemon on a remote host, and how Walnut makes
 * sure it can actually run before betting a connect on it.
 *
 * Three ways in, preferred first: bun running the ~63KB source (tiny upload),
 * the prebuilt binary (no runtime needed, 37MB upload), node running the
 * source (last resort, needs the `ws` package). The old path only checked that
 * a bun FILE existed, so a bun that could not run (a CPU without the
 * instructions the build needs, a glibc too old) surfaced as a failed daemon
 * start with no fallback; and `curl | bash` hid a failed download behind bash's
 * exit code. Now:
 *   - bun is RUN (`bun --version`, 10s cap) before it is used, and a bun that
 *     does not answer is treated as no bun (its output is logged);
 *   - the installer downloads first and runs second, logging both into
 *     bun-install.log in the daemon dir, whose tail rides the error;
 *   - a start that fails in a runtime-shaped way (exec format, illegal
 *     instruction, GLIBC, cannot execute, killed by a signal) moves ONCE along
 *     bun → binary → node inside the same connect (nextRuntimeAfterStartFailure).
 */

import { shq } from './remote-sh.js'

export type RemoteRuntime = 'bun' | 'binary' | 'node'

export const BUN_VERIFY_TIMEOUT_S = 10
export const BUN_INSTALL_URL = 'https://bun.sh/install'

/** Locate bun (PATH, then the installer's default) and run it once. One `sh -s` round trip. */
export function buildBunProbeScript(): string {
  return [
    'B=',
    'if command -v bun >/dev/null 2>&1; then B=$(command -v bun); elif [ -x "$HOME/.bun/bin/bun" ]; then B="$HOME/.bun/bin/bun"; fi',
    'if [ -z "$B" ]; then echo "bun_path=MISSING"; exit 0; fi',
    'echo "bun_path=$B"',
    `if command -v timeout >/dev/null 2>&1; then O=$(timeout ${BUN_VERIFY_TIMEOUT_S} "$B" --version 2>&1); R=$?; else O=$("$B" --version 2>&1); R=$?; fi`,
    'echo "bun_rc=$R"',
    'printf \'bun_out=%s\\n\' "$(printf \'%s\' "$O" | tr \'\\n\' \' \' | cut -c1-300)"',
  ].join('\n')
}

export interface BunProbe {
  /** Null = no bun on the host. */
  path: string | null
  /** It ran and printed a version. */
  ok: boolean
  version?: string
  /** Why a found bun is not usable, for the log and the error. */
  error?: string
}

function describeExit(rc: number): string {
  if (rc === 124) return `did not answer in ${BUN_VERIFY_TIMEOUT_S}s`
  if (rc === 126) return 'cannot execute'
  if (rc === 127) return 'not found'
  if (rc === 132) return 'illegal instruction (this CPU lacks an instruction the build needs)'
  if (rc > 128) return `killed by signal ${rc - 128}`
  return `exit ${rc}`
}

export function parseBunProbe(output: string): BunProbe {
  const kv = new Map<string, string>()
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && /^bun_/.test(line)) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const found = kv.get('bun_path')
  if (!found || found === 'MISSING') return { path: null, ok: false }
  const rc = parseInt(kv.get('bun_rc') ?? '', 10)
  const out = kv.get('bun_out') ?? ''
  const version = out.match(/(?:^|\s)v?(\d+\.\d+\.\d+[\w.+-]*)(?=\s|$)/)?.[1]
  if (rc === 0 && version) return { path: found, ok: true, version }
  const why = Number.isFinite(rc) ? describeExit(rc) : 'no answer'
  return { path: found, ok: false, error: `${found} --version: ${why}${out ? `: ${out}` : ''}`.slice(0, 400) }
}

/**
 * Download the installer, then run it, both logged to `logPath` on the host.
 * Never `curl | bash`: that pipeline's status is bash's, so a failed download
 * read as success. Always exits 0 and REPORTS the status, so the log tail
 * survives the trip back (a non-zero exit would lose stdout).
 */
export function buildBunInstallScript(logPath: string, url: string = BUN_INSTALL_URL): string {
  return [
    `L=${shq(logPath)}`,
    'mkdir -p "$(dirname "$L")" 2>/dev/null',
    ': > "$L" 2>/dev/null || L=/dev/null',
    `echo "walnut: installing bun from ${url}" >> "$L" 2>/dev/null`,
    'if ! command -v curl >/dev/null 2>&1; then echo "curl is not installed on this host" >> "$L"; R=127',
    'elif ! command -v bash >/dev/null 2>&1; then echo "bash is not installed on this host (the bun installer needs it)" >> "$L"; R=127',
    'else',
    `  S=$(curl -fsSL ${shq(url)} 2>>"$L"); R=$?`,
    '  if [ "$R" -eq 0 ] && [ -z "$S" ]; then echo "the installer download was empty" >> "$L"; R=1; fi',
    '  if [ "$R" -eq 0 ]; then printf \'%s\\n\' "$S" | bash >> "$L" 2>&1; R=$?; fi',
    'fi',
    'echo "install_rc=$R"',
    'echo "install_log=$L"',
    'echo "install_tail_begin"',
    'tail -c 1500 "$L" 2>/dev/null',
    'echo',
    'echo "install_tail_end"',
  ].join('\n')
}

export interface BunInstallResult {
  rc: number
  logPath?: string
  /** Last ~1.5KB of what curl and the installer printed. */
  tail: string
}

export function parseBunInstall(output: string): BunInstallResult {
  const rc = parseInt(output.match(/^install_rc=(\d+)$/m)?.[1] ?? '', 10)
  const logPath = output.match(/^install_log=(.+)$/m)?.[1]?.trim()
  const begin = output.indexOf('install_tail_begin\n')
  const end = output.lastIndexOf('install_tail_end')
  const tail = begin >= 0 && end > begin ? output.slice(begin + 'install_tail_begin\n'.length, end).trim() : ''
  return { rc: Number.isFinite(rc) ? rc : -1, ...(logPath ? { logPath } : {}), tail }
}

/** A one-line tail for an error message (the full log stays on the host). */
export function installTailForError(result: BunInstallResult, maxLen = 300): string {
  const lines = result.tail.split('\n').map((l) => l.trim()).filter(Boolean)
  const joined = lines.slice(-4).join(' | ')
  return joined.length > maxLen ? `…${joined.slice(joined.length - maxLen + 1)}` : joined
}

/**
 * A start failure that says the RUNTIME cannot run on this host (as opposed to
 * a daemon bug or a port clash). `walnut-daemon-exit=N` is what the start
 * command appends when the backgrounded runtime died before writing its pid
 * file (daemon-start-cmd.ts), because a background job killed by SIGILL prints
 * nothing of its own.
 */
export function isRuntimeStartFailure(text: string): boolean {
  if (/exec format error|cannot execute|illegal instruction|illegal hardware instruction|GLIBC_\d|GLIBCXX_\d|version `GLIBC|error while loading shared libraries|symbol lookup error|bad CPU type|Segmentation fault|core dumped|not found \(required by/i.test(text)) return true
  const exit = text.match(/walnut-daemon-exit=(\d+)/)
  if (!exit) return false
  const code = parseInt(exit[1], 10)
  return code === 126 || code === 127 || code > 128
}

/**
 * The next runtime to try after `failed` did not start, or null to give up.
 * Only a runtime-shaped failure moves on; each runtime is tried at most once
 * per connect (`tried`), so this can never loop.
 */
export function nextRuntimeAfterStartFailure(
  failed: RemoteRuntime,
  errorText: string,
  opts: { haveBinary: boolean; tried: ReadonlySet<RemoteRuntime> },
): RemoteRuntime | null {
  if (!isRuntimeStartFailure(errorText)) return null
  const order: RemoteRuntime[] = failed === 'bun' ? ['binary', 'node'] : failed === 'binary' ? ['node'] : []
  for (const next of order) {
    if (opts.tried.has(next)) continue
    if (next === 'binary' && !opts.haveBinary) continue
    return next
  }
  return null
}
