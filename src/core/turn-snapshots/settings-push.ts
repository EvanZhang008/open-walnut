/**
 * Hands `session.turn_snapshots` (on by default, keep 100) to every connected
 * session daemon: on connect, at start, and whenever the config changes. The
 * daemon persists it, so snapshots between a daemon start and the next connect
 * follow the last value pushed. Fire-and-forget: a failed push never affects
 * a connect, and the next connect or config change tries again.
 *
 * A test server (ephemeral) never reconfigures a shared remote daemon.
 */

import { bus } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { IS_EPHEMERAL } from '../../constants.js'
import type { Config } from '../types.js'
import { TURN_SNAPSHOT_CAPABILITY } from './service.js'

const PUSH_TIMEOUT_MS = 10_000
const SUBSCRIBER = 'turn-snapshot-settings'

export interface TurnSnapshotSettings {
  enabled: boolean
  keep: number
}

export function turnSnapshotSettingsFrom(config: Pick<Config, 'session'> | null | undefined): TurnSnapshotSettings {
  const block = config?.session?.turn_snapshots
  const keep = typeof block?.keep === 'number' && Number.isFinite(block.keep) && block.keep >= 1
    ? Math.min(Math.floor(block.keep), 10_000)
    : 100
  return { enabled: block?.enabled !== false, keep }
}

/** What each host last accepted (cleared on every connect: it may be a new daemon). */
const lastPushed = new Map<string, string>()
let offConnect: (() => void) | null = null
let started = false

function isLocalKey(hostKey: string): boolean {
  return hostKey === '__local__' || hostKey.startsWith('direct:')
}

export async function pushTurnSnapshotSettings(hostKey: string): Promise<void> {
  if (IS_EPHEMERAL && !isLocalKey(hostKey)) return
  try {
    const [dc, { getConfig }] = await Promise.all([
      import('../../providers/daemon-connection.js'),
      import('../config-manager.js'),
    ])
    // The pool entry for this key, or another live connection to the same host
    // whose handshake listed the capability (a host can hold more than one).
    const entry = dc.getConnectedDaemonConnection(hostKey)
    const conn = entry && entry.hasCapability(TURN_SNAPSHOT_CAPABILITY)
      ? entry
      : (dc.listConnectedDaemonsByHost().get(entry?.host || hostKey) ?? []).find((c) => c.hasCapability(TURN_SNAPSHOT_CAPABILITY))
    if (!conn) return
    const settings = turnSnapshotSettingsFrom(await getConfig())
    const key = JSON.stringify(settings)
    if (lastPushed.get(hostKey) === key) return
    const reply = await conn.send('turns.configure', { ...settings }, PUSH_TIMEOUT_MS)
    if (reply.ok !== true) {
      log.session.warn('turn snapshot settings push rejected', { host: hostKey, error: reply.error })
      return
    }
    lastPushed.set(hostKey, key)
    log.session.info('turn snapshot settings pushed', { host: hostKey, ...settings, daemonEnabled: reply.enabled })
  } catch (err) {
    log.session.warn('turn snapshot settings push failed', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
  }
}

async function pushAll(): Promise<void> {
  try {
    const { getDaemonPoolStatus } = await import('../../providers/daemon-connection.js')
    await Promise.all(getDaemonPoolStatus().filter((d) => d.connected).map((d) => pushTurnSnapshotSettings(d.host)))
  } catch { /* the provider layer is unavailable (tests) */ }
}

/** Idempotent: a second start (an in-process server restart) replaces the first. */
export function startTurnSnapshotSettingsSync(): void {
  stopTurnSnapshotSettingsSync()
  started = true
  bus.subscribe(SUBSCRIBER, () => { void pushAll() }, { global: true, interest: ['config:changed'] })
  void import('../../providers/daemon-connection.js').then(({ addOnDaemonHostConnected }) => {
    if (!started) return
    offConnect = addOnDaemonHostConnected((hostKey) => {
      lastPushed.delete(hostKey)
      void pushTurnSnapshotSettings(hostKey)
    })
    // Hosts that connected before the listener was in place.
    void pushAll()
  }).catch(() => {})
}

export function stopTurnSnapshotSettingsSync(): void {
  started = false
  try { bus.unsubscribe(SUBSCRIBER) } catch { /* never subscribed */ }
  offConnect?.()
  offConnect = null
  lastPushed.clear()
}
