/**
 * Host autofix: whatever a connected host is missing, Walnut installs it itself
 * instead of handing the user a command. After a preflight (host-readiness.ts)
 * reports problems on a daemon with 'hostfix-v1', this runs the fixes in order,
 * each through the daemon's `host.fix` RPC (host-side, src/providers/host-fix-core.ts):
 *
 *   claude missing, or the npm build with no node   → install-claude-native
 *   claude older than the model's floor: the npm
 *     build                                         → install-claude-native
 *     the native installer's build                  → update-claude
 *     (Homebrew or a wrapper: never touched, the line says how to update)
 *   no compiler and no dtach, host not a Mac, and
 *     no prebuilt dtach this server ships for it    → install-compiler (sudo -n)
 *   dtach missing, and a compiler or a prebuilt     → build-dtach
 *
 * build-dtach first runs the terminal's own provisioning (resolveRemoteDtach over
 * ssh: it uploads the shipped prebuilt for the host's platform/arch, or compiles
 * when the host has a compiler), and only when that leaves no dtach and the
 * daemon reports a compiler does it ask the daemon to compile. A compiler is
 * only ever needed for dtach, so a usable prebuilt makes install-compiler moot;
 * a prebuilt that does not run on the host (an older glibc) puts it back.
 *
 * The preflight re-runs after each fix, so the next step (and the UI) sees the
 * host as it is now. Policy:
 *   - once per host per server lifetime for each fix: a failed fix is not
 *     retried on every reconnect; a human "Check again" allows one more round;
 *   - a lost connection or a busy daemon does NOT count as an attempt;
 *   - never on a host whose preflight had no problems, never blocking a connect;
 *   - off with WALNUT_HOST_AUTOFIX=0, or per host with `hosts.<alias>.autofix: false`.
 * Signing in to Claude Code stays human: nothing here touches credentials, and
 * `claude_not_logged_in` has no fix at all.
 *
 * Pure planning and wording live here; the per-host state lives in host-readiness.ts.
 */

import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import type { HostFixAction, HostFixResult } from '../../providers/host-fix-core.js'
import type { PreflightConnection } from './host-readiness.js'
import type { ReadinessProblem } from './host-readiness-problems.js'

export type { HostFixAction }

/** One finished automatic fix, as the UI reads it. */
export interface HostFixRecord {
  action: HostFixAction
  ok: boolean
  needsPassword?: boolean
  /** The daemon's short reason code ('needs-password', 'timeout', ...). */
  error?: string
  /** It was already there, so nothing ran. */
  skipped?: boolean
  finishedAt: number
  /** One sentence, no trailing period: "Installed Claude Code 2.1.280". */
  text: string
  /** The command to run by hand, when the fix could not be done. */
  command?: string
  /** Last line of the fix's output, for a tooltip. */
  detail?: string
}

/** A fix running right now. `text` reads "<text> on <host>...". */
export interface HostFixing {
  action: HostFixAction
  startedAt: number
  text: string
}

/** The daemon answers inside its own 5-minute cap; 30s more covers the tunnel. */
export const HOST_FIX_TIMEOUT_MS: Record<HostFixAction, number> = {
  'install-claude-native': 330_000,
  'update-claude': 330_000,
  'install-compiler': 330_000,
  'build-dtach': 150_000,
}

const RUNNING_TEXT: Record<HostFixAction, string> = {
  'install-claude-native': 'Installing Claude Code',
  'update-claude': 'Updating Claude Code',
  'install-compiler': 'Installing gcc',
  'build-dtach': 'Installing dtach',
}

const FAILED_PREFIX: Record<HostFixAction, string> = {
  'install-claude-native': 'Could not install Claude Code automatically',
  'update-claude': 'Could not update Claude Code automatically',
  'install-compiler': 'Could not install gcc automatically',
  'build-dtach': 'Could not install dtach automatically',
}

/** Daemon reason code → the words inside "(...)". */
const REASONS: Record<string, string> = {
  'needs-password': 'sudo needs a password',
  'sudo-not-allowed': 'this user may not use sudo',
  'no-sudo': 'sudo is not installed',
  'no-package-manager': 'no dnf, yum, apt-get, apk or zypper was found',
  'package-manager-failed': 'the package manager failed',
  'darwin-needs-command-line-tools': 'a Mac needs the Command Line Tools',
  'unsupported-os': 'this operating system is not supported',
  'no-downloader': 'neither curl nor wget is installed',
  'no-bash': 'bash is not installed',
  'download-failed': 'the installer could not be downloaded',
  'installer-failed': 'the installer failed',
  'verify-failed': 'it did not run after installing',
  'no-compiler': 'there is no C compiler',
  'build-failed': 'the compiler failed',
  'bad-sources': 'the source did not arrive intact',
  'ssh-failed': 'ssh to the host failed',
  'no-answer': 'the host gave no usable answer',
  'timeout': 'it took longer than 5 minutes',
  'busy': 'another fix was running',
  'connection-lost': 'the connection to the host dropped',
  'unmanaged-install': 'it was not installed by the native installer',
  'updates-disabled': 'updates are turned off with DISABLE_UPDATES',
  'still-outdated': 'the newest release it could reach is still too old',
  'unknown-action': 'the session daemon there is too old for this fix',
}

/** Which fix answers which readiness problem (claude_outdated: see fixActionFor). */
export const FIX_FOR_PROBLEM: Record<string, HostFixAction> = {
  claude_missing: 'install-claude-native',
  claude_needs_node: 'install-claude-native',
  claude_outdated: 'update-claude',
  compiler_missing: 'install-compiler',
  dtach_missing: 'build-dtach',
}

/**
 * The fix for one problem on this preflight, or null when Walnut must not try:
 * an outdated npm build gets the native build beside it (which then comes
 * first), only the native installer's own build gets `claude update`, and a
 * Homebrew or wrapper install is left alone. `installMethod` only comes from a
 * daemon that also runs update-claude, so its presence is the capability.
 */
export function fixActionFor(kind: string, p: HostPreflightResult): HostFixAction | null {
  if (kind !== 'claude_outdated') return FIX_FOR_PROBLEM[kind] ?? null
  if (p.claude.installMethod === 'npm' || (!p.claude.installMethod && p.claude.kind === 'npm')) return 'install-claude-native'
  return p.claude.installMethod === 'native' ? 'update-claude' : null
}

/**
 * Problems with the fix state merged in: the one running now reads 'running',
 * a failed last attempt reads 'failed' with its reason and exact command.
 */
export function withFixState(problems: ReadinessProblem[], p: HostPreflightResult, fixing: HostFixing | undefined, fixes: HostFixRecord[]): ReadinessProblem[] {
  return problems.map((problem): ReadinessProblem => {
    const action = fixActionFor(problem.kind, p)
    if (!action) return problem
    if (fixing?.action === action) return { ...problem, fix: { action, state: 'running', text: fixing.text } }
    let last: HostFixRecord | undefined
    for (const r of fixes) if (r.action === action) last = r
    if (!last || last.ok) return problem
    return {
      ...problem,
      commands: last.command ? [last.command] : problem.commands,
      fix: {
        action, state: 'failed', text: last.text,
        ...(last.needsPassword ? { needsPassword: true } : {}), ...(last.detail ? { detail: last.detail } : {}),
      },
    }
  })
}

export function fixingText(action: HostFixAction): string {
  return RUNNING_TEXT[action]
}

/** Off switch. Read on every call, so a test (or an operator) can flip it live. */
export function autofixDisabledReason(env: Record<string, string | undefined>, hostDef: { autofix?: unknown } | undefined): string | null {
  const flag = (env.WALNUT_HOST_AUTOFIX ?? '').trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return 'env'
  if (hostDef?.autofix === false) return 'config'
  return null
}

/**
 * The next fix for this preflight, skipping any already tried. Null = nothing
 * to do. `prebuiltDtach`: this server ships a dtach for the host's platform/arch
 * that has not been seen failing there.
 */
export function nextFixAction(p: HostPreflightResult, tried: ReadonlySet<HostFixAction>, ctx: { prebuiltDtach?: boolean } = {}): HostFixAction | null {
  const claudeBroken = !p.claude.found || (p.claude.needsNode === true && p.claude.nodeFound === false)
  if (claudeBroken && !tried.has('install-claude-native')) return 'install-claude-native'
  if (!claudeBroken && !p.claude.error && p.claude.versionOk === false) {
    const update = fixActionFor('claude_outdated', p)
    if (update && !tried.has(update)) return update
  }
  if (p.dtach.found) return null
  // A compiler only matters while dtach is missing, and not at all while a
  // prebuilt can stand in. A Mac's compiler comes with the Command Line Tools,
  // which only a human can accept.
  if (!p.compiler.found && !ctx.prebuiltDtach && p.platform !== 'darwin' && !tried.has('install-compiler')) return 'install-compiler'
  if ((p.compiler.found || ctx.prebuiltDtach) && !tried.has('build-dtach')) return 'build-dtach'
  return null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function lastLine(log: string): string | undefined {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1]!.slice(0, 200) : undefined
}

/** Prefix of the transport error fixDtach reports when ssh never reached the host. */
const SSH_FAILED = 'ssh failed: '

/** Quote a path for a copyable shell line only when it needs it. */
function shellArg(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'"
}

/**
 * What one fix attempt came back with. `transportError`: the host never
 * answered (socket closed, timeout, not connected, ssh down), so it was no
 * attempt. `daemonError`: the daemon answered with a refusal of its own.
 */
export interface FixOutcome {
  result: (Partial<HostFixResult> & { source?: string }) | null
  transportError?: string
  daemonError?: string
}

/** The outcome → the record the UI renders. */
export function describeFixOutcome(action: HostFixAction, outcome: FixOutcome, finishedAt: number): HostFixRecord {
  const { result: raw, transportError, daemonError } = outcome
  if (transportError) {
    const code = transportError.startsWith(SSH_FAILED) ? 'ssh-failed' : 'connection-lost'
    return { action, ok: false, error: code, finishedAt, text: `${FAILED_PREFIX[action]} (${REASONS[code]})`, detail: transportError.slice(0, 200) }
  }
  if (!raw) {
    // The daemon's own words are the reason: they say what is wrong there.
    const said = (daemonError ?? '').trim().slice(0, 160)
    return {
      action, ok: false, error: 'daemon-error', finishedAt,
      text: `${FAILED_PREFIX[action]} (${said ? `the host said: ${said}` : REASONS['no-answer']})`,
      ...(said ? { detail: said } : {}),
    }
  }
  const error = str(raw.error)
  const record: HostFixRecord = { action, ok: raw.ok === true, finishedAt, text: '' }
  if (raw.needsPassword === true) record.needsPassword = true
  if (raw.skipped === true) record.skipped = true
  if (error) record.error = error
  if (record.ok) {
    const version = str(raw.claude?.version)
    record.text = action === 'install-claude-native'
      ? `${record.skipped ? 'Claude Code' : 'Installed Claude Code'}${version ? ` ${version}` : ''}${record.skipped ? ' is installed' : ''}`
      : action === 'update-claude'
        ? (record.skipped ? `Claude Code${version ? ` ${version}` : ''} is up to date` : `Updated Claude Code${version ? ` to ${version}` : ''}`)
      : action === 'install-compiler'
        ? (record.skipped ? 'A C compiler is installed' : 'Installed gcc')
        : record.skipped ? 'dtach is installed'
          : raw.source === 'prebuilt' ? 'Installed dtach, so terminals here survive a disconnect'
            : 'Built dtach, so terminals here survive a disconnect'
    return record
  }
  const shadowedBy = error === 'shadowed' ? str(raw.shadowedBy) : undefined
  if (shadowedBy) {
    // Installing again would change nothing: the other claude is what wins.
    record.text = `Installed the native Claude Code, but the claude at ${shadowedBy} comes first on PATH`
      + ' (remove it, or put ~/.local/bin first on PATH)'
    record.command = `rm ${shellArg(shadowedBy)}`
  } else {
    record.text = `${FAILED_PREFIX[action]} (${(error && REASONS[error]) || error || 'unknown error'})`
    const command = str(raw.manualCommand)
    if (command) record.command = command
  }
  const detail = lastLine(String(raw.log ?? ''))
  if (detail) record.detail = detail
  return record
}

/**
 * A thrown send error that means the host never answered. Anything else the
 * daemon SAID (a handler failure, a drain refusal, an unknown command) is a real
 * attempt: retrying it on every connect would repeat the same answer forever.
 */
export function isTransportError(message: string): boolean {
  return /connection closed|not connected|ws not open|command timeout|timed out|socket|ECONNRESET|EPIPE|ECONNREFUSED/i.test(message)
}

/** What the terminal's own provisioning answered (DtachResolution, loosely). */
export interface DtachProvisionOutcome {
  kind: string
  source?: string
  stderr?: string
}

export interface AutofixIo {
  conn: PreflightConnection
  /** Fixes already tried on this host (shared across rounds; this adds to it). */
  tried: Set<HostFixAction>
  /** Re-run host.preflight and store it; null when it failed. */
  preflight: () => Promise<HostPreflightResult | null>
  /** A usable prebuilt dtach exists for this host (planner input, see nextFixAction). */
  prebuiltDtach: () => boolean
  /** The terminal's provisioning, forced fresh: upload a prebuilt or compile, over ssh. */
  provisionDtach: () => Promise<DtachProvisionOutcome>
  /** The prebuilt was offered and did not run there: plan as if there were none. */
  onPrebuiltUnusable: () => void
  onStart: (fixing: HostFixing) => void
  onFinish: (record: HostFixRecord, result: Partial<HostFixResult> | null) => void
  /** The dtach source for build-dtach (base64 by file name). */
  dtachSources: () => Promise<Record<string, string>>
  now: () => number
  /** The floor update-claude must reach (the server's configured model). */
  minClaudeVersion?: string
}

/** Fields a finished terminal provisioning maps to, in host.fix's own result shape. */
function provisionResult(res: DtachProvisionOutcome): Partial<HostFixResult> & { source?: string } {
  if (res.kind === 'ok') {
    const already = res.source === 'walnut' || res.source === 'system'
    return { action: 'build-dtach', ok: true, ...(already ? { skipped: true } : {}), ...(res.source ? { source: res.source } : {}) }
  }
  return { action: 'build-dtach', ok: false, error: res.kind === 'no_compiler' ? 'no-compiler' : 'build-failed', log: res.stderr ?? '' }
}

/** One host.fix RPC → its outcome. Shared with the local machine's fixes (local-readiness.ts). */
export async function sendHostFix(conn: PreflightConnection, action: HostFixAction, params: Record<string, unknown>): Promise<FixOutcome> {
  let reply: { ok: boolean; error?: string; [key: string]: unknown }
  try {
    reply = await conn.send('host.fix', { ...params, action }, HOST_FIX_TIMEOUT_MS[action])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return isTransportError(message) ? { result: null, transportError: message } : { result: null, daemonError: message }
  }
  if (reply.ok && reply.result && typeof reply.result === 'object') return { result: reply.result as Partial<HostFixResult> }
  return { result: null, daemonError: reply.error || '' }
}

async function sendFix(io: AutofixIo, action: HostFixAction): Promise<FixOutcome> {
  const params: Record<string, unknown> = {}
  try {
    if (action === 'build-dtach') params.sources = await io.dtachSources()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return isTransportError(message) ? { result: null, transportError: message } : { result: null, daemonError: message }
  }
  if (action === 'update-claude' && io.minClaudeVersion) params.minClaudeVersion = io.minClaudeVersion
  return sendHostFix(io.conn, action, params)
}

/**
 * build-dtach: the terminal's provisioning first (prebuilt upload, or an ssh
 * compile), then the daemon's own compile only when that left no dtach and the
 * host has a compiler.
 */
async function fixDtach(io: AutofixIo, current: HostPreflightResult): Promise<FixOutcome> {
  let res: DtachProvisionOutcome
  try { res = await io.provisionDtach() } catch (err) { res = { kind: 'ssh_failed', stderr: err instanceof Error ? err.message : String(err) } }
  if (res.kind === 'ok') return { result: provisionResult(res) }
  if (res.kind !== 'ssh_failed' && io.prebuiltDtach()) {
    // Any failure but ssh's while a prebuilt was on offer: it does not run there.
    io.onPrebuiltUnusable()
  }
  if (current.compiler.found) return sendFix(io, 'build-dtach')
  // ssh never reached the host: like a dropped connection, that was no attempt.
  if (res.kind === 'ssh_failed') return { result: null, transportError: SSH_FAILED + (res.stderr ?? '').trim().slice(0, 180) }
  return { result: provisionResult(res) }
}

/**
 * One round of fixes on one host, strictly in order. Resolves when there is
 * nothing left to try; never throws.
 */
export async function runHostAutofix(first: HostPreflightResult, io: AutofixIo): Promise<void> {
  let current = first
  // Four fixes exist; build-dtach may run a second time after gcc arrived.
  for (let step = 0; step < 5; step++) {
    const action = nextFixAction(current, io.tried, { prebuiltDtach: io.prebuiltDtach() })
    if (!action) return
    io.tried.add(action)
    io.onStart({ action, startedAt: io.now(), text: fixingText(action) })
    const outcome = action === 'build-dtach' ? await fixDtach(io, current) : await sendFix(io, action)
    const record = describeFixOutcome(action, outcome, io.now())
    io.onFinish(record, outcome.result)
    // The host never got to answer, or was busy with another fix: that was no
    // attempt, so the next connect may try again. Stop this round either way.
    if (outcome.transportError || record.error === 'busy') {
      io.tried.delete(action)
      return
    }
    // A compiler that just arrived can build what a failed prebuilt could not.
    if (action === 'install-compiler' && record.ok && !record.skipped) io.tried.delete('build-dtach')
    const next = await io.preflight()
    if (!next) return
    current = next
  }
}
