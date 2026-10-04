/**
 * The cloud box as an exec host of the PRIMARY (the Mac), reached over the
 * daemon tunnel instead of SSH. This file is the leaf: the alias, the host row
 * the config reader injects, and the last known answer about the companion.
 * No runtime imports, so config-manager.ts can read it on every getConfig().
 *
 * ## Why an injected host row
 *
 * About fifty readers resolve a host through `config.hosts[alias]` (session
 * start, list-dirs, Files, Changes, readiness, warmup, status). Putting the
 * cloud box there, marked `cloud_box: true`, makes every one of them work
 * unchanged; only the TRANSPORT differs (DaemonConnection sees the alias and
 * dials the tunnel). The row is never written back: config-manager strips it on
 * every save, and GET /api/config leaves it out, so Settings never offers to
 * edit a host the user did not create.
 *
 * ## Why not `__cloud__`
 *
 * On the replica, `__cloud__` already means "a session the REPLICA owns, run by
 * the replica's own daemon" (cloud-exec.ts): the replica answers a launch on it
 * locally and tags its own rows with it. A Mac-owned session under the same
 * alias would be routed by the replica to the wrong daemon and the wrong
 * session store. So the Mac-owned lane has its own alias, `__cloudbox__`.
 */

/** Host alias of the cloud box as seen from the primary. Stable: it lands in session records. */
export const CLOUD_BOX_HOST_ALIAS = '__cloudbox__'

/** The label every surface shows. */
export const CLOUD_BOX_HOST_LABEL = 'Cloud'

/**
 * Default caps for the box (session_limits.__cloudbox__ overrides): a small
 * instance that also runs the companion, so the cloud-exec numbers
 * (CLOUD_EXEC_DEFAULT_MAX_SESSIONS), not a dev box's.
 */
export const CLOUD_BOX_DEFAULT_LIMIT = 2
export const CLOUD_BOX_DEFAULT_IDLE_LIMIT = 3

/** The replica's WebSocket route that pipes to the primary's own daemon on the box. */
export const DAEMON_TUNNEL_PATH = '/daemon-tunnel'

/** Header the replica sets on a refused tunnel upgrade (the status line alone is ambiguous). */
export const TUNNEL_REFUSAL_HEADER = 'x-walnut-tunnel-refusal'

/**
 * Upgrade header asking the tunnel route only "is this machine credential valid
 * here?": 204 for any valid machine credential, 401 otherwise, and nothing is
 * started. The Mac tells a dead bridge token from a down network with it.
 */
export const TUNNEL_PROBE_HEADER = 'x-walnut-tunnel-probe'

/**
 * What the companion said about hosting the primary's sessions.
 *  - ready: the replica advertises `daemonTunnel.enabled`.
 *  - needs_update: its /api/v1/status has no `daemonTunnel` field (an older build).
 *  - exec_off: it has the tunnel but `cloud.exec.enabled` is off there.
 *  - other_mac: it serves another Mac, which holds its machine credential
 *    (core/machine-credentials.ts). Only a mint can tell, so the status probe
 *    never clears it; the next dial asks again.
 *  - unknown: never answered yet (unreachable, or still probing).
 */
export type CloudBoxCapability = 'ready' | 'needs_update' | 'exec_off' | 'other_mac' | 'unknown'

export interface CloudBoxState {
  /** host[:port] of the companion, from the data repo's `cloud` remote. */
  domain: string
  secure: boolean
  capability: CloudBoxCapability
  /** When the capability was last answered (ms epoch), null = never. */
  checkedAt: number | null
}

export interface CloudBoxHostDef {
  hostname: string
  label: string
  enabled: true
  cloud_box: true
}

/** Sentences the tunnel, the status frame and the classifier all share (no dashes). */
export const CLOUD_BOX_NEEDS_UPDATE = 'Cloud companion needs an update'
export const CLOUD_BOX_EXEC_OFF = 'Cloud companion has session hosting turned off'
export const CLOUD_BOX_OTHER_MAC = 'Another Mac is connected to this cloud companion'
/** What the companion answers a second Mac (409), and what that Mac's host card says. */
export const CLOUD_BOX_OTHER_MAC_SENTENCE = `${CLOUD_BOX_OTHER_MAC}. Disconnect it there first.`

let state: CloudBoxState | null = null
const listeners = new Set<(next: CloudBoxState | null) => void>()

/** null = this primary is not paired with a companion (or pairing is off). */
export function getCloudBoxState(): CloudBoxState | null {
  return state
}

/** Replace the state; listeners fire only when something a surface shows changed. */
export function setCloudBoxState(next: CloudBoxState | null): void {
  const before = state
  state = next
  const changed = (before === null) !== (next === null)
    || (before !== null && next !== null && (before.domain !== next.domain || before.secure !== next.secure || before.capability !== next.capability))
  if (!changed) return
  for (const listener of listeners) {
    try { listener(next) } catch { /* an observer must never break the probe */ }
  }
}

export function onCloudBoxStateChange(listener: (next: CloudBoxState | null) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam: forget everything (state and listeners). */
export function resetCloudBoxStateForTest(): void {
  state = null
  listeners.clear()
}

export function cloudBoxHostDef(s: CloudBoxState): CloudBoxHostDef {
  return { hostname: s.domain, label: CLOUD_BOX_HOST_LABEL, enabled: true, cloud_box: true }
}

/**
 * Add the cloud box row to a freshly read config (in place). Never on the
 * replica itself: the box does not dial its own tunnel. A user entry that
 * happens to use the alias is replaced, because the alias is reserved.
 */
export function injectCloudBoxHost(config: { hosts?: Record<string, unknown> }, cloudMode: boolean): void {
  if (cloudMode || !state) return
  config.hosts = { ...(config.hosts ?? {}), [CLOUD_BOX_HOST_ALIAS]: cloudBoxHostDef(state) }
}

/** A host map without the injected row: what may be written to config.yaml or shown in Settings. */
export function withoutCloudBoxHost<T>(hosts: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!hosts || typeof hosts !== 'object') return hosts
  if (!Object.hasOwn(hosts, CLOUD_BOX_HOST_ALIAS)
    && !Object.values(hosts).some((h) => (h as { cloud_box?: unknown } | null)?.cloud_box === true)) return hosts
  const out: Record<string, T> = {}
  for (const [alias, def] of Object.entries(hosts)) {
    if (alias === CLOUD_BOX_HOST_ALIAS) continue
    if ((def as { cloud_box?: unknown } | null)?.cloud_box === true) continue
    out[alias] = def
  }
  return out
}

/**
 * The refusal a connect gives without dialling, when the companion already
 * said it cannot host this Mac's sessions. null = go ahead and dial.
 */
export function cloudBoxRefusal(s: CloudBoxState | null = state): string | null {
  if (!s) return null
  if (s.capability === 'needs_update') return `${CLOUD_BOX_NEEDS_UPDATE}: its build predates the session tunnel`
  if (s.capability === 'exec_off') return `${CLOUD_BOX_EXEC_OFF} (cloud.exec.enabled is off there)`
  if (s.capability === 'other_mac') return CLOUD_BOX_OTHER_MAC_SENTENCE
  return null
}

/** The tunnel URL for a paired companion (ws for a loopback http companion, wss otherwise). */
export function tunnelUrlFor(s: Pick<CloudBoxState, 'domain' | 'secure'>): string {
  return `${s.secure ? 'wss' : 'ws'}://${s.domain}${DAEMON_TUNNEL_PATH}`
}

/**
 * Map the replica's `daemonTunnel` status field to a capability. Absent field
 * = an older replica. Kept pure so the old-replica case is a one-line test.
 */
export function capabilityFromStatus(body: unknown): CloudBoxCapability {
  if (!body || typeof body !== 'object') return 'unknown'
  const tunnel = (body as { daemonTunnel?: unknown }).daemonTunnel
  if (tunnel === undefined) return 'needs_update'
  if (!tunnel || typeof tunnel !== 'object') return 'unknown'
  return (tunnel as { enabled?: unknown }).enabled === true ? 'ready' : 'exec_off'
}
