/**
 * Seed for Settings > Walnut Health (health-monitor.spec.ts): a day of minute rows
 * and an alarm state shaped like a busy production server, written into the fixture's
 * data home before the server starts, so its monitor loads them as it would after a
 * restart. Values follow a real day (2026-11-08): a nearly full disk, a host link
 * dropping 12 times an hour, cut-off shutdowns, and a log line 7 times its normal.
 */
import fs from 'node:fs'
import path from 'node:path'
import { signatureId } from '../../../src/core/health-monitor/log-alarms'

const MIN = 60_000
const HOUR = 3_600_000

export const HEALTH_SPIKE_SIG = 'session: DaemonConnection: gateway relay refused'
export const HEALTH_HOST = 'devbox'

const sid = signatureId

export function writeHealthMonitorSeed(home: string, now: number): void {
  const dir = path.join(home, 'local', 'health-monitor')
  fs.mkdirSync(dir, { recursive: true })
  const end = Math.floor(now / MIN) * MIN
  const byDay = new Map<string, string[]>()
  for (let i = 26 * 60; i >= 1; i--) {
    const t = end - i * MIN
    const v: Record<string, number> = {
      'disk.free_gb': 24 + (i % 7) / 10, 'disk.used_pct': 95, 'process.fd': 300 + (i % 40), 'memory.pressure': 0,
      'process.rss_mb': 900, 'server.restarts_24h': 9, 'server.unplanned_restarts_24h': 0, 'server.deploys_24h': 9, 'server.shutdown_bails_24h': 8, 'session.hung': i % 90 === 0 ? 1 : 0,
      'eventloop.delay.max': 40 + ((i * 37) % 300), 'log.warn': 20, 'log.error': i % 30 === 0 ? 1 : 0,
    }
    if (i <= 180 && i % 5 === 0) v[`host.link.lost{host=${HEALTH_HOST}}`] = 1
    if (i % 17 === 0) v['send.delivery.live'] = 800 + (i % 5) * 400
    const day = new Date(t).toISOString().slice(0, 10)
    const list = byDay.get(day) ?? []
    list.push(JSON.stringify({ t, v }))
    byDay.set(day, list)
  }
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dir, `minutes-${day}.jsonl`), lines.join('\n') + '\n')

  // A week of hours for the log kind: 14 an hour normally, 98 in the last hour.
  const hours: Record<string, Record<string, number>> = {}
  const h0 = Math.floor(now / HOUR) * HOUR
  for (let i = 0; i < 24 * 7; i++) hours[String(h0 - i * HOUR)] = { [sid(HEALTH_SPIKE_SIG)]: i <= 1 ? 98 : 14 }
  fs.writeFileSync(path.join(dir, 'log-hours.json'), JSON.stringify({
    version: 1, hours,
    meta: { [sid(HEALTH_SPIKE_SIG)]: { sig: HEALTH_SPIKE_SIG, level: 'warn', sample: `${HEALTH_SPIKE_SIG} (host: ${HEALTH_HOST})`, lastAt: end - MIN } },
  }))

  const since = end - 2 * HOUR
  const alarm = (id: string, defId: string, extra: Record<string, unknown>) => ({
    id, defId, state: 'ALARM', since, value: null, evaluatedAt: end - MIN,
    history: [{ at: since, from: 'OK', to: 'ALARM', value: null, reason: 'seeded' }], actions: [], ...extra,
  })
  const linkId = `host.link{host=${HEALTH_HOST}}`
  const spikeId = `log.spike:${sid(HEALTH_SPIKE_SIG)}`
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    alarms: {
      [linkId]: alarm(linkId, 'host.link', {
        labels: { host: HEALTH_HOST }, value: 12,
        actions: [{ at: since + MIN, kind: 'fix-task', ok: true, detail: 'filed a fix task' }],
      }),
      'disk.free': alarm('disk.free', 'disk.free', {
        value: 24,
        actions: [{ at: since + MIN, kind: 'auto-fix', ok: true, detail: 'ran the task-directory sweep: 3 directories removed, 1.2 GB freed' }],
      }),
      [spikeId]: alarm(spikeId, 'log.spike', {
        signature: HEALTH_SPIKE_SIG, value: 98,
        history: [{ at: since, from: 'INSUFFICIENT_DATA', to: 'ALARM', value: 98, reason: '98 in the last hour; normal 14, alarm at 70' }],
      }),
    },
    overrides: {}, events: [], fixes: [],
  }))
}
