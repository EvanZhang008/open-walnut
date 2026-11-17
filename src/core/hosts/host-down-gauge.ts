/**
 * A remote host that stays down is looked into, not shown (2026-11-17, the user: a Mac that
 * was not connected kept asking him to run `walnut net status`; "if there are issues, start a
 * session to investigate it"). Every minute each configured host whose problem is Walnut's to
 * clear (audience.ts hostProblemNeedsYou: not a login of the person's) and that is not connected
 * reports 1 on the gauge `host.down{host=<alias>}`, else 0. The health monitor's built-in alarm
 * `host.down` reads it: after 30 minutes it dials the host again (auto-fix `host-reconnect`),
 * and when that does not hold it opens one fix task for that host (the engine's own rules,
 * `health_monitor.fix_tasks`). The brief carries the host's own words (`hostDownEvidence`).
 */
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { reportGauge } from '../health-monitor/gauges.js'
import { hostProblemNeedsYou } from '../notifications/audience.js'
import type { HostStatus } from './host-status.js'

export const HOST_DOWN_METRIC = 'host.down'
export const HOST_DOWN_ALARM = 'host.down'
const TICK_MS = 60_000

/** Is this host down for a reason Walnut, not the person, has to clear? */
export function walnutHostDown(s: Pick<HostStatus, 'connected' | 'phase' | 'kind' | 'lastKind' | 'discovered' | 'host'>): boolean {
  if (s.connected || s.discovered) return false
  if (s.phase !== 'failed' && s.phase !== 'reconnecting') return false
  const kind = s.kind ?? s.lastKind
  return !hostProblemNeedsYou({ ...(kind ? { kind } : {}), hosts: [s.host] }, new Set())
}

let latest = new Map<string, HostStatus>()

/** The brief's evidence for one host: what its status said at the last count. */
export function hostDownEvidence(alias: string | undefined): string[] {
  const s = alias ? latest.get(alias) : undefined
  if (!s) return []
  return [
    `## The host (Settings > Remote hosts > ${s.label ?? s.host}; Walnut Health lists it under Remote hosts)`,
    `- State: ${s.phase}${s.phaseLabel ? `: ${s.phaseLabel}` : ''}`,
    ...(s.kind ?? s.lastKind ? [`- Kind: \`${s.kind ?? s.lastKind}\``] : []),
    ...(s.error ?? s.lastError ? [`- Error: ${(s.error ?? s.lastError)!.replace(/\s+/g, ' ').slice(0, 400)}`] : []),
    ...(s.hint ?? s.lastHint ? [`- Its hint: ${s.hint ?? s.lastHint}`] : []),
    'A machine that is simply off or asleep (a laptop, someone else\'s computer) is not a fault: say so in one line and finish, or, when the person no longer uses it, suggest turning it off in Settings in your NEED_ACTION line.',
  ]
}

export async function reportHostDownGauges(): Promise<string[]> {
  if (CLOUD_MODE) return []
  const { getConfig } = await import('../config-manager.js')
  const { buildHostStatus, listStatusHosts } = await import('./host-status.js')
  const { getDaemonConnectState } = await import('../../providers/daemon-connection.js')
  const next = new Map<string, HostStatus>()
  const down: string[] = []
  for (const { key, def } of listStatusHosts(await getConfig())) {
    const status = buildHostStatus(key, def, getDaemonConnectState(key))
    const isDown = walnutHostDown(status)
    reportGauge(`${HOST_DOWN_METRIC}{host=${key}}`, isDown ? 1 : 0)
    if (isDown) { next.set(key, status); down.push(key) }
  }
  latest = next
  return down
}

let timer: ReturnType<typeof setInterval> | null = null

export function startHostDownWatch(): void {
  if (timer) return
  const tick = () => {
    void reportHostDownGauges().catch((err) => {
      log.obs.warn('host down: count failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }
  tick()
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
}

export function stopHostDownWatch(): void {
  if (timer) { clearInterval(timer); timer = null }
  latest = new Map()
}
