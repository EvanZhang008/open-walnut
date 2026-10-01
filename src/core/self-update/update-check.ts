/**
 * Is there a newer open-walnut on npm? One checker per server process.
 *
 * Shape, learned from how other npm-distributed CLIs do it (T3 Code polls a
 * release feed at a fixed cadence and shows a quiet pill; Codex and Gemini ask
 * the registry's `/latest` document and print the install command):
 *
 *   - ONE small GET of the package's dist-tags (`latest`, `nightly`), 5 s
 *     deadline, 20 s after listen (never in the boot fan-out) and then daily. A
 *     failure keeps the last good answer and retries in an hour. In memory only:
 *     the server is long-lived, and a restart re-asks once.
 *   - Two channels, read off the installed version: `x.y.z-nightly.*` follows
 *     the `nightly` tag (main, published on a schedule), anything else follows
 *     `latest` (a tagged release). The update command names the same tag.
 *   - Nothing is downloaded or installed. The status says what is newer and
 *     which command updates THIS install; the user runs it (or `walnut update`).
 *   - A source checkout and a cloud replica never check (install-kind.ts). Tests
 *     never reach the network unless they point WALNUT_UPDATE_REGISTRY_URL at a
 *     stub. WALNUT_NO_UPDATE_CHECK=1 (or the ecosystem's NO_UPDATE_NOTIFIER)
 *     switches it off for anyone.
 *   - A build whose version is unknown (`0.0.0`) is never told to update: every
 *     release would look newer than it.
 */

import { getVersion, isVersionKnown } from '../version.js'
import { detectInstall, PACKAGE_PAGE_URL, type InstallInfo } from './install-kind.js'
import { isNewer, parseVersion } from './version-compare.js'

export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/-/package/open-walnut/dist-tags'

export type UpdateChannel = 'stable' | 'nightly'
export type DistTags = { latest: string | null; nightly: string | null }

/** The dist-tag a channel follows. */
export function tagForChannel(channel: UpdateChannel): 'latest' | 'nightly' {
  return channel === 'nightly' ? 'nightly' : 'latest'
}

/** A nightly build carries `nightly` among its prerelease identifiers; everything else is stable. */
export function channelOf(version: string): UpdateChannel {
  const parsed = parseVersion(version)
  return parsed?.prerelease.some((id) => id === 'nightly') ? 'nightly' : 'stable'
}
export const REGISTRY_TIMEOUT_MS = 5_000
export const FIRST_CHECK_DELAY_MS = 20_000
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000

export type UpdateCheckDisabledReason = 'source' | 'replica' | 'opted-out' | 'test' | 'unknown-version'

export interface UpdateStatus {
  /** False: no check runs in this process; `reason` says why. */
  enabled: boolean
  reason?: UpdateCheckDisabledReason
  install: InstallInfo
  current: string
  /** Which dist-tag this install follows, and the version that tag names right now. */
  channel: UpdateChannel
  /** The newest version on this channel that the last successful check saw; null before the first. */
  latest: string | null
  /** Every channel's version from the last successful check (the card and doctor name the other one). */
  tags: DistTags
  available: boolean
  /** ISO time of the last successful check. */
  checkedAt: string | null
  /** The last failed attempt's message; `latest` and `available` keep the previous answer. */
  error: string | null
  checking: boolean
  /** Where to read about releases when there is no one update command. */
  packageUrl: string
}

export interface UpdateCheckerOptions {
  fetch?: typeof fetch
  registryUrl?: string
  current?: string
  currentKnown?: boolean
  /** Follow this channel instead of the installed version's (`walnut update --channel`). */
  channel?: UpdateChannel
  install?: InstallInfo
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Timer seam for tests; defaults to the globals. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function updateCheckOptedOut(env: Record<string, string | undefined>): boolean {
  const v = env.WALNUT_NO_UPDATE_CHECK
  if (v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false') return true
  return env.NO_UPDATE_NOTIFIER !== undefined && env.NO_UPDATE_NOTIFIER !== ''
}

function isTestEnv(env: Record<string, string | undefined>): boolean {
  return !!(env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === 'test')
}

export function disabledReason(
  install: InstallInfo, env: Record<string, string | undefined>, currentKnown: boolean, registryUrl: string,
): UpdateCheckDisabledReason | null {
  if (install.kind === 'replica') return 'replica'
  if (install.kind === 'source') return 'source'
  if (updateCheckOptedOut(env)) return 'opted-out'
  if (isTestEnv(env) && registryUrl === DEFAULT_REGISTRY_URL) return 'test'
  if (!currentKnown) return 'unknown-version'
  return null
}

/** The registry's dist-tags document (`{ latest, nightly, ... }`), reduced to the two tags followed. */
export async function fetchDistTags(
  url: string, fetchImpl: typeof fetch, timeoutMs = REGISTRY_TIMEOUT_MS,
): Promise<DistTags> {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': `open-walnut/${getVersion()}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`registry answered HTTP ${res.status}`)
  const body = (await res.json()) as Record<string, unknown> | null
  const tag = (name: string): string | null => {
    const v = body?.[name]
    return typeof v === 'string' && parseVersion(v) ? v.trim() : null
  }
  const tags = { latest: tag('latest'), nightly: tag('nightly') }
  if (!tags.latest) throw new Error('registry answer had no latest version')
  return tags
}

export class UpdateChecker {
  private readonly fetchImpl: typeof fetch
  private readonly registryUrl: string
  private readonly now: () => Date
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly disabled: UpdateCheckDisabledReason | null
  private readonly install: InstallInfo
  private readonly current: string
  private readonly channel: UpdateChannel
  private tags: DistTags = { latest: null, nightly: null }
  private checkedAt: string | null = null
  private error: string | null = null
  private inflight: Promise<UpdateStatus> | null = null
  private timer: unknown = null
  private started = false
  private readonly listeners = new Set<(status: UpdateStatus) => void>()

  constructor(opts: UpdateCheckerOptions = {}) {
    const env = opts.env ?? process.env
    this.fetchImpl = opts.fetch ?? fetch
    this.registryUrl = opts.registryUrl ?? env.WALNUT_UPDATE_REGISTRY_URL?.trim() ?? DEFAULT_REGISTRY_URL
    if (!this.registryUrl) this.registryUrl = DEFAULT_REGISTRY_URL
    this.now = opts.now ?? (() => new Date())
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h })
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.current = opts.current ?? getVersion()
    this.channel = opts.channel ?? channelOf(this.current)
    this.install = opts.install ?? detectInstall(undefined, this.channel)
    const known = opts.currentKnown ?? isVersionKnown()
    this.disabled = disabledReason(this.install, env, known, this.registryUrl)
  }

  status(): UpdateStatus {
    const latest = this.tags[tagForChannel(this.channel)]
    const available = latest !== null && isNewer(latest, this.current)
    return {
      enabled: this.disabled === null,
      ...(this.disabled ? { reason: this.disabled } : {}),
      install: this.install,
      current: this.current,
      channel: this.channel,
      latest,
      tags: this.tags,
      available,
      checkedAt: this.checkedAt,
      error: this.error,
      checking: this.inflight !== null,
      packageUrl: PACKAGE_PAGE_URL,
    }
  }

  /** One check, shared by concurrent callers. Disabled checkers answer their status without a fetch. */
  checkNow(): Promise<UpdateStatus> {
    if (this.disabled) return Promise.resolve(this.status())
    if (this.inflight) return this.inflight
    // The status handed out (and given to listeners) is read AFTER the in-flight
    // marker clears, so a caller never sees `checking: true` on a finished check.
    this.inflight = this.run().then(() => {
      this.inflight = null
      const status = this.status()
      for (const fn of this.listeners) {
        try { fn(status) } catch { /* a listener's failure is its own */ }
      }
      return status
    })
    return this.inflight
  }

  /** The fetch and the bookkeeping; never throws. The server logs the outcome through onChecked. */
  private async run(): Promise<void> {
    try {
      this.tags = await fetchDistTags(this.registryUrl, this.fetchImpl)
      this.checkedAt = this.now().toISOString()
      this.error = null
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  /** Called after every completed check (success or failure); returns the unsubscribe. */
  onChecked(fn: (status: UpdateStatus) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Arm the schedule: first check after a delay, then daily (hourly after a failure). Idempotent. */
  start(): void {
    if (this.started || this.disabled) return
    this.started = true
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  private schedule(ms: number): void {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.checkNow().then((s) => {
        if (!this.started) return
        this.schedule(s.error ? RETRY_AFTER_FAILURE_MS : UPDATE_CHECK_INTERVAL_MS)
      })
    }, ms)
  }

  stop(): void {
    this.started = false
    if (this.timer) { this.clearTimer(this.timer); this.timer = null }
  }
}

let shared: UpdateChecker | null = null

/** The process-wide checker (the server starts it after listen; routes and the CLI read it). */
export function getUpdateChecker(): UpdateChecker {
  shared ??= new UpdateChecker()
  return shared
}

/** Stop the schedule and forget the instance (server shutdown; tests between cases). */
export function resetUpdateChecker(): void {
  shared?.stop()
  shared = null
}

/** Tests: make the routes and the CLI read a checker built with stubs (a fake registry, a chosen install). */
export function setUpdateCheckerForTest(checker: UpdateChecker): void {
  shared?.stop()
  shared = checker
}

/**
 * The one-line notice for a terminal (web start, doctor, `walnut update --check`),
 * or null when there is nothing to say.
 */
export function formatUpdateNotice(status: UpdateStatus): string | null {
  if (!status.available || !status.latest) return null
  const channel = status.channel === 'nightly' ? ' (nightly)' : ''
  const head = `A newer Open Walnut is available: ${status.current} → ${status.latest}${channel}.`
  if (status.install.updateCommand) return `${head} Run: ${status.install.updateCommand}`
  return `${head} See ${status.packageUrl}`
}
