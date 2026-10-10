/**
 * The primary's side of each host server's copy of its signed-in devices
 * (docs/plan/walnut-servers-everywhere.md, "Host server, leader away"; the host
 * server's side is host-server/device-copy.ts).
 *
 * A host server answers a few requests itself while nobody leads
 * (host-server/alone-api.ts), and checks the same device tokens this server
 * checks. It gets the hash of each phone's and browser's token, never a token
 * and never a machine credential. The cloud companion is not a target: it keeps
 * its own pairings, and device adoption copies them across.
 *
 * One small list, sent whole to a host server whose last answer named another
 * list (or none), every 30 seconds, at once after a device is removed, and
 * again to every host after the 10-minute sweep (a host server that lost its
 * file gets it back).
 */

import crypto from 'node:crypto'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { ReplicaTarget } from './replica-targets.js'

const TICK_MS = 30_000
const SWEEP_MS = 10 * 60_000
const FIRST_ROUND_MS = 10_000
const PUT_TIMEOUT_MS = 15_000

export interface DeviceReplicaEntry { name: string; tokenHash: string }

export interface DeviceReplicaDeps {
  /** Phones and browsers paired here, or null when the pairings cannot be read. */
  devices: () => Promise<DeviceReplicaEntry[] | null>
  targets: () => ReplicaTarget[]
}

/** The same hash the host server computes (device-copy.ts listHash). */
export function deviceListHash(devices: DeviceReplicaEntry[]): string {
  return crypto.createHash('sha256').update(devices.map((d) => `${d.name}:${d.tokenHash}`).sort().join('\n'), 'utf-8').digest('hex').slice(0, 16)
}

async function defaultDeps(): Promise<DeviceReplicaDeps> {
  const [auth, targets] = await Promise.all([import('../device-auth.js'), import('./replica-targets.js')])
  return {
    devices: async () => {
      // An unreadable auth.json reads as no devices; sending that would sign
      // every browser out of every host server.
      const paired = await auth.readPairedDevices()
      if (!paired || paired.from !== 'auth') return null
      const records = await auth.listDeviceRecords()
      return records
        .filter((r) => r.kind !== 'machine' && !paired.revoked.has(r.tokenHash))
        .map((r) => ({ name: r.name, tokenHash: r.tokenHash }))
    },
    targets: targets.replicaTargets,
  }
}

export interface DeviceReplicaRoundResult {
  target: string
  action: 'synced' | 'unchanged' | 'unsupported' | 'failed' | 'skipped'
  devices?: number
  error?: string
}

/** The list each host server last took, by target id. */
const taken = new Map<string, string>()
/** A host server that refused or could not be reached is asked again after this. */
const retryAt = new Map<string, number>()
const FAILED_RETRY_MS = 2 * 60_000
/** An older host server (no device copy) answers 400; asked again in 5 minutes (the Mac upgrades it on connect). */
const UNSUPPORTED_RETRY_MS = 5 * 60_000

export function forgetDeviceReplica(): void {
  taken.clear()
}

let running: Promise<DeviceReplicaRoundResult[]> | null = null

/** One round over every host server. One at a time; never throws. */
export function syncDeviceReplica(deps?: DeviceReplicaDeps): Promise<DeviceReplicaRoundResult[]> {
  if (running) return running
  running = (async () => {
    const out: DeviceReplicaRoundResult[] = []
    try {
      const d = deps ?? await defaultDeps()
      const hosts = d.targets().filter((t) => t.kind === 'host')
      for (const id of [...taken.keys(), ...retryAt.keys()]) {
        if (!hosts.some((t) => t.id === id)) { taken.delete(id); retryAt.delete(id) }
      }
      if (hosts.length === 0) return out
      const devices = await d.devices()
      if (!devices) {
        log.web.warn('device replica: the pairings could not be read, nothing sent this round')
        return hosts.map((t) => ({ target: t.id, action: 'skipped' as const }))
      }
      const hash = deviceListHash(devices)
      const now = Date.now()
      for (const target of hosts) {
        if (taken.get(target.id) === hash) { out.push({ target: target.id, action: 'unchanged' }); continue }
        if ((retryAt.get(target.id) ?? 0) > now) { out.push({ target: target.id, action: 'skipped' }); continue }
        try {
          if (!(await target.available())) { out.push({ target: target.id, action: 'skipped' }); continue }
          const r = await target.post({ op: 'put', kind: 'devices', devices, hash }, { timeoutMs: PUT_TIMEOUT_MS })
          if (r.ok && r.reply.ok === true && r.reply.hash === hash) {
            taken.set(target.id, hash)
            retryAt.delete(target.id)
            out.push({ target: target.id, action: 'synced', devices: devices.length })
            log.web.info('device replica: a host server took the device list', { target: target.id, devices: devices.length })
          } else if ((!r.ok && (r.outcome === 'unsupported' || r.status === 400)) || (r.ok && r.reply.error === 'not_a_replica')) {
            retryAt.set(target.id, now + UNSUPPORTED_RETRY_MS)
            out.push({ target: target.id, action: 'unsupported' })
            log.web.info('device replica: this host server keeps no device copy yet (older build), asking again in 5 minutes', { target: target.id })
          } else {
            const error = r.ok ? String(r.reply.error ?? 'refused') : (r.error ?? `HTTP ${r.status ?? '?'}`)
            retryAt.set(target.id, now + FAILED_RETRY_MS)
            out.push({ target: target.id, action: 'failed', error })
            log.web.warn('device replica: a host server did not take the device list', { target: target.id, error })
          }
        } catch (err) {
          retryAt.set(target.id, now + FAILED_RETRY_MS)
          out.push({ target: target.id, action: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      }
    } finally {
      running = null
    }
    return out
  })()
  return running
}

/** Primary only: a first round after boot, the 30 s tick, a round at once after a removal, the sweep. */
export function startDeviceReplicaSync(deps?: DeviceReplicaDeps): { stop: () => void } {
  if (CLOUD_MODE) return { stop: () => {} }
  let stopped = false
  const round = (): void => { if (!stopped) void syncDeviceReplica(deps) }
  const first = setTimeout(round, FIRST_ROUND_MS)
  first.unref?.()
  const tick = setInterval(round, TICK_MS)
  tick.unref?.()
  const sweep = setInterval(() => { forgetDeviceReplica(); retryAt.clear(); round() }, SWEEP_MS)
  sweep.unref?.()
  const unlisten: Array<() => void> = []
  void Promise.all([import('../device-auth.js'), import('./replica-targets.js')]).then(([auth, targets]) => {
    if (stopped) return
    // A removed device leaves every host server at once, even one that refused a round.
    unlisten.push(auth.onCredentialsRevoked(() => { retryAt.clear(); round() }))
    // A host server that came up again (an upgrade, say) is asked at once.
    unlisten.push(targets.onReplicaTargetsChanged(() => { retryAt.clear(); round() }))
  })
  return {
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(tick)
      clearInterval(sweep)
      for (const u of unlisten) u()
    },
  }
}

export function _resetDeviceReplicaForTesting(): void {
  taken.clear()
  retryAt.clear()
  running = null
}
