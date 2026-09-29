/**
 * ONE model of "what is wrong with this remote host", read by every surface:
 * the home banner, the folder picker, Settings › Remote Hosts, the session
 * error bar, and the server's Start refusal (the 409 body). No surface builds
 * its own sentence. Pure: no node imports, so the browser imports this exact
 * file through the `@open-walnut/host-problem` alias.
 */

/** Mirrors HostConnectErrorKind (host-connect-hint.ts), kept local so this file stays import-free. */
export type HostFailureKind =
  | 'auth' | 'host_key' | 'cert_expired' | 'agent_missing' | 'proxy_login' | 'proxy' | 'shell_noise'
  | 'dns' | 'unreachable' | 'refused' | 'timeout' | 'runtime' | 'daemon'
  | 'ephemeral' | 'listing' | 'unknown'

export type HostPhaseWire =
  | 'idle' | 'ssh' | 'probe' | 'install-runtime' | 'upload' | 'start' | 'tunnel'
  | 'handshake' | 'connected' | 'reconnecting' | 'failed' | 'queued' | 'off'

export interface HostReadinessProblemInput {
  kind: string
  message: string
  commands: string[]
  fix?: { action: string; state: 'running' | 'failed'; text: string; needsPassword?: boolean; detail?: string }
}

/** The structural subset of the host:status wire frame this model reads. */
export interface HostStatusInput {
  host: string
  label?: string
  hostname?: string
  connected: boolean
  phase: HostPhaseWire | string
  error?: string
  kind?: HostFailureKind | string
  hint?: string
  retryable?: boolean
  /** Epoch ms of the next attempt Walnut really has scheduled (credential plan or slow probe). */
  retryAt?: number
  /** The last failure seen while reconnecting (the phase itself stays 'reconnecting'). */
  lastError?: string
  lastKind?: HostFailureKind | string
  lastHint?: string
  /** Server epoch ms when the current reconnect began. */
  reconnectSince?: number
  /** Server epoch ms when the current connect attempt began. */
  attemptStartedAt?: number
  /** Server epoch ms when the current connection came up. */
  connectedAt?: number
  /** Server clock when the frame was built (skew correction). */
  serverNow?: number
  at?: number
  warnings?: string[]
  removed?: true
  readiness?: {
    problems?: HostReadinessProblemInput[]
    checkedAt?: number
    claude?: { version?: string; minVersion?: string; installMethod?: string }
    fixing?: { action: string; text: string; startedAt?: number }
  }
}

export type HostProblem =
  | { type: 'off' }
  | {
      type: 'connect'; kind: string; headline: string; hint: string; summary: string
      retryable: boolean; retryAt?: number; dismissKey: string
    }
  | { type: 'reconnecting'; kind?: string; headline?: string; hint?: string; since: number }
  | { type: 'readiness'; problem: HostReadinessProblemInput; blocking: boolean; dismissKey: string }
  | { type: 'listing'; hint: string; summary: string; headline: string }

export type HostProblemType = HostProblem['type']

/** Start is refused (dot turns warn, banner row) for these readiness kinds. */
export const BLOCKING_READINESS_KINDS: readonly string[] = [
  'claude_missing', 'claude_needs_node', 'claude_error', 'claude_outdated', 'claude_not_logged_in',
]
/** Refused with allowOverride: an old or signed-out CLI may still work for the user. */
export const OVERRIDABLE_KINDS: readonly string[] = ['claude_outdated', 'claude_not_logged_in']
/**
 * The readiness kinds the HOME BANNER shows: the ones that stop core Walnut work on the host
 * (no session can start at all). A version floor for one model (`claude_outdated`) is not
 * that: sessions still run with another model, so it stays off the banner and lives where the
 * host is about to be used (the picker note, the Start gate) and in Settings. User rule,
 * 2026-09-26: the banner is for core features with no dependency, a terminal that does not
 * work, a host that does not connect.
 */
export const BANNER_READINESS_KINDS: readonly string[] = [
  'claude_missing', 'claude_needs_node', 'claude_error', 'claude_not_logged_in',
]
/** A reconnect that meets one of these will not heal itself: the screen shows it as failed. */
export const STANDING_FAILURE_KINDS: readonly string[] = ['auth', 'host_key', 'dns', 'cert_expired', 'agent_missing', 'proxy_login']
/** Waiting on the user's login (one row for all hosts that share the kind). */
export const CREDENTIAL_WAIT_KINDS: readonly string[] = ['cert_expired', 'agent_missing', 'proxy_login']
/** Opening the picker never re-dials a host that failed with one of these (key taps, agent prompts). */
export const NO_PREWARM_KINDS: readonly string[] = [
  'auth', 'host_key', 'cert_expired', 'agent_missing', 'proxy_login', 'dns', 'shell_noise', 'runtime',
]
/** Their detail is a filesystem or daemon log line, not SSH output. */
export const DETAILS_NOT_SSH_KINDS: readonly string[] = ['listing', 'daemon', 'runtime']
/** Readiness notes that explain, never ask for action. */
export const INFO_ONLY_KINDS: readonly string[] = ['daemon_dir_fallback']

export const OFF_PHASE_LABEL = 'Off on this test server'
export const REMOTE_OFF_NOTE = 'Remote hosts are off on this test server.'
export const HOST_REMOVED_NOTE = 'This host is no longer in Settings.'
/**
 * How long a fresh connection may go without a readiness answer before the dot
 * stops pulsing: the server's PREFLIGHT_TIMEOUT_MS (14s, host-readiness.ts) + 5s.
 * Hardcoded to keep this file import-free; a ratchet test reads the server constant.
 */
export const READINESS_ANSWER_GRACE_MS = 14_000 + 5_000

// ── Sentences ────────────────────────────────────────────────────────────

const ELLIPSIS = '…'

/** `/srv/…/deep/data`: first segment, U+2026, then the trailing segments that fit. */
export function middleTruncatePath(path: string, max = 40): string {
  const abs = path.startsWith('/')
  const segs = path.split('/').filter(Boolean)
  if (segs.length <= 4 && path.length <= max) return path
  if (segs.length < 3) return path
  const head = (abs ? '/' : '') + segs[0]
  const two = `${head}/${ELLIPSIS}/${segs.slice(-2).join('/')}`
  if (two.length <= max && segs.length > 3) return two
  return `${head}/${ELLIPSIS}/${segs[segs.length - 1]}`
}

/** 'A', 'A and B', 'A, B and C'. */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** The bold first line of a failure, by kind (spec table 2.1). `label` is the host's display name. */
export function hostFailureHeadline(
  kind: string | undefined,
  label: string,
  opts: { path?: string; giveUp?: boolean } = {},
): string {
  if (opts.giveUp) return `Still connecting to ${label} after several minutes`
  switch (kind) {
    case 'cert_expired': return `Could not connect to ${label}: SSH certificate expired`
    case 'agent_missing': return `Could not connect to ${label}: no SSH agent key`
    case 'proxy_login': return `Could not connect to ${label}: SSH proxy login expired`
    case 'timeout': return `Connecting to ${label} timed out`
    case 'runtime': return `${label} has no runtime for the session daemon`
    case 'daemon': return `The session daemon on ${label} did not start`
    case 'ephemeral': return `${label} is off on this test server`
    case 'listing':
      return opts.path ? `Could not list ${middleTruncatePath(opts.path)} on ${label}` : `Could not list this folder on ${label}`
    default: return `Could not connect to ${label}`
  }
}

/** One row for several hosts waiting on the same login: 'Could not connect to A and B: SSH certificate expired'. */
export function credentialGroupHeadline(labels: readonly string[], kind: string): string {
  return hostFailureHeadline(kind, joinLabels(labels))
}

/** The first sentence, ignoring dots inside `code` and inside version numbers. */
export function firstSentence(text: string): string {
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') inCode = !inCode
    else if (!inCode && (ch === '.' || ch === '!' || ch === '?') && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return text.slice(0, i + 1)
    }
  }
  return text
}

function formatDuration(ms: number, round: (n: number) => number): string {
  const total = Math.max(0, round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${total % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** '42s', '3m 12s', '1h 0m' (no seconds from an hour up). Rounds up: 0.4s left reads '1s'. */
export function formatRetryIn(ms: number): string {
  return formatDuration(ms, Math.ceil)
}

/** Elapsed time in the same three formats, rounded down. */
export function formatElapsed(ms: number): string {
  return formatDuration(ms, Math.floor)
}

/** How long a passed retryAt may read 'Trying again...' before the line is dropped. */
export const RETRY_STALE_MS = 30_000

/**
 * The countdown line. Only a real schedule (`retryAt`) earns one. Once the
 * moment passed it reads 'Trying again...'; when it passed more than 30s ago
 * and no newer frame arrived (tab asleep, server busy), there is no line at all.
 */
export function retryCountdownText(retryAt: number | undefined, now: number, lastFrameAt?: number): string | null {
  if (typeof retryAt !== 'number' || !Number.isFinite(retryAt)) return null
  const left = retryAt - now
  if (left > 0) return `Walnut tries again in ${formatRetryIn(left)}`
  const newerFrame = typeof lastFrameAt === 'number' && lastFrameAt > retryAt
  if (-left > RETRY_STALE_MS && !newerFrame) return null
  return 'Trying again...'
}

/** How long the success sentence stays up after a problem clears (every surface). */
export const HOST_READY_HOLD_MS = 3_000

/** The ONE success sentence (banner, Settings, error bar). */
export function hostReadySentence(label: string, version?: string): string {
  return version ? `✓ ${label} is ready (Claude Code ${version})` : `✓ ${label} is ready`
}

export interface AutofixProgress {
  /** Full line, e.g. 'Updating Claude Code on Dev box... 42s'. */
  text: string
  /** The line without the timer (the timer part is aria-hidden). */
  base: string
  /** '42s' / '3m 5s', or '' in the first 5s. */
  elapsed: string
  /** After 3 minutes the user may re-check by hand. */
  showCheckAgain: boolean
}

export const AUTOFIX_SHOW_ELAPSED_MS = 5_000
export const AUTOFIX_STILL_MS = 180_000

export function autofixProgressText(
  verb: 'update' | 'install', label: string, startedAt: number | undefined, now: number,
): AutofixProgress {
  const ing = verb === 'install' ? 'Installing' : 'Updating'
  const ms = typeof startedAt === 'number' ? Math.max(0, now - startedAt) : 0
  if (ms >= AUTOFIX_STILL_MS) {
    const base = `Still ${ing.toLowerCase()} Claude Code on ${label}...`
    const elapsed = formatElapsed(ms)
    return { text: `${base} ${elapsed}`, base, elapsed, showCheckAgain: true }
  }
  const base = `${ing} Claude Code on ${label}...`
  const elapsed = ms >= AUTOFIX_SHOW_ELAPSED_MS ? formatElapsed(ms) : ''
  return { text: elapsed ? `${base} ${elapsed}` : base, base, elapsed, showCheckAgain: false }
}

// ── The model ────────────────────────────────────────────────────────────

const labelOf = (s: Pick<HostStatusInput, 'host' | 'label'>): string => s.label || s.host

/** Phases where a connect is in flight (as opposed to done / failed / never tried / off). */
export function isConnectingPhaseWire(phase: string | undefined): boolean {
  return !!phase && !['idle', 'connected', 'failed', 'off'].includes(phase)
}

/** A readiness answer counts only when it was asked on THIS connection. */
export function readinessAnsweredThisConnection(s: HostStatusInput): boolean {
  const at = s.readiness?.checkedAt
  if (typeof at !== 'number') return false
  return typeof s.connectedAt !== 'number' || at >= s.connectedAt
}

/** The first blocking readiness problem, or undefined. */
export function blockingReadinessProblem(s: HostStatusInput | undefined): HostReadinessProblemInput | undefined {
  return s?.readiness?.problems?.find((p) => BLOCKING_READINESS_KINDS.includes(p.kind))
}

/** The first readiness problem the home banner shows for a host (BANNER_READINESS_KINDS). */
export function bannerReadinessProblem(s: HostStatusInput | undefined): HostReadinessProblemInput | undefined {
  return s?.readiness?.problems?.find((p) => BANNER_READINESS_KINDS.includes(p.kind))
}

export function readinessDismissKey(s: HostStatusInput, kind: string): string {
  const c = s.readiness?.claude
  return `${s.host}|${kind}|${c?.minVersion || c?.version || ''}`
}

/**
 * The one thing wrong with a host, by priority:
 * off > connect (failed) > reconnecting > readiness (blocking) > nothing.
 * Non-blocking readiness lines, daemon_dir_fallback and warnings are Settings-only.
 * `surface: 'banner'` narrows the readiness step to BANNER_READINESS_KINDS.
 */
export function hostProblemOf(
  status: HostStatusInput | undefined, env: { replica?: boolean; surface?: 'banner' } = {},
): HostProblem | null {
  if (!status || status.removed) return null
  const label = labelOf(status)
  if (status.phase === 'off' || (status.phase === 'failed' && status.kind === 'ephemeral')) return { type: 'off' }
  if (status.phase === 'failed' && !status.connected) {
    const kind = status.kind || 'unknown'
    return {
      type: 'connect', kind, headline: hostFailureHeadline(kind, label), hint: status.hint ?? '',
      summary: status.error ?? '', retryable: status.retryable !== false,
      ...(typeof status.retryAt === 'number' ? { retryAt: status.retryAt } : {}),
      dismissKey: `${status.host}|connect`,
    }
  }
  if (status.phase === 'reconnecting' && !status.connected) {
    const kind = status.lastKind || undefined
    return {
      type: 'reconnecting',
      ...(kind ? { kind, headline: hostFailureHeadline(kind, label), hint: status.lastHint ?? '' } : {}),
      since: status.reconnectSince ?? status.attemptStartedAt ?? status.at ?? 0,
    }
  }
  if (status.connected && readinessAnsweredThisConnection(status)) {
    const problem = env.surface === 'banner' ? bannerReadinessProblem(status) : blockingReadinessProblem(status)
    if (problem) return { type: 'readiness', problem, blocking: true, dismissKey: readinessDismissKey(status, problem.kind) }
  }
  return null
}

/** The picker's "this folder did not list" note (list-dirs hostError with kind 'listing'). */
export function listingProblemOf(
  hostError: { kind?: string; message?: string; hint?: string } | undefined,
  label: string, path?: string,
): HostProblem | null {
  if (!hostError || hostError.kind !== 'listing') return null
  return {
    type: 'listing', headline: hostFailureHeadline('listing', label, { path }),
    hint: hostError.hint ?? '', summary: hostError.message ?? '',
  }
}

export type HostDotKindV2 = 'connected' | 'checking' | 'warn' | 'connecting' | 'failed' | 'off' | 'unknown'
export interface HostDot { kind: HostDotKindV2; title: string }

/**
 * The dot a host wears, and its one title (spec 4.1). `now` is the SERVER
 * clock (useHostStatus serverNow()), since connectedAt is a server time.
 */
export function hostDotOf(
  status: HostStatusInput | undefined,
  opts: { hydrating?: boolean; now: number; label?: string },
): HostDot {
  if (!status) {
    const l = opts.label ?? ''
    return { kind: 'unknown', title: opts.hydrating ? `${l}: Checking...` : `${l}: Not connected` }
  }
  const l = labelOf(status)
  const p = hostProblemOf(status)
  if (p?.type === 'off') return { kind: 'off', title: `${l}: ${OFF_PHASE_LABEL}` }
  if (p?.type === 'connect') return { kind: 'failed', title: `${l}: ${p.headline}` }
  if (p?.type === 'reconnecting') return { kind: 'connecting', title: `${l}: Reconnecting` }
  if (p?.type === 'readiness') return { kind: 'warn', title: `${l}: ${firstSentence(p.problem.message)}` }
  if (status.connected) {
    const fresh = typeof status.connectedAt === 'number' && opts.now - status.connectedAt < READINESS_ANSWER_GRACE_MS
    if (!readinessAnsweredThisConnection(status) && fresh) return { kind: 'checking', title: `${l}: Checking Claude Code` }
    return { kind: 'connected', title: `${l}: Connected` }
  }
  if (isConnectingPhaseWire(status.phase)) return { kind: 'connecting', title: `${l}: Connecting` }
  if (status.error) return { kind: 'failed', title: `${l}: ${hostFailureHeadline(status.kind, l)}` }
  return { kind: 'unknown', title: `${l}: Not connected` }
}

// ── Actions (spec table 2.2: no fake buttons) ────────────────────────────

export type HostActionId = 'retry' | 'openSettings' | 'connectNow' | 'update' | 'install' | 'checkAgain' | 'startAnyway'
export type HostSurface = 'banner' | 'picker' | 'settings' | 'errorbar'

/** A reconnect younger than this takes no banner row (it usually heals itself). */
export const RECONNECT_BANNER_AFTER_MS = 120_000

/** Which autofix verb answers a readiness problem, when the server can run one. */
export function autofixVerbFor(problem: HostReadinessProblemInput, installMethod?: string): 'update' | 'install' | null {
  if (problem.kind === 'claude_missing' || problem.kind === 'claude_needs_node') return 'install'
  if (problem.kind !== 'claude_outdated') return null
  if (installMethod === 'native') return 'update'
  if (installMethod === 'npm') return 'install'
  return null
}

export function hostActionsFor(
  problem: HostProblem | null,
  opts: {
    surface: HostSurface; replica?: boolean
    /** true derives the verb from the kind; 'update' / 'install' names it. */
    autofixable?: boolean | 'update' | 'install'
    allowOverride?: boolean; reconnectAgeMs?: number
  },
): HostActionId[] {
  if (!problem) return []
  const { surface } = opts
  let out: HostActionId[] = []
  switch (problem.type) {
    case 'off': out = []; break
    case 'connect':
      // Retry is always there (the hint says "then Retry"); retryable only
      // decides whether Walnut retries by itself.
      out = ['retry']
      if (!problem.retryable && surface !== 'settings') out.push('openSettings')
      break
    case 'reconnecting':
      if (surface === 'settings') out = ['connectNow']
      else if (surface === 'banner' && problem.kind && (opts.reconnectAgeMs ?? 0) >= RECONNECT_BANNER_AFTER_MS) out = ['connectNow']
      break
    case 'listing':
      out = surface === 'picker' ? ['retry'] : []
      break
    case 'readiness': {
      const verb = opts.autofixable === true
        ? (problem.problem.kind === 'claude_outdated' ? 'update' : 'install')
        : opts.autofixable || null
      if (surface === 'picker') out = ['checkAgain', 'openSettings']
      else if (surface === 'errorbar') out = ['checkAgain', ...(opts.allowOverride ? ['startAnyway' as const] : []), 'openSettings']
      else if (verb) out = [verb, 'checkAgain']
      else out = surface === 'banner' ? ['checkAgain', 'openSettings'] : ['checkAgain']
      break
    }
  }
  // A replica cannot dial ssh or run a fix; a re-check relays through the Mac.
  if (opts.replica) out = out.filter((a) => a !== 'retry' && a !== 'connectNow' && a !== 'update' && a !== 'install')
  return out
}

// ── Receipts and the Start refusal ───────────────────────────────────────

/**
 * A user-started Retry / Check again that changed nothing still says so:
 * 'Tried again just now: same result' or 'Checked just now: still 2.1.220'.
 */
export function sameResultReceipt(
  before: HostStatusInput | undefined, after: HostStatusInput | undefined, mode: 'connect' | 'readiness',
): string | null {
  const a = hostProblemOf(before)
  const b = hostProblemOf(after)
  if (!a || !b) return null
  if (mode === 'connect') {
    return a.type === 'connect' && b.type === 'connect' && a.kind === b.kind ? 'Tried again just now: same result' : null
  }
  if (a.type !== 'readiness' || b.type !== 'readiness' || a.problem.kind !== b.problem.kind) return null
  const vA = before?.readiness?.claude?.version
  const vB = after?.readiness?.claude?.version
  if (vA !== vB) return null
  return b.problem.kind === 'claude_outdated' && vB ? `Checked just now: still ${vB}` : 'Checked just now: same result'
}

export type HostGateCode = 'host_not_ready' | 'host_unreachable' | 'host_off' | 'host_removed'

export interface HostGateBody {
  error: string
  code: HostGateCode
  kind?: string
  host: string
  headline: string
  hint: string
  allowOverride?: true
}

/** 'Headline. Hint' with no doubled or dangling punctuation. */
export function joinHeadlineHint(headline: string, hint?: string): string {
  const h = headline.trim()
  const t = (hint ?? '').trim()
  // No hint: the headline alone. A sentence keeps its own single period; a
  // headline never grows a dangling '. '.
  if (!t) return h
  return /[.!?:]$/.test(h) ? `${h} ${t}` : `${h}. ${t}`
}

/** The 409 body for a refused Start. Old clients read `error`; new ones render headline + hint. */
export function hostGateBody(input: {
  code: HostGateCode; host: string; kind?: string; headline: string; hint?: string; allowOverride?: boolean
}): HostGateBody {
  const hint = (input.hint ?? '').trim()
  return {
    error: joinHeadlineHint(input.headline, hint),
    code: input.code,
    ...(input.kind ? { kind: input.kind } : {}),
    host: input.host,
    headline: input.headline.trim(),
    hint,
    ...(input.allowOverride ? { allowOverride: true as const } : {}),
  }
}
