/**
 * "The lid just opened" and "the network just changed", for a node server
 * that has no powerMonitor. Two cheap observations share one module:
 *  - wake: a 5s unref'd timer; two ticks more than 30s apart means the process
 *    was frozen (sleep) and the clock jumped;
 *  - network: every 10s compare the set of os.networkInterfaces() addresses
 *    that name a network (link-local and rotating IPv6 interface ids excluded).
 * Each signal redials every failed or reconnecting host at most ONCE (C51), a
 * host at most once per HOST_REDIAL_MIN_INTERVAL_MS, and stamps
 * daemon-reconnect-cause.ts so a dns / unreachable / timeout seen in the next
 * 90s reads as the network waking up, not a standing failure (C50).
 */

import os from 'node:os'
import { log } from '../../logging/index.js'
import { noteHostSignal } from '../../providers/daemon-reconnect-cause.js'

export const WAKE_TICK_MS = 5_000
export const WAKE_GAP_MS = 30_000
export const NETWORK_POLL_MS = 10_000
/** A flapping interface must not turn into a redial every poll: one per host per minute. */
export const HOST_REDIAL_MIN_INTERVAL_MS = 60_000

export type HostSignalKind = 'wake' | 'network'

export interface HostWakeSignalDeps {
  now?: () => number
  /** Sorted address list; defaults to os.networkInterfaces(). */
  addresses?: () => string[]
  /** Hosts to redial right now (failed or reconnecting). */
  hostsToRedial: () => string[]
  redial: (host: string, signal: HostSignalKind) => void
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (t: unknown) => void
}

type IfaceAddress = { address: string; family: string | number; internal: boolean }

/**
 * The part of an address that changes when the NETWORK changes, or null for one
 * that never names a network. Link-local (169.254/16, fe80::/10: awdl0, llw0,
 * utun) comes and goes on its own, and IPv6 privacy addresses rotate their
 * interface id every few hours, so an IPv6 address counts by its /64 prefix.
 */
export function networkKeyOf(name: string, a: IfaceAddress): string | null {
  if (a.internal) return null
  const family = String(a.family).replace(/^6$/, 'IPv6').replace(/^4$/, 'IPv4')
  const addr = a.address.toLowerCase()
  if (family === 'IPv4') return /^169\.254\./.test(addr) ? null : `${name}|IPv4|${addr}`
  if (/^fe[89ab]/.test(addr)) return null
  const head = addr.split('%')[0].split('::')[0].split(':').slice(0, 4)
  while (head.length < 4) head.push('0')
  return `${name}|IPv6|${head.join(':')}::/64`
}

export function networkAddressSet(ifaces: Record<string, IfaceAddress[] | undefined> = os.networkInterfaces()): string[] {
  const out = new Set<string>()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      const key = networkKeyOf(name, a)
      if (key) out.add(key)
    }
  }
  return [...out].sort()
}

export interface HostWakeSignal {
  /** One clock tick (exposed so tests drive time without real timers). */
  tick: () => void
  /** One network poll. */
  poll: () => void
  /** Fire a signal by hand (tests and the fixture). */
  fire: (kind: HostSignalKind) => string[]
  stop: () => void
}

export function startHostWakeSignal(deps: HostWakeSignalDeps): HostWakeSignal {
  const now = deps.now ?? Date.now
  const addresses = deps.addresses ?? networkAddressSet
  let lastTick = now()
  let lastAddrs = addresses().join(',')
  const lastRedialAt = new Map<string, number>()

  const fire = (kind: HostSignalKind): string[] => {
    const at = now()
    noteHostSignal(at)
    // A Set: one signal never redials the same host twice, even if listed twice.
    const hosts = [...new Set(deps.hostsToRedial())].filter((h) => at - (lastRedialAt.get(h) ?? -Infinity) >= HOST_REDIAL_MIN_INTERVAL_MS)
    log.session.info('host wake signal', { signal: kind, hosts })
    for (const host of hosts) {
      lastRedialAt.set(host, at)
      try { deps.redial(host, kind) } catch (err) {
        log.session.warn('host redial after wake failed to start', { host, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return hosts
  }

  const tick = (): void => {
    const t = now()
    const gap = t - lastTick
    lastTick = t
    if (gap > WAKE_GAP_MS) fire('wake')
  }

  const poll = (): void => {
    let next: string
    try { next = addresses().join(',') } catch { return }
    if (next === lastAddrs) return
    lastAddrs = next
    fire('network')
  }

  const si = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const ci = deps.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  const t1 = si(tick, WAKE_TICK_MS)
  const t2 = si(poll, NETWORK_POLL_MS)
  t1.unref?.()
  t2.unref?.()
  return { tick, poll, fire, stop: () => { ci(t1); ci(t2) } }
}
