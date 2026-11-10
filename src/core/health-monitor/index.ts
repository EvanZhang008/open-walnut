/**
 * Walnut's health monitor: start it, and read it the way the Health page and the
 * `health_monitor` op do. See types.ts for the model and engine.ts for the clock.
 *
 * Runs on the leader (the primary). An isolated server (the test runner, an
 * ephemeral child, a data home in a temp or task dir) evaluates the same alarms
 * but takes no action: its tasks and disk are not the user's.
 * WALNUT_HEALTH_ACTIONS=1 turns actions on there, =0 turns them off anywhere.
 */

import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { allAlarms, BUILTIN_ALARMS, builtinAlarm, setCustomAlarms } from './alarms.js'
import { CustomMetricRunner, customAlarmDefs, readCustomMetrics } from './custom-metrics.js'
import { MinuteCollector } from './collect.js'
import { fillPattern, MINUTE_MS } from './evaluate.js'
import { effectiveOverride, FIX_TASKS_PER_DAY, HealthMonitor, overrideHolds, type FixMode } from './engine.js'
import { setGaugeSink } from './gauges.js'
import { HealthStore } from './store.js'
import type { AlarmDef, AlarmInstanceState, AlarmOverride, AlarmState } from './types.js'

let running: HealthMonitor | null = null
let actionsOn = false

export function runningHealthMonitor(): HealthMonitor | null {
  return running
}

/** Isolated servers act only when asked. */
export async function healthActionsOn(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.WALNUT_HEALTH_ACTIONS === '1') return true
  if (env.WALNUT_HEALTH_ACTIONS === '0') return false
  const { semanticLaneDecision } = await import('../search/semantic-default.js')
  const { WALNUT_SEARCH_V2_SEMANTIC: _drop, ...rest } = env
  return semanticLaneDecision({ env: rest, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).reason === 'default'
}

/** This server's build as one key: a new build (a deploy, an update) gets a new build time. */
async function runningBuildKey(): Promise<string | null> {
  const { getBuildInfo } = await import('../../lib/build-info.js')
  const b = getBuildInfo()
  return b.builtAt ? `${b.commit ?? 'unknown'}@${b.builtAt}` : null
}

export interface StartOptions {
  exitTraceFile: string | null
  notify: (alarmId: string, title: string, body: string) => void
  recover: (alarmId: string) => void
  onChange: () => void
}

export async function startHealthMonitor(opts: StartOptions): Promise<HealthMonitor> {
  if (running) return running
  actionsOn = await healthActionsOn()
  const dataDir = WALNUT_HOME
  const { memoryPressureLevel } = await import('../memory-pressure.js')
  const collector = new MinuteCollector({
    dataDir,
    memoryPressure: memoryPressureLevel,
    sshCertExpiring: async () => {
      const { runningCertExpiryAlert } = await import('../hosts/ssh-cert-expiry-alert.js')
      const alert = runningCertExpiryAlert()
      if (!alert) return null
      const ep = await alert.episode()
      return !!ep && !ep.signInWorks
    },
  })
  const fixMode = async (): Promise<FixMode> => {
    if (!actionsOn) return 'off'
    const { getConfig } = await import('../config-manager.js')
    const v = (await getConfig()).health_monitor?.fix_tasks
    return v === 'start' || v === 'off' ? v : 'record'
  }
  const { openFixTask, isTaskOpen, tellTask } = await import('./fix-task.js')
  const { runAutoFix } = await import('./auto-fix.js')
  const monitor = new HealthMonitor({
    store: new HealthStore(path.join(dataDir, 'local', 'health-monitor')),
    collector,
    pid: process.pid,
    build: await runningBuildKey(),
    exitTraceFile: opts.exitTraceFile,
    actsOn: () => actionsOn,
    fixMode,
    autoFix: async (id, labels) => (actionsOn ? runAutoFix(id, dataDir, labels) : { ok: false, detail: 'actions are off on an isolated server' }),
    openFixTask,
    isTaskOpen,
    tellTask: async (input) => (actionsOn ? tellTask(input) : { delivered: false, started: false, detail: 'actions are off on an isolated server' }),
    notify: (id, title, body) => { if (actionsOn) opts.notify(id, title, body) },
    recover: (id) => { if (actionsOn) opts.recover(id) },
    onChange: debounce(opts.onChange, 1_000),
  })
  await monitor.start()
  setGaugeSink((k, v) => monitor.setGauge(k, v))
  running = monitor
  startCustomMetrics(monitor)
  log.obs.info('health monitor started', { actions: actionsOn, alarms: BUILTIN_ALARMS.length })
  return monitor
}

let customTimer: ReturnType<typeof setInterval> | null = null
let customRunner: CustomMetricRunner | null = null

/** The person's own command metrics (custom-metrics.ts): their alarms show everywhere, their commands run only where actions are on. */
function startCustomMetrics(monitor: HealthMonitor): void {
  const runner = new CustomMetricRunner((k, v) => monitor.setGauge(k, v))
  let seen = ''
  const tick = async (): Promise<void> => {
    try {
      const { getConfig } = await import('../config-manager.js')
      const raw = (await getConfig()).health_monitor?.metrics
      const key = JSON.stringify(raw ?? null)
      const list = readCustomMetrics(raw, key !== seen)
      seen = key
      setCustomAlarms(customAlarmDefs(list))
      if (actionsOn) void runner.tick(list, Date.now())
    } catch (err) {
      log.obs.warn('health monitor: custom metrics not read', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  void tick()
  customTimer = setInterval(() => { void tick() }, MINUTE_MS)
  customTimer.unref?.()
  customRunner = runner
}

export function stopHealthMonitor(): void {
  if (customTimer) clearInterval(customTimer)
  customTimer = null
  customRunner?.stop()
  customRunner = null
  setCustomAlarms([])
  setGaugeSink(null)
  running?.stop()
  running = null
}

// ── the read model ──

export interface AlarmRow {
  id: string
  defId: string
  title: string
  description: string
  state: AlarmState
  since: number
  value: number | null
  unit: string
  /** The condition in words, with this alarm's threshold. */
  condition: string
  labels?: Record<string, string>
  signature?: string
  /** One point per 15 minutes over the last 24 hours, oldest first (null: no data). */
  spark: Array<number | null>
  actions: AlarmInstanceState['actions']
  fixTaskId?: string
  override?: AlarmOverride
  /** Actions are held (muted or disabled). */
  held: boolean
}

export interface HealthView {
  checkedAt: number
  actions: boolean
  counts: Record<AlarmState, number>
  fixesToday: number
  fixesPerDay: number
  alarms: AlarmRow[]
}

const ORDER: Record<AlarmState, number> = { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 }

function defOf(inst: AlarmInstanceState): AlarmDef | null {
  if (inst.defId === 'log.spike' || inst.defId === 'log.chronic') return null
  return builtinAlarm(inst.defId) ?? null
}

/**
 * Every alarm the monitor knows, the built-ins it has not evaluated yet included
 * (a fresh server's first minute): those read No data until their first tick.
 */
function instancesWithPending(m: HealthMonitor): AlarmInstanceState[] {
  const out = Object.values(m.alarms)
  const now = m.now()
  for (const def of allAlarms()) {
    if (def.metric.includes('=*') || m.alarms[def.id]) continue
    out.push({ id: def.id, defId: def.id, state: 'INSUFFICIENT_DATA', since: now, value: null, evaluatedAt: now, history: [], actions: [] })
  }
  return out
}

function conditionText(def: AlarmDef, threshold: number): string {
  const per = def.periodMin >= 60 ? `${def.periodMin / 60} h` : `${def.periodMin} min`
  const also = def.also ? ` and ${def.also.metric} ${def.also.comparison} ${def.also.threshold}` : ''
  return `${def.stat} ${def.comparison} ${threshold} ${def.unit}${also}, ${def.datapointsToAlarm} of ${def.evaluationPeriods} periods of ${per}`.replace(/\s+,/, ',')
}

function sparkOf(m: HealthMonitor, inst: AlarmInstanceState, def: AlarmDef | null): Array<number | null> {
  if (inst.signature) {
    return m.signatureHours(inst.signature, 24)
  }
  if (!def) return []
  const key = inst.labels ? fillPattern(def.metric, inst.labels) : def.metric
  const end = Math.floor(m.now() / MINUTE_MS) * MINUTE_MS
  const step = 15 * MINUTE_MS
  const buckets: Array<number[] | null> = Array.from({ length: 96 }, () => null)
  for (const r of m.minuteRows) {
    const i = Math.floor((r.t - (end - 96 * step)) / step)
    if (i < 0 || i >= 96) continue
    const v = r.v[key]
    const val = typeof v === 'number' ? v : def.kind === 'counter' ? 0 : null
    if (val === null) continue
    ;(buckets[i] ??= []).push(val)
  }
  return buckets.map((b) => {
    if (!b) return null
    if (def.kind === 'counter') return b.reduce((a, c) => a + c, 0)
    return Math.max(...b)
  })
}

export function alarmRow(m: HealthMonitor, inst: AlarmInstanceState): AlarmRow {
  const def = defOf(inst)
  const override = effectiveOverride(m.overrides, inst.id, inst.defId)
  const held = overrideHolds(override, m.now())
  const isSpike = inst.defId === 'log.spike'
  return {
    id: inst.id,
    defId: inst.defId,
    title: def?.title ?? (isSpike ? 'Log line far above its normal' : 'Log line high every day'),
    description: def?.description ?? (isSpike
      ? 'This kind of warn/error line came at least 5 times as often as on the same hour of the last week.'
      : 'This kind of line came very often on each of the last 3 days (200 a day for an error, 1,000 for a warning).'),
    state: inst.state,
    since: inst.since,
    value: inst.value,
    unit: def?.unit ?? (isSpike ? 'per hour' : 'per day'),
    condition: def ? conditionText(def, override?.threshold ?? def.threshold) : (isSpike ? '5 times normal and at least 30 in an hour' : 'every day of the last 3 over the daily limit'),
    ...(inst.labels ? { labels: inst.labels } : {}),
    ...(inst.signature ? { signature: inst.signature } : {}),
    spark: sparkOf(m, inst, def),
    actions: inst.actions,
    ...(inst.fixTaskId ? { fixTaskId: inst.fixTaskId } : {}),
    ...(override ? { override } : {}),
    held,
  }
}

export function healthView(m: HealthMonitor): HealthView {
  const rows = instancesWithPending(m).map((a) => alarmRow(m, a))
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.since - a.since)
  const counts: Record<AlarmState, number> = { OK: 0, ALARM: 0, INSUFFICIENT_DATA: 0 }
  for (const r of rows) counts[r.state]++
  return { checkedAt: m.now(), actions: actionsOn, counts, fixesToday: m.fixesToday, fixesPerDay: FIX_TASKS_PER_DAY, alarms: rows }
}

export interface AlarmDetail extends AlarmRow {
  history: AlarmInstanceState['history']
  /** The last 24 hours minute by minute (built-in alarms), or by hour for 7 days (log alarms). */
  series: Array<{ t: number; v: number | null }>
  sample?: string
}

export function alarmDetail(m: HealthMonitor, id: string): AlarmDetail | null {
  const inst = instancesWithPending(m).find((a) => a.id === id)
  if (!inst) return null
  const def = defOf(inst)
  let series: AlarmDetail['series'] = []
  if (inst.signature) {
    const counts = m.signatureHours(inst.signature, 24 * 7)
    const h = Math.floor(m.now() / 3_600_000) * 3_600_000
    series = counts.map((v, i) => ({ t: h - (counts.length - 1 - i) * 3_600_000, v }))
  } else if (def) {
    const key = inst.labels ? fillPattern(def.metric, inst.labels) : def.metric
    series = m.minuteRows.map((r) => ({ t: r.t, v: typeof r.v[key] === 'number' ? r.v[key] : def.kind === 'counter' ? 0 : null }))
  }
  return {
    ...alarmRow(m, inst),
    history: inst.history,
    series,
    ...(inst.signature && m.signatureSample(inst.signature) ? { sample: m.signatureSample(inst.signature) } : {}),
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (t) return
    t = setTimeout(() => { t = null; fn() }, ms)
    t.unref?.()
  }
}

/**
 * Walnut's own health in one line, for Main's Brief (brief_read's `health`): the
 * alarms in ALARM, each with its fix task (a line under Working) or the card it
 * gave the user (under Needs you). Null when the monitor does not run here.
 */
export function healthBriefLine(): { line: string; alarms: Array<{ id: string; title: string; now: string; fixTaskId?: string; toldUser: boolean }> } | null {
  const m = running
  if (!m) return null
  const alarms = healthView(m).alarms.filter((a) => a.state === 'ALARM').map((a) => ({
    id: a.id,
    title: a.signature ? `${a.title}: ${a.signature}` : a.labels?.host ? `${a.title} (${a.labels.host})` : a.title,
    now: a.value === null ? 'no value' : `${a.value} ${a.unit}`.trim(),
    ...(a.fixTaskId ? { fixTaskId: a.fixTaskId } : {}),
    toldUser: a.actions.some((x) => x.kind === 'notify'),
  }))
  const line = alarms.length
    ? `Walnut health: ${alarms.length} in alarm: ${alarms.map((a) => `${a.title} (${a.now})`).join('; ')}. Details on Settings > Walnut Health.`
    : 'Walnut health: no alarm is ringing.'
  return { line, alarms }
}
