/**
 * The health monitor's minute clock: close the minute's row, evaluate every
 * alarm, and act on the ones in ALARM (auto-fix first, then one fix task, or a
 * card for what only the user can do). State and history live in store.ts.
 *
 * Rules that keep it quiet:
 *  - one fix task per alarm: while its task is open, a new episode reuses it;
 *  - at most `FIX_TASKS_PER_DAY` new fix tasks in 24 hours across all alarms;
 *    an alarm over the cap says so on the Health page and tries again later;
 *  - an auto-fix runs once per episode; `then` waits its grace after it;
 *  - a muted or disabled alarm still evaluates but does nothing.
 */

import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { BUILTIN_ALARMS } from './alarms.js'
import { MinuteCollector, type SignatureCount } from './collect.js'
import { evaluateAlarm, fillPattern, indexRows, matchSeries, MINUTE_MS, parseSeriesKey, type RowIndex } from './evaluate.js'
import {
  chronicDays, chronicVerdict, hourStart, signatureId, spikeBaseline, spikeThreshold, spikeVerdict, HOUR_MS,
} from './log-alarms.js'
import { HealthStore, MEMORY_MINUTES, pruneLogHours, type LogHoursFile, type StateFile } from './store.js'
import type { AlarmDef, AlarmInstanceState, AlarmOverride, AlarmState, MinuteRow } from './types.js'

export const FIX_TASKS_PER_DAY = 5
const HISTORY_MAX = 50
const EVENTS_KEEP_MS = 7 * 86_400_000
/** An OK log alarm with no open fix task is forgotten after this. */
const LOG_ALARM_FORGET_MS = 7 * 86_400_000
/** Most log alarm instances kept at once. */
const MAX_LOG_ALARMS = 60
/** A fix task that closed while its alarm stays on gets a successor after this. */
const REOPEN_AFTER_MS = 6 * 3_600_000

export type FixMode = 'record' | 'start' | 'off'

export interface FixTaskInput {
  alarmId: string
  title: string
  brief: string
  mode: 'record' | 'start'
}

export interface EngineDeps {
  store: HealthStore
  collector: MinuteCollector
  pid: number
  now?: () => number
  /** The server's exit trace (shutdown cut-offs are read from it at boot). */
  exitTraceFile?: string | null
  fixMode: () => Promise<FixMode>
  autoFix: (id: string) => Promise<{ ok: boolean; detail: string }>
  openFixTask: (input: FixTaskInput) => Promise<{ taskId: string; started: boolean }>
  isTaskOpen: (taskId: string) => Promise<boolean>
  notify?: (alarmId: string, title: string, body: string) => void
  recover?: (alarmId: string) => void
  /** Something a reader shows changed (a state, an action). */
  onChange?: () => void
}

/**
 * What applies to one instance: its own override on top of its alarm's, field by
 * field, so a threshold set for one host keeps the alarm's own Turn off or Mute.
 */
export function effectiveOverride(
  overrides: Readonly<Record<string, AlarmOverride>>, instanceId: string, defId: string,
): AlarmOverride | undefined {
  const parent = overrides[defId]
  const own = instanceId === defId ? undefined : overrides[instanceId]
  if (!own) return parent
  if (!parent) return own
  const out: AlarmOverride = { ...parent, by: own.by, at: own.at }
  if (own.threshold !== undefined) out.threshold = own.threshold
  if (own.enabled !== undefined) out.enabled = own.enabled
  if (own.mutedUntil !== undefined) out.mutedUntil = Math.max(own.mutedUntil, parent.mutedUntil ?? 0)
  return out
}

/** Actions are held: turned off, or muted until a time still to come. */
export function overrideHolds(o: AlarmOverride | undefined, now: number): boolean {
  return o?.enabled === false || (o?.mutedUntil !== undefined && o.mutedUntil > now)
}

/** A log alarm's def, made per kind of line. */
function logDef(kind: 'spike' | 'chronic', sig: string, level: 'warn' | 'error'): AlarmDef {
  return {
    id: `log.${kind}`,
    title: kind === 'spike' ? 'Log line far above its normal' : 'Log line high every day',
    description: kind === 'spike'
      ? 'This kind of warn/error line came at least 5 times as often as on the same hour of the last week.'
      : `This kind of ${level} line came at least ${level === 'error' ? 200 : 1000} times on each of the last 3 days.`,
    metric: sig, kind: 'counter', stat: 'sum', periodMin: kind === 'spike' ? 60 : 1440,
    comparison: '>=', threshold: 0, evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'missing',
    unit: kind === 'spike' ? 'per hour' : 'per day', action: { then: 'fix-task' },
  }
}

export class HealthMonitor {
  private rows: MinuteRow[] = []
  private state: StateFile = { version: 1, alarms: {}, overrides: {}, events: [], fixes: [] }
  private logHours: LogHoursFile = { version: 1, hours: {}, meta: {} }
  /** Per-minute log kinds of the last hour (spike rule), in memory. */
  private recentSigs: Array<{ t: number; sigs: Map<string, SignatureCount> }> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private stopped = false
  private ticks = 0
  private saveChain: Promise<void> = Promise.resolve()
  readonly now: () => number

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Load, record this boot, and start the minute clock (`clock: false` in tests that drive tick()). */
  async start(opts: { clock?: boolean } = {}): Promise<void> {
    const now = this.now()
    const [rows, state, hours] = await Promise.all([
      this.deps.store.loadRecentMinutes(now), this.deps.store.loadState(), this.deps.store.loadLogHours(),
    ])
    this.rows = rows
    this.state = state
    this.logHours = hours
    // The spike rule's last hour survives a restart: a spike still going on stays in ALARM.
    for (const r of hours.recent ?? []) {
      if (r.t <= now - 61 * MINUTE_MS) continue
      const sigs = new Map<string, SignatureCount>()
      for (const [sid, n] of Object.entries(r.c)) {
        const m = hours.meta[sid]
        if (m?.sig) sigs.set(m.sig, { n, level: m.level, sample: m.sample })
      }
      this.recentSigs.push({ t: r.t, sigs })
    }
    delete this.logHours.recent
    this.state.events.push({ kind: 'boot', at: now, pid: this.deps.pid })
    await this.readShutdownBails()
    this.state.events = this.state.events.filter((e) => e.at > now - EVENTS_KEEP_MS)
    this.deps.collector.start()
    this.save()
    if (opts.clock !== false) this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.deps.collector.stop()
    this.saveLogs()
    this.save()
  }

  private arm(): void {
    if (this.stopped) return
    const now = this.now()
    const next = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS + 1_000
    this.timer = setTimeout(() => { void this.tick().finally(() => this.arm()) }, next - now)
    this.timer.unref?.()
  }

  /** Close the minute that just ended and evaluate. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      const t = Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS
      const { row, sigs } = await this.deps.collector.closeMinute(t, this.serverGauges(now))
      this.addRow(row)
      this.addSigs(t, sigs)
      void this.deps.store.appendMinute(row).catch((err) => log.obs.warn('health monitor: minute not written', { error: String(err) }))
      await this.evaluateAll(now)
      this.ticks++
      if (this.ticks % 5 === 0) this.saveLogs()
      if (this.ticks % 60 === 0) await this.forgetLogAlarms(now)
      if (this.ticks % 60 === 1) void this.deps.store.pruneMinutes(now).catch(() => {})
      this.save()
    } catch (err) {
      log.obs.warn('health monitor: tick failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.ticking = false
    }
  }

  private addRow(row: MinuteRow): void {
    const last = this.rows[this.rows.length - 1]
    if (last && last.t === row.t) this.rows[this.rows.length - 1] = row
    else this.rows.push(row)
    const from = row.t - MEMORY_MINUTES * MINUTE_MS
    while (this.rows.length && this.rows[0].t < from) this.rows.shift()
  }

  private addSigs(t: number, sigs: Map<string, SignatureCount>): void {
    this.recentSigs.push({ t, sigs })
    while (this.recentSigs.length && this.recentSigs[0].t <= t - 60 * MINUTE_MS) this.recentSigs.shift()
    const h = String(hourStart(t))
    const bucket = (this.logHours.hours[h] ??= {})
    // Stored by the kind's short id: a full key repeated in every hour would make the file megabytes.
    for (const [k, s] of sigs) {
      const sid = signatureId(k)
      bucket[sid] = (bucket[sid] ?? 0) + s.n
      const m = this.logHours.meta[sid]
      this.logHours.meta[sid] = { sig: k, level: m?.level === 'error' || s.level === 'error' ? 'error' : 'warn', sample: s.sample, lastAt: t }
    }
  }

  /** Boots and shutdown cut-offs of this server in the last 24 hours. */
  private serverGauges(now: number): Record<string, number> {
    const day = now - 86_400_000
    return {
      'server.restarts_24h': this.state.events.filter((e) => e.kind === 'boot' && e.at > day).length,
      'server.shutdown_bails_24h': this.state.events.filter((e) => e.kind === 'shutdown-bail' && e.at > day).length,
    }
  }

  /**
   * The exit trace names a cut-off shutdown with its pid; only pids this
   * monitor saw boot are this server's (the file also holds test servers').
   */
  private async readShutdownBails(): Promise<void> {
    const file = this.deps.exitTraceFile
    if (!file) return
    let text: string
    try {
      const h = await fsp.open(file, 'r')
      try {
        const { size } = await h.stat()
        const len = Math.min(size, 256 * 1024)
        const buf = Buffer.alloc(len)
        await h.read(buf, 0, len, size - len)
        text = buf.toString('utf-8')
      } finally { await h.close() }
    } catch { return }
    const pids = new Set(this.state.events.filter((e) => e.kind === 'boot').map((e) => e.pid))
    const seen = new Set(this.state.events.filter((e) => e.kind === 'shutdown-bail').map((e) => `${e.pid}:${e.at}`))
    for (const m of text.matchAll(/^\[([^\]]+)\] SERVER EXIT: shutdown bail after \d+ms pid=(\d+)/gm)) {
      const at = Date.parse(m[1])
      const pid = Number(m[2])
      if (!Number.isFinite(at) || !pids.has(pid) || seen.has(`${pid}:${at}`)) continue
      this.state.events.push({ kind: 'shutdown-bail', at, pid })
    }
  }

  // ── evaluation ──

  private effectiveDef(def: AlarmDef, instanceId: string): AlarmDef {
    const o = effectiveOverride(this.state.overrides, instanceId, def.id)
    return o?.threshold !== undefined ? { ...def, threshold: o.threshold } : def
  }

  private async evaluateAll(now: number): Promise<void> {
    const index = indexRows(this.rows)
    for (const def of BUILTIN_ALARMS) {
      for (const { id, key, labels } of this.instancesOf(def, index, now)) {
        const d = this.effectiveDef(def, id)
        const ev = evaluateAlarm(d, index, key, now)
        await this.apply(d, id, labels, ev.state, ev.value, `${ev.breaching} of ${d.evaluationPeriods} periods crossed ${d.comparison} ${d.threshold} ${d.unit}`.trim(), now)
      }
    }
    await this.evaluateLogs(now)
  }

  private instancesOf(def: AlarmDef, index: RowIndex, now: number): Array<{ id: string; key: string; labels?: Record<string, string> }> {
    if (!def.metric.includes('=*')) return [{ id: def.id, key: def.metric }]
    const out = new Map<string, { id: string; key: string; labels?: Record<string, string> }>()
    const from = now - def.periodMin * def.evaluationPeriods * MINUTE_MS - MINUTE_MS
    for (const [t, row] of index) {
      if (t < from) continue
      for (const k of Object.keys(row.v)) {
        const star = matchSeries(def.metric, k)
        if (star) out.set(k, { id: `${def.id}${k.slice(parseSeriesKey(k).name.length)}`, key: k, labels: star })
      }
    }
    // Instances already known keep evaluating, so they can go back to OK.
    for (const inst of Object.values(this.state.alarms)) {
      if (inst.defId !== def.id || !inst.labels) continue
      const key = fillPattern(def.metric, inst.labels)
      if (!out.has(key)) out.set(key, { id: inst.id, key, labels: inst.labels })
    }
    return [...out.values()]
  }

  private async evaluateLogs(now: number): Promise<void> {
    const last60 = new Map<string, number>()
    for (const m of this.recentSigs) for (const [k, s] of m.sigs) last60.set(k, (last60.get(k) ?? 0) + s.n)
    const candidates = new Set<string>([...last60.keys()])
    for (const m of Object.values(this.logHours.meta)) if (m.lastAt > now - 4 * 86_400_000 && m.sig) candidates.add(m.sig)
    for (const inst of Object.values(this.state.alarms)) if (inst.signature) candidates.add(inst.signature)
    candidates.delete('log.other')
    // Errors first, then the busiest: the daily cap on fix tasks goes to what matters most.
    const ranked = [...candidates].sort((a, b) => {
      const la = this.logHours.meta[signatureId(a)]?.level === 'error' ? 0 : 1
      const lb = this.logHours.meta[signatureId(b)]?.level === 'error' ? 0 : 1
      return la - lb || (last60.get(b) ?? 0) - (last60.get(a) ?? 0)
    })
    // The cap is on log alarms ringing now; ones back to OK are forgotten by forgetLogAlarms.
    let active = Object.values(this.state.alarms).filter((a) => a.signature && a.state === 'ALARM').length
    for (const sig of ranked) {
      const sid = signatureId(sig)
      const level = this.logHours.meta[sid]?.level ?? 'warn'
      // spike
      const spikeId = `log.spike:${sid}`
      const was = this.state.alarms[spikeId]
      const baseline = spikeBaseline(this.logHours.hours, sid, now)
      const count = last60.get(sig) ?? 0
      const sv = spikeVerdict(count, baseline, was?.state === 'ALARM')
      if (was || (sv === 'ALARM' && active < MAX_LOG_ALARMS)) {
        if (sv === 'ALARM' && was?.state !== 'ALARM') active++
        const reason = baseline === null ? 'not enough days recorded for a normal yet'
          : `${count} in the last hour; normal ${baseline}, alarm at ${spikeThreshold(baseline)}`
        await this.apply(logDef('spike', sig, level), spikeId, undefined, sv, count, reason, now, sig)
      }
      // chronic
      const chronicId = `log.chronic:${sid}`
      const wasC = this.state.alarms[chronicId]
      const days = chronicDays(this.logHours.hours, sid, now)
      const cv = chronicVerdict(days, level, wasC?.state === 'ALARM')
      if (wasC || (cv === 'ALARM' && active < MAX_LOG_ALARMS)) {
        if (cv === 'ALARM' && wasC?.state !== 'ALARM') active++
        const reason = `daily counts ${days.map((d) => (d === null ? 'n/a' : d)).join(', ')}`
        await this.apply(logDef('chronic', sig, level), chronicId, undefined, cv, days[days.length - 1] ?? null, reason, now, sig)
      }
    }
  }

  /** Forget log alarms long out of ALARM whose fix task (if any) is closed. Hourly. */
  private async forgetLogAlarms(now: number): Promise<void> {
    for (const [id, a] of Object.entries(this.state.alarms)) {
      if (!a.signature || a.state === 'ALARM' || a.since >= now - LOG_ALARM_FORGET_MS) continue
      if (a.fixTaskId && await this.deps.isTaskOpen(a.fixTaskId).catch(() => true)) continue
      delete this.state.alarms[id]
    }
  }

  // ── transitions and actions ──

  private async apply(
    def: AlarmDef, id: string, labels: Record<string, string> | undefined,
    next: AlarmState, value: number | null, reason: string, now: number, signature?: string,
  ): Promise<void> {
    let inst = this.state.alarms[id]
    if (!inst) {
      inst = { id, defId: def.id, ...(labels && Object.keys(labels).length ? { labels } : {}), state: next, since: now, value, evaluatedAt: now, history: [], actions: [], ...(signature ? { signature } : {}) }
      this.state.alarms[id] = inst
      if (next === 'ALARM') inst.history.push({ at: now, from: 'INSUFFICIENT_DATA', to: 'ALARM', value, reason })
      this.deps.onChange?.()
    } else if (inst.state !== next) {
      inst.history.push({ at: now, from: inst.state, to: next, value, reason })
      if (inst.history.length > HISTORY_MAX) inst.history.splice(0, inst.history.length - HISTORY_MAX)
      if (inst.state === 'ALARM' && inst.actions.some((a) => a.kind === 'notify')) this.deps.recover?.(id)
      if (next === 'ALARM') inst.actions = []
      inst.state = next
      inst.since = now
      log.obs.info('health monitor: alarm state', { alarm: id, state: next, value, reason })
      this.deps.onChange?.()
    }
    inst.value = value
    inst.evaluatedAt = now
    if (next === 'ALARM') await this.act(def, inst, reason, now)
  }

  private held(inst: AlarmInstanceState, now: number): boolean {
    return overrideHolds(effectiveOverride(this.state.overrides, inst.id, inst.defId), now)
  }

  private async act(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): Promise<void> {
    if (this.held(inst, now)) return
    const { autoFix, then, graceMin = 30 } = def.action
    if (autoFix && !inst.actions.some((a) => a.kind === 'auto-fix')) {
      let r: { ok: boolean; detail: string }
      try { r = await this.deps.autoFix(autoFix) } catch (err) { r = { ok: false, detail: err instanceof Error ? err.message : String(err) } }
      inst.actions.push({ at: now, kind: 'auto-fix', ok: r.ok, detail: r.detail })
      log.obs.info('health monitor: auto-fix ran', { alarm: inst.id, fix: autoFix, ok: r.ok, detail: r.detail })
      this.deps.onChange?.()
      return
    }
    const fixAt = inst.actions.find((a) => a.kind === 'auto-fix')?.at
    if (fixAt !== undefined && now - fixAt < graceMin * MINUTE_MS) return
    if (then === 'none') return
    if (then === 'notify') {
      if (inst.actions.some((a) => a.kind === 'notify')) return
      const fixed = inst.actions.find((a) => a.kind === 'auto-fix')
      this.deps.notify?.(inst.id, def.title, [def.description, reason, fixed ? `Walnut tried: ${fixed.detail}` : ''].filter(Boolean).join(' '))
      inst.actions.push({ at: now, kind: 'notify', ok: true, detail: 'told you in the notification center' })
      this.deps.onChange?.()
      return
    }
    await this.fixTask(def, inst, reason, now)
  }

  private async fixTask(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): Promise<void> {
    const done = inst.actions.find((a) => a.kind === 'fix-task')
    if (done?.ok) {
      // Its task closed and the alarm is still on hours later: the fix did not hold, so a new one.
      if (!done.taskId || now - done.at < REOPEN_AFTER_MS) return
      if (await this.deps.isTaskOpen(done.taskId).catch(() => true)) return
      inst.fixTaskId = undefined
    }
    // A failed try (over the cap, a launch error) is tried again at most every 30 minutes.
    else if (done && now - done.at < 30 * MINUTE_MS) return
    const record = (r: { ok: boolean; detail: string; taskId?: string }) => {
      inst.actions = inst.actions.filter((a) => a !== done)
      inst.actions.push({ at: now, kind: 'fix-task', ...r })
      this.deps.onChange?.()
    }
    if (inst.fixTaskId && await this.deps.isTaskOpen(inst.fixTaskId).catch(() => false)) {
      record({ ok: true, detail: 'its fix task is still open', taskId: inst.fixTaskId })
      return
    }
    const mode = await this.deps.fixMode()
    // Not a done action: switching fix tasks back on files one at the next retry.
    if (mode === 'off') { record({ ok: false, detail: 'fix tasks are off (health_monitor.fix_tasks)' }); return }
    this.state.fixes = this.state.fixes.filter((f) => f.at > now - 86_400_000)
    if (this.state.fixes.length >= FIX_TASKS_PER_DAY) {
      record({ ok: false, detail: `waiting: ${FIX_TASKS_PER_DAY} fix tasks were already opened in the last 24 hours` })
      return
    }
    try {
      const { taskId, started } = await this.deps.openFixTask({
        alarmId: inst.id, title: fixTitle(def, inst), brief: this.brief(def, inst, reason, now), mode,
      })
      inst.fixTaskId = taskId
      this.state.fixes.push({ at: now, alarmId: inst.id, taskId })
      record({ ok: true, detail: started ? 'opened a fix task and started it' : 'filed a fix task', taskId })
      log.obs.info('health monitor: fix task opened', { alarm: inst.id, taskId, started })
    } catch (err) {
      record({ ok: false, detail: `could not open a fix task: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /** The fix task's description: everything needed to start without asking. */
  brief(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): string {
    const lines = [
      `Walnut's health monitor raised the alarm "${def.title}" (${inst.id}) and could not clear it by itself. Find the root cause and fix it.`,
      '',
      '## The alarm',
      `What it watches: ${def.description}`,
      inst.signature ? `The log line kind: \`${inst.signature}\`` : `Metric: \`${inst.labels ? fillPattern(def.metric, inst.labels) : def.metric}\``,
      inst.signature && this.signatureSample(inst.signature) ? `A recent line: ${this.signatureSample(inst.signature)}` : '',
      `Why it is in ALARM: ${reason}.`,
      `In ALARM since ${new Date(inst.since).toISOString()}; checked ${new Date(now).toISOString()}.`,
    ]
    if (inst.signature) {
      const h = hourStart(now)
      const counts: string[] = []
      const sid = signatureId(inst.signature)
      for (let i = 23; i >= 0; i--) counts.push(String(this.logHours.hours[String(h - i * HOUR_MS)]?.[sid] ?? '-'))
      lines.push(`Per hour, the last 24 hours (oldest first, UTC): ${counts.join(' ')}`)
    } else {
      const key = inst.labels ? fillPattern(def.metric, inst.labels) : def.metric
      const vals = this.rows.slice(-120).map((r) => r.v[key]).filter((v): v is number => typeof v === 'number')
      if (vals.length) lines.push(`Last ${vals.length} minutes: ${vals.join(' ')}`)
    }
    const tried = inst.actions.filter((a) => a.kind === 'auto-fix')
    if (tried.length) lines.push(`Already tried: ${tried.map((a) => `${a.detail} (${a.ok ? 'ran' : 'failed'})`).join('; ')}`)
    lines.push(
      '',
      '## Done means',
      'The cause is fixed for its whole class (with a guard test), the fix is live, and this alarm reads OK on the Health page',
      `(\`walnut tools call health_monitor '{"alarm":"${inst.id}"}'\`). If the line or the number is expected and harmless, change`,
      'what is logged or counted instead (a lower log level, a better threshold with `health_alarm_set`), and say why.',
    )
    return lines.filter((l) => l !== '').join('\n')
  }

  /** Every write goes through one chain, in order, so an older snapshot never lands after a newer one. */
  private save(): void {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as StateFile
    this.saveChain = this.saveChain.then(() => this.deps.store.saveState(snapshot)).catch((err) => {
      log.obs.warn('health monitor: state not written', { error: String(err) })
    })
  }

  private saveLogs(): void {
    const now = this.now()
    pruneLogHours(this.logHours, now)
    const recent = this.recentSigs.map(({ t, sigs }) => ({ t, c: Object.fromEntries([...sigs].map(([k, s]) => [signatureId(k), s.n])) }))
    const snapshot = JSON.parse(JSON.stringify({ ...this.logHours, recent })) as LogHoursFile
    this.saveChain = this.saveChain.then(() => this.deps.store.saveLogHours(snapshot, now)).catch((err) => {
      log.obs.warn('health monitor: log hours not written', { error: String(err) })
    })
  }

  /** Resolves once every write asked so far is on disk (tests). */
  flushed(): Promise<void> {
    return this.saveChain
  }

  // ── reads and writes for the API ──

  /** Set a gauge another module owns (the status check). */
  setGauge(key: string, value: number | null): void {
    this.deps.collector.setGauge(key, value)
  }

  get alarms(): Readonly<Record<string, AlarmInstanceState>> { return this.state.alarms }
  get overrides(): Readonly<Record<string, AlarmOverride>> { return this.state.overrides }
  get minuteRows(): readonly MinuteRow[] { return this.rows }
  get fixesToday(): number { const now = this.now(); return this.state.fixes.filter((f) => f.at > now - 86_400_000).length }
  signatureHours(sig: string, hours: number): number[] {
    const h = hourStart(this.now())
    const out: number[] = []
    const sid = signatureId(sig)
    for (let i = hours - 1; i >= 0; i--) out.push(this.logHours.hours[String(h - i * HOUR_MS)]?.[sid] ?? 0)
    return out
  }
  signatureSample(sig: string): string | undefined { return this.logHours.meta[signatureId(sig)]?.sample }

  /** Change an alarm (a built-in's id applies to all its instances). */
  setOverride(id: string, patch: { threshold?: number | null; enabled?: boolean; mutedUntil?: number | null }, by: string): AlarmOverride | null {
    const prev = this.state.overrides[id]
    const next: AlarmOverride = { ...(prev ?? {}), by, at: this.now() }
    if (patch.threshold === null) delete next.threshold
    else if (patch.threshold !== undefined) next.threshold = patch.threshold
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.mutedUntil === null) delete next.mutedUntil
    else if (patch.mutedUntil !== undefined) next.mutedUntil = patch.mutedUntil
    const empty = next.threshold === undefined && next.enabled === undefined && next.mutedUntil === undefined
    if (empty) delete this.state.overrides[id]
    else this.state.overrides[id] = next
    this.save()
    this.deps.onChange?.()
    return empty ? null : next
  }
}

function fixTitle(def: AlarmDef, inst: AlarmInstanceState): string {
  const what = inst.signature ? `${def.id === 'log.spike' ? 'spike of' : 'constant'} "${inst.signature}"` : def.title
  const host = inst.labels?.host ? ` (${inst.labels.host})` : ''
  const t = `Fix: ${what}${host}`
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}
