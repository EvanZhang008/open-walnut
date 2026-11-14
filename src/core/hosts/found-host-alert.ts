/**
 * A found host (~/.ssh/config, found-hosts.ts) that cannot be added or cannot connect is ONE entry
 * in the Notifications panel, never a block on Home. 2026-11-13, the user, of a Mac he once said
 * Connect to that read "Could not connect" on Home after every reload: "I don't want it keep
 * showing ... Just show it inside notification is fine".
 *
 *   not Linux   its SSH probe named another system (not_linux). The first answer marks the host
 *               (found-host-marks.ts: off, never offered or dialled again) and raises the entry:
 *               what it is, and the one way to add it (join it with a link).
 *   failed      a found host the person said Connect to (found-host-offer.ts consentedFoundHosts)
 *               failed to connect, or keeps failing on a cause that does not heal by itself: the
 *               entry says why, in the words every host surface uses, with its Settings row.
 *
 * One entry per host (dedupKey `found-host:<alias>`), however many failures or reloads: a repeat
 * folds into it. Its recoveryKey is the host's own (`host:<alias>`), so the host connecting
 * retires it (web/server.ts publishRecovery on connect), and a dismissal holds while the cause
 * stands (notifications/dismissed-conditions.ts). A not-Linux host never dials again, so its
 * entry, once dismissed, does not come back.
 *
 * Input: the daemon pool's phase changes (every dial, whoever made it). Only transitions count:
 * a host already raised for a kind is not raised again until it connects, and only a host's
 * first `connected` frame reads the config.
 */

import { log } from '../../logging/index.js'
import type { NewNotification } from '../notifications/store.js'
import { classifyHostConnectError, hintForKind, type HostConnectErrorKind } from '../sessions/host-connect-hint.js'
import { hostFailureHeadline, STANDING_FAILURE_KINDS } from './host-problem.js'
import {
  consentedFoundHosts, foundHostCardKey, notOfferedOf, osOfNotLinuxError, SSH_SETUP_REFUSED_KINDS, type OfferRow,
} from './found-host-offer.js'

/** The fields of a daemon connect state this reads (providers/daemon-connection.ts DaemonConnectState). */
export interface FoundHostPhase {
  host: string
  phase: string
  error?: string
  kind?: string
  lastError?: string
  lastKind?: string
}

type Row = OfferRow & { hostname?: unknown; user?: unknown; port?: unknown }

export interface FoundHostAlertDeps {
  onPhase: (cb: (state: FoundHostPhase) => void) => () => void
  /** The host rows as getConfig reads them. */
  readHosts: () => Promise<Record<string, Row>>
  readNet?: () => Promise<unknown>
  markNotLinux: (alias: string, os: string | undefined) => Promise<boolean>
  clearNotLinux: (alias: string) => Promise<boolean>
  publish: (card: NewNotification) => Promise<void>
}

const SETTINGS_REMOTE_HOSTS = '/settings#remote-hosts'
/** web/src/utils/host-settings-nav.ts hostSettingsHref: the host's own Settings row. */
const hostRowHref = (alias: string) => `/settings#rh-host-${encodeURIComponent(alias)}`

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim()
}

function labelOf(alias: string, row: Row): string {
  return text(row.label) || alias
}

/** What a machine that is not Linux is, in plain words. */
function whatItIs(os: string | undefined): string {
  if (!os) return 'is not a Linux machine'
  if (/^darwin$/i.test(os)) return 'is a Mac'
  return `runs ${os}, not Linux`
}

/** The entry for a found host that is not Linux: what it is, and the one way to add it. */
export function notLinuxCard(alias: string, label: string, os: string | undefined): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `${label} cannot be added over SSH`,
    body: `${label} ${whatItIs(os)}, and Walnut adds only Linux machines from your SSH config. To add it, open Settings › Remote Hosts › Add host › Join a machine with a link, and run its one command on ${label}. Walnut will not try it over SSH again.`,
    dedupKey: foundHostCardKey(alias),
    recoveryKey: `host:${alias}`,
    category: 'Sessions',
    host: alias,
    action: { label: 'Open Remote Hosts', to: SETTINGS_REMOTE_HOSTS },
  }
}

/** The entry for a found host the person said Connect to that does not connect. */
export function connectFailedCard(alias: string, label: string, kind: string, hint: string): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'error',
    title: hostFailureHeadline(kind, label),
    body: hint,
    dedupKey: foundHostCardKey(alias),
    recoveryKey: `host:${alias}`,
    category: 'Sessions',
    host: alias,
    action: { label: 'Open Remote Hosts', to: hostRowHref(alias) },
  }
}

/** The failure a phase reports, or null: a failed connect, or a reconnect held by a cause that does not heal. */
function failureOf(s: FoundHostPhase): { message: string; kind?: string } | null {
  if (s.phase === 'failed' && (s.error || s.kind)) return { message: s.error ?? '', kind: s.kind }
  if (s.phase === 'reconnecting' && s.lastKind && STANDING_FAILURE_KINDS.includes(s.lastKind)) return { message: s.lastError ?? '', kind: s.lastKind }
  return null
}

/** What the alert remembers per host: the kind it raised last, and the phase it saw last. */
export interface FoundHostAlertMemory {
  raised: Map<string, string>
  phase: Map<string, string>
}

export function newFoundHostAlertMemory(): FoundHostAlertMemory {
  return { raised: new Map(), phase: new Map() }
}

/** Handle one phase change (exported for tests). */
export async function handleFoundHostPhase(s: FoundHostPhase, mem: FoundHostAlertMemory, deps: FoundHostAlertDeps): Promise<void> {
  if (s.host === '__local__') return
  const was = mem.phase.get(s.host)
  mem.phase.set(s.host, s.phase)
  if (s.phase === 'connected') {
    if (was === 'connected') return
    mem.raised.delete(s.host)
    // A host marked not Linux that connects (turned on again, and the alias names another machine now).
    const hosts = await deps.readHosts()
    if (notOfferedOf(hosts[s.host])?.reason !== 'not_linux') return
    if (await deps.clearNotLinux(s.host)) log.session.info('found host connected: it is not marked not Linux any more', { host: s.host })
    return
  }
  const failure = failureOf(s)
  if (!failure) return
  const hosts = await deps.readHosts()
  const row = Object.hasOwn(hosts, s.host) ? hosts[s.host] : undefined
  if (!row || row.discovered !== true || row.transport === 'net') return
  const label = labelOf(s.host, row)
  const hostname = text(row.hostname)
  const user = text(row.user)
  const target = { label, hostname, user, ...(typeof row.port === 'number' ? { port: row.port } : {}) }
  const sshTarget = user ? `${user}@${hostname}` : hostname
  const classified = classifyHostConnectError(failure.message, sshTarget, [s.host, hostname, user], target)
  const kind = (failure.kind as HostConnectErrorKind | undefined) ?? classified.kind
  if (mem.raised.get(s.host) === kind) return
  if (SSH_SETUP_REFUSED_KINDS.includes(kind)) {
    mem.raised.set(s.host, kind)
    const os = osOfNotLinuxError(failure.message)
    // Only the write that turned it off speaks: a host already marked and off says nothing again.
    if (await deps.markNotLinux(s.host, os)) {
      log.session.info('found host is not Linux: marked, off, and told once', { host: s.host, os })
      await deps.publish(notLinuxCard(s.host, label, os))
    }
    return
  }
  const net = deps.readNet ? await deps.readNet() : undefined
  if (!consentedFoundHosts(hosts, net).some((h) => h.host === s.host)) return
  mem.raised.set(s.host, kind)
  const hint = kind === classified.kind ? classified.hint : hintForKind(kind, sshTarget, target)
  await deps.publish(connectFailedCard(s.host, label, kind, hint))
}

async function defaultDeps(): Promise<FoundHostAlertDeps> {
  const [{ addOnDaemonPhaseChange }, { getConfig }, marks, { upsertNotification }, { bus }] = await Promise.all([
    import('../../providers/daemon-connection.js'), import('../config-manager.js'), import('./found-host-marks.js'),
    import('../notifications/store.js'), import('../event-bus.js'),
  ])
  return {
    onPhase: (cb) => addOnDaemonPhaseChange((state) => cb(state)),
    readHosts: async () => ((await getConfig()).hosts ?? {}) as Record<string, Row>,
    readNet: async () => (await getConfig()).net,
    markNotLinux: (alias, os) => marks.markNotLinux(alias, os),
    clearNotLinux: (alias) => marks.clearNotLinux(alias),
    publish: async (card) => {
      const { record, outcome } = await upsertNotification(card)
      if (outcome !== 'suppressed') bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], { source: 'found-host-alert' })
    },
  }
}

/** Start listening. Returns the stop. `enabled: false` (a fixture server) listens to nothing. */
export async function startFoundHostAlert(opts: { enabled?: boolean; deps?: Partial<FoundHostAlertDeps> } = {}): Promise<() => void> {
  if (opts.enabled === false) return () => {}
  const deps = { ...(await defaultDeps()), ...opts.deps }
  const mem = newFoundHostAlertMemory()
  // One phase change at a time, in order: two frames of one failure must not both raise it.
  let chain: Promise<void> = Promise.resolve()
  return deps.onPhase((state) => {
    chain = chain.then(() => handleFoundHostPhase(state, mem, deps)).catch((err) => {
      log.session.warn('found host alert: could not handle a phase change', { host: state.host, error: err instanceof Error ? err.message : String(err) })
    })
  })
}
