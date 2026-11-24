/**
 * The handover's host steps (handover-host-steps.ts, the order) bound to their hooks (host-follow.ts,
 * the work). boot.ts sets them when a leader's permit starts (never for a trial start). Two things the
 * hooks need that the order does not carry are chosen here:
 *
 *   the host service's port   configureOldMachineHostService listens on a loopback port of this machine.
 *                             It is picked as the host-server manager picks a host service's port on
 *                             any host (manager.ts portsFor): a few random candidates in the same range
 *                             (41000 to 49999, clear of this server's and the daemon's own ports), the
 *                             first one free on loopback. A handover asked again (a resumed switch)
 *                             keeps the port its record names, so its service is not moved under a
 *                             host that dialed it. A port taken between the pick and the service's
 *                             bind fails only that service's start, which the daemon retries, as a
 *                             follower's collision costs one try (follower-port.ts). The console
 *                             port the old leader's console uses is not reused: that door is B3's,
 *                             and it is up only while the console runs.
 *   the new leader's network id
 *                             retellNetMembers needs it to let the new leader in on the network's
 *                             member lists: the `endpoint` this machine's `hosts` gives the new
 *                             leader's host key when it is a network host (transport: net). Not
 *                             known there: the hook says the new leader is not let in, and the
 *                             handover waits, then is taken back.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import type { HandoverHostSteps, HostStepResult } from './handover-host-steps.js'
import type { MachinePlace } from './settings.js'

const PORT_BASE = 41_000
const PORT_SPAN = 9_000

function freeOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/** The port the record of an earlier configure names, if any. */
function keptPort(recordFile: string): number | null {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as { port?: unknown }
    return typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 0 && r.port <= 65_535 ? r.port : null
  } catch {
    return null
  }
}

/** A loopback port for this Walnut's host service on this machine (see the header). */
export async function hostServicePort(home: string, o: { random?: () => number; free?: (port: number) => Promise<boolean> } = {}): Promise<number> {
  const { hostServiceRecordFile } = await import('./host-follow.js')
  const kept = keptPort(hostServiceRecordFile(home))
  if (kept) return kept
  const pick = o.random ?? (() => PORT_BASE + crypto.randomInt(PORT_SPAN))
  const free = o.free ?? freeOnLoopback
  for (let i = 0; i < 8; i++) {
    const port = pick()
    if (await free(port)) return port
  }
  throw new Error('no free loopback port for the host service')
}

/** The new leader's network id, from this machine's `hosts` (its host key, as a network host). */
export async function newLeaderEndpoints(target: MachinePlace): Promise<Record<string, string> | undefined> {
  const { getConfig } = await import('../../config-manager.js')
  const hosts = ((await getConfig()) as { hosts?: Record<string, { transport?: unknown; endpoint?: unknown }> }).hosts ?? {}
  const key = target.hostKey ?? target.id
  const h = Object.hasOwn(hosts, key) ? hosts[key] : undefined
  return h?.transport === 'net' && typeof h.endpoint === 'string' && h.endpoint ? { [target.id]: h.endpoint.toLowerCase() } : undefined
}

/**
 * The machine a host credential is for: this machine's stable id (machine-id.ts), the id its daemon's hello
 * and the credential file check. The permit's holder id is the same file in production; a rehearsal that
 * names its "machines" by WALNUT_MACHINE_ID_FILE keeps the two apart, and the credential must be the daemon's.
 */
async function credentialMachine(): Promise<string> {
  return (await import('../../machine-id.js')).readMachineId()
}

const plain = (r: { ok: true } | { ok: false; why: string }): HostStepResult => (r.ok ? { ok: true } : { ok: false, why: r.why })

export const hostFollowSteps: HandoverHostSteps = {
  async prepareOldMachineAsHost(o) {
    return plain(await (await import('./host-follow.js')).prepareOldMachineAsHost({ ...o, machineId: await credentialMachine() }))
  },
  async pushNewLeaderDoors(doors) {
    const r = await (await import('./host-follow.js')).pushNewLeaderDoors(doors)
    // A host that could not be told now hears the doors from the new leader's standby later (its answer
    // names the leader): a failure to tell one host is logged, not a refusal (host-follow.ts).
    return plain(r)
  },
  async configureOldMachineHostService(o) {
    const port = await hostServicePort(o.home)
    return plain(await (await import('./host-follow.js')).configureOldMachineHostService({ ...o, port }))
  },
  async announceSwitchStop(commitWindowMs) {
    return (await import('./host-follow.js')).announceSwitchStop(commitWindowMs)
  },
  async retellNetMembers({ target }) {
    const endpoints = await newLeaderEndpoints(target)
    const r = await (await import('./host-follow.js')).retellNetMembers(endpoints ? { endpoints } : {})
    if (!r.ok) return r
    const missed = r.missed.map((m) => `${m.host} (${m.why})`)
    if (r.newLeaderLetIn === false) missed.push(`the network does not let ${target.id} in (its network id is not known here: give ${target.hostKey ?? target.id} an endpoint in hosts)`)
    return missed.length ? { ok: false, why: `not told: ${missed.join(', ')}` } : { ok: true }
  },
  async dropOwnDaemonDuties(o) {
    return plain(await (await import('./host-follow.js')).dropOwnDaemonDuties(o))
  },
  async undoHandoverHostSteps(o) {
    return plain(await (await import('./host-follow.js')).undoHandoverHostSteps({ ...o, machineId: await credentialMachine() }))
  },
}
