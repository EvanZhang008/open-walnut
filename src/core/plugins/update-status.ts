/**
 * Plugin update status: the ONE state model every updatable plugin row (linked checkout,
 * git source, npm source) is rendered from, plus the pure helpers around it.
 *
 * This module is deliberately pure: no fs, no git, no network, no timers except
 * `withDeadline`. The cache that talks to git lives in `update-status-cache.ts`; the
 * browser twin of the types lives in `web/src/components/settings/plugin-update-types.ts`
 * and must be kept in sync by hand (there is no shared package between server and SPA).
 *
 * Rules this file encodes:
 *
 *   - The server derives, the client renders. `deriveUpdateState` runs a FIXED order of
 *     rules (0..6 below) so two rows with the same raw facts can never disagree, and a
 *     test pins every rule.
 *   - A directory that is not there is `missing`, never `unreachable`: the remote is not
 *     the thing that is wrong (rule 0 runs before any error rule).
 *   - A failed fetch keeps the last known answer. Offline, the user needs "which rows to
 *     update when I am back", not nine warnings; `unreachable.lastKnown` carries it.
 *   - Nothing a person sees carries a `user@host:` prefix, an auth-method list or a URL
 *     user name: `scrubGitReason` runs on every displayed reason, and the raw text only
 *     ever rides `detail`.
 */

import { createHash } from 'node:crypto'
import type { CheckResult } from '../plugin-sources.js'
import type { LinkedCheckoutStatus } from './linked-checkout.js'

// ── Constants ──

/** A passive GET inside this window answers from cache and never fetches. */
export const PLUGIN_UPDATE_MIN_INTERVAL_MS = 600_000
/** One row's fetch + count. Past it the row is `unreachable` (cause timeout). */
export const ROW_CHECK_DEADLINE_MS = 8_000
/** The whole batch. Rows still pending at this point are marked timed out. */
export const BATCH_DEADLINE_MS = 20_000
/** The three no-network commands recomputed for a linked checkout on every GET. */
export const LOCAL_FACTS_DEADLINE_MS = 2_000

export const ROW_TIMEOUT_REASON = 'Timed out after 8 s'
export const CHECKOUT_MOVED_REASON = 'The checkout moved since the last check.'
export const UNSUPPORTED_HINT_NO_UPSTREAM = 'This branch has no upstream. Push it or set one, then check again.'
export const UNSUPPORTED_HINT_DETACHED = 'The checkout is not on a branch. Check out a branch in the checkout, then check again.'
export const LOCK_TRANSIENT_HINT = 'Another git command was running; retry in 30 s.'

// ── State model (spec section 4) ──

export type UnreachableCause = 'network' | 'auth' | 'timeout' | 'unknown'
export type GitFailureCause = UnreachableCause | 'lock'

export type UpdateState =
  | { kind: 'unchecked'; reason?: string }
  | { kind: 'checking' }
  | { kind: 'current'; ahead?: number }
  | { kind: 'available'; behind?: number; toVersion?: string; ahead?: number }
  | { kind: 'dirty'; behind?: number | null }
  | { kind: 'diverged'; behind: number; ahead: number }
  | { kind: 'missing' }
  | {
      kind: 'unreachable'
      cause: UnreachableCause
      lastKnown?: 'current' | 'available' | 'dirty' | 'diverged' | 'unchecked'
      reason: string
      /** The counts (or version) behind `lastKnown`, so a stale chip still says "3 commits behind". */
      behind?: number | null
      ahead?: number
      toVersion?: string
    }
  | { kind: 'unsupported'; reason: string; hint: string }

export type UpdateKind = UpdateState['kind']

export interface UpdateStatusRow {
  state: UpdateState
  /** ISO time of the last completed network check for this row, or null when never. */
  checkedAt: string | null
  target?: { kind: 'linked' | 'git' | 'npm'; toRef?: string }
  /** Raw (masked) git or npm text for a Details disclosure. Never rendered inline. */
  detail?: string
  /** A lock collision: the previous entry was kept and the client may retry in 30 s. */
  transient?: boolean
  /** An update for this rowKey is in flight. */
  busy?: boolean
}

export interface PluginUpdatesResponse {
  /** Max `checkedAt` over rows; the header time. */
  checkedAt: string | null
  minIntervalMs: number
  /** A batch check is running; the client polls until this is false. */
  refreshing: boolean
  rows: Record<string, UpdateStatusRow>
  /** pluginId -> rowKey (several linked plugins share one checkout, so one row). */
  rowKeyOf: Record<string, string>
  /** Row keys the LAST batch actually issued a check for. */
  attempted?: number
  failed?: number
  /** Every attempted row failed with cause network: the client folds it into one header line. */
  allNetworkFailed?: boolean
}

/** What a check produced, before derivation. */
export type RawCheck =
  | { kind: 'linked'; status: LinkedCheckoutStatus; missing?: boolean }
  | { kind: 'git' | 'npm'; result: CheckResult; cloned: boolean }

// ── Row keys ──

/** Linked rows are keyed by the checkout, not the plugin: siblings share one fetch and one state. */
export function linkedRowKey(checkoutRealpath: string): string {
  return `linked:${createHash('sha1').update(checkoutRealpath).digest('hex').slice(0, 12)}`
}

export function sourceRowKey(slug: string): string {
  return `source:${slug}`
}

/** `@acme/plugin@1.3.0` -> `1.3.0`; `acme-plugin@2.0.0` -> `2.0.0`. A scoped name has TWO `@`. */
export function npmToVersion(resolved: string): string {
  const at = resolved.lastIndexOf('@')
  return at > 0 ? resolved.slice(at + 1) : resolved
}

// ── Failure classification (spec section 5.4) ──

const FAILURE_PATTERNS: ReadonlyArray<readonly [GitFailureCause, RegExp]> = [
  // Walnut's own deadline text (route or cache) is a timeout, not a network verdict about the remote.
  ['timeout', /^Timed out after \d+ s$/],
  ['lock', /cannot lock ref|index\.lock|unable to create .*lock/i],
  ['auth', /permission denied|authentication failed|could not read username|host key verification failed|invalid credentials/i],
  ['network', /could not resolve host|timed out|network is unreachable|connection refused|could not connect/i],
]

/** The cause a fixed table assigns to a git stderr, plus the scrubbed one-line reason. */
export function classifyGitFailure(stderr: string): { cause: GitFailureCause; reason: string } {
  const text = stderr ?? ''
  for (const [cause, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(text)) return { cause, reason: scrubGitReason(text) }
  }
  return { cause: 'unknown', reason: scrubGitReason(text) }
}

/** The one line of a git failure worth showing a person: no exit code, no "Please make sure" advice. */
export function gitReasonGist(message: string): string {
  const lines = message
    .replace(/^git exited \d+:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^please make sure|^and the repository exists|^fatal: could not read from remote/i.test(line))
  return (lines[0] ?? message).replace(/\.$/, '')
}

export const REASON_CAP = 120

/** A bare `host.tld[:port]` token (a hostname names a private remote as surely as a URL does). */
const HOSTNAME_TOKEN = /(?<![\w/.'@-])(?:[a-z0-9-]+\.)+([a-z]{2,})(?::\d+)?(?![\w/.-])/gi
/** Dotted tokens that are file names, not hosts: `index.lock`, `plugins.git`, `manifest.json`. */
const FILE_SUFFIXES = new Set(['git', 'lock', 'json', 'md', 'txt', 'js', 'mjs', 'cjs', 'ts', 'yaml', 'yml', 'pack', 'idx'])

/** Cut at a word boundary under `cap` and end with an ellipsis, so a suffix never glues onto a half word. */
export function capReason(text: string, cap = REASON_CAP): string {
  if (text.length <= cap) return text
  const head = text.slice(0, cap - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > cap / 2 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '')}…`
}

/**
 * Strip what must never reach a tooltip, a feedback line or an aria-label: the
 * `user@host:` prefix ssh puts on its errors, the auth-method list
 * `(keyboard-interactive,publickey)`, any URL (host, org and repo included: they name a
 * private remote), any absolute path (only the last segment survives, so
 * `'/srv/repos/acme.git' does not appear…` reads `'acme.git' does not appear…`), and the
 * `fatal:` and exit-code framing. Capped at 120 chars with an ellipsis.
 */
export function scrubGitReason(text: string): string {
  const gist = gitReasonGist(text ?? '')
  const scrubbed = gist
    .replace(/^\S+@\S+:\s*/, '')
    .replace(/\([a-z-]+(,[a-z-]+)*\)/g, '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*[^\s'":.,;)]/gi, 'the remote')
    .replace(/(^|[\s'"(])(?:\.\/|~\/|\/)(?:[^\s'"/]+\/)*([^\s'"/]+)\/?/g, '$1$2')
    .replace(/\b[\w.-]+@[\w-]+(?:\.[\w-]+)+(?::[^\s'"]*[^\s'":])?/g, 'the remote')
    .replace(HOSTNAME_TOKEN, (token: string, tld: string) => (FILE_SUFFIXES.has(tld.toLowerCase()) ? token : 'the remote'))
    .replace(/(^|\s)(?:fatal|error|warning):\s*/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return capReason(scrubbed)
}

/** The one sentence a feedback line says for a failed git action; the raw text rides `detail`. */
export function gitFailureSentence(cause: GitFailureCause, scrubbedReason?: string): string {
  switch (cause) {
    case 'network':
    case 'timeout':
      return 'the remote could not be reached.'
    case 'auth':
      return 'your credentials for the remote were refused.'
    case 'lock':
      return 'another git command was running; try again.'
    default: {
      const reason = (scrubbedReason ?? '').replace(/[.!?…]$/, '')
      if (!reason) return 'git did not finish.'
      const lead = /^[A-Z][a-z]/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason
      return `${lead}.`
    }
  }
}

/** Any credential that rode into a git message, in any position (twin of linked-checkout's maskMessage, kept pure here). */
export function maskCredentials(message: string): string {
  return message.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@')
}

/** Classify a raw git failure into what a person sees and what the Details disclosure holds. */
export function describeGitFailure(raw: string): { cause: GitFailureCause; sentence: string; reason: string } {
  const { cause, reason } = classifyGitFailure(raw)
  return { cause, reason, sentence: gitFailureSentence(cause, reason) }
}

// ── Derivation (spec section 4, rules 0..6 in this fixed order) ──

export type LastKnownKind = NonNullable<Extract<UpdateState, { kind: 'unreachable' }>['lastKnown']>

/** The kind an `unreachable` row should remember from `state`, or undefined when there is none worth keeping. */
export function lastKnownKindOf(state: UpdateState | undefined): LastKnownKind | undefined {
  if (!state) return undefined
  switch (state.kind) {
    case 'current':
    case 'available':
    case 'dirty':
    case 'diverged':
    case 'unchecked':
      return state.kind
    case 'unreachable':
      return state.lastKnown
    default:
      return undefined
  }
}

/** The numbers (or npm version) a state carries, so an `unreachable` row can keep saying "3 commits behind". */
export function countsOf(state: UpdateState | undefined): { behind?: number | null; ahead?: number; toVersion?: string } {
  if (!state) return {}
  const out: { behind?: number | null; ahead?: number; toVersion?: string } = {}
  if ('behind' in state && state.behind !== undefined) out.behind = state.behind
  if ('ahead' in state && typeof state.ahead === 'number') out.ahead = state.ahead
  if ('toVersion' in state && state.toVersion) out.toVersion = state.toVersion
  return out
}

/** Build the `unreachable` state: cause, the last known kind and its counts, and the scrubbed reason. */
export function unreachableState(
  cause: GitFailureCause,
  lastKnownState: UpdateState | undefined,
  reason: string,
  fallbackLastKnown?: LastKnownKind,
): UpdateState {
  const lastKnown = lastKnownKindOf(lastKnownState) ?? fallbackLastKnown
  return {
    kind: 'unreachable',
    cause: cause === 'lock' ? 'unknown' : cause,
    ...(lastKnown ? { lastKnown } : {}),
    reason: reason || 'Could not reach the remote',
    ...countsOf(lastKnownState),
  }
}

/** Rules 2..6 for a linked status whose counts are usable (fetched or not). */
function deriveLinkedCounts(status: LinkedCheckoutStatus): UpdateState {
  const behind = status.behind
  const ahead = status.ahead ?? 0
  if (behind === null) {
    const detached = status.branch === 'HEAD' || /detached/i.test(status.reason ?? '')
    return {
      kind: 'unsupported',
      reason: status.reason ?? 'There is no upstream to compare against',
      hint: detached ? UNSUPPORTED_HINT_DETACHED : UNSUPPORTED_HINT_NO_UPSTREAM,
    }
  }
  if (status.dirty) return { kind: 'dirty', behind }
  if (behind > 0 && ahead > 0) return { kind: 'diverged', behind, ahead }
  if (behind > 0) return { kind: 'available', behind, ...(ahead > 0 ? { ahead } : {}) }
  return ahead > 0 ? { kind: 'current', ahead } : { kind: 'current' }
}

const MISSING_TEXT = /\bENOENT\b|not a git (repository|checkout)|no such file or directory/i

/**
 * Turn a raw check into the ONE state the row renders. `prev` is the previous state for
 * the row (from cache), consulted only for `unreachable.lastKnown`.
 */
export function deriveUpdateState(raw: RawCheck, prev?: UpdateState): UpdateState {
  if (raw.kind === 'linked') {
    const { status } = raw
    // Rule 0: the checkout is gone or is not a repository.
    if (raw.missing || (status.reason && MISSING_TEXT.test(status.reason) && !status.fetched && status.behind === null)) {
      return { kind: 'missing' }
    }
    // Rule 1: the fetch failed. Counts still describe the LAST fetch, so they give lastKnown.
    if (!status.fetched) {
      const { cause, reason } = classifyGitFailure(status.reason ?? '')
      // Counts that came with the failed check still describe the last fetch; without
      // usable counts (no upstream), the previous state is the memory.
      const fromCounts = deriveLinkedCounts(status)
      const remembered = lastKnownKindOf(fromCounts) ? fromCounts : prev
      return unreachableState(cause, remembered, reason)
    }
    // Rules 2..6.
    return deriveLinkedCounts(status)
  }

  const { result } = raw
  // Rule 0: source not cloned here, or the directory is gone.
  if (!raw.cloned || (result.error && MISSING_TEXT.test(result.error))) return { kind: 'missing' }
  // Rule 1: the fetch or the registry lookup failed.
  if (result.error) {
    const { cause, reason } = classifyGitFailure(result.error)
    return unreachableState(cause, prev, reason)
  }
  // Rule 5: something newer.
  if (raw.kind === 'npm') {
    if (result.updateAvailable) {
      return { kind: 'available', ...(result.resolved ? { toVersion: npmToVersion(result.resolved) } : {}) }
    }
    return { kind: 'current' }
  }
  if (result.behind > 0 || result.updateAvailable) return { kind: 'available', behind: result.behind }
  // Rule 6.
  return { kind: 'current' }
}

// ── Deadlines and unattended git ──

/**
 * Race `p` against a clock. On timeout the caller's fallback answers and the original
 * promise is left to settle on its own (its rejection is swallowed so nothing goes
 * unhandled). This is how every route here answers degraded instead of hanging.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      p.catch(() => undefined)
      try {
        resolve(onTimeout())
      } catch (error) {
        reject(error)
      }
    }, ms)
    timer.unref?.()
    p.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The environment for a fetch nobody is watching: no terminal prompt, a no-op askpass,
 * and ssh in batch mode. `GIT_SSH_COMMAND` is injected ONLY when the user has not set
 * one: their command may not be ssh at all, so appending a flag to it is not safe.
 */
export function fetchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/true' }
  if (!base.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
  return env
}
