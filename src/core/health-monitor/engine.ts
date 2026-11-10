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

import { log } from '../../logging/index.js'
import { allAlarms } from './alarms.js'
import { flapHeld, sameEpisode } from './transitions.js'
import { MinuteCollector, type SignatureCount } from './collect.js'
import { evaluateAlarm, fillPattern, indexRows, matchSeries, MINUTE_MS, parseSeriesKey, type RowIndex } from './evaluate.js'
import {
  chronicDays, chronicVerdict, hourStart, logDef, signatureId, spikeBaseline, spikeThreshold, spikeVerdict, HOUR_MS,
} from './log-alarms.js'
import { HealthStore, MEMORY_MINUTES, pruneLogHours, type LogHoursFile, type StateFile } from './store.js'
import type { AlarmActionRecord, AlarmDef, AlarmInstanceState, AlarmOverride, AlarmState, EngineDeps, FixMode, MinuteRow, TellTaskResult } from './types.js'
import { fixBrief, recoveredNote, ringAgainNote, type BriefInput } from './brief.js'
import { bootOnSameBuild, shutdownBailsSince } from './exit-trace.js'
import { effectiveOverride, overrideHolds, ownerOf, patchOverride, type OverridePatch } from './overrides.js'

export { effectiveOverride, overrideHolds } from './overrides.js'
export { bootOnSameBuild } from './exit-trace.js'

export const FIX_TASKS_PER_DAY = 5
const HISTORY_MAX = 50
const EVENTS_KEEP_MS = 7 * 86_400_000
/** An OK log alarm with no open fix task is forgotten after this. */
const LOG_ALARM_FORGET_MS = 7 * 86_400_000
/** Most log alarm instances kept at once. */
const MAX_LOG_ALARMS = 60
/** A fix task that closed while its alarm stays on gets a successor after this. */
const REOPEN_AFTER_MS = 6 * 3_600_000
/** A failed fix-task step is tried again after this. */
const RETRY_MS = 30 * 60_000

export type { EngineDeps, FixMode, FixTaskInput, TellTaskInput, TellTaskResult } from './types.js'

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
    const build = this.deps.build ?? null
    this.state.events.push({ kind: 'boot', at: now, pid: this.deps.pid, build, sameBuild: bootOnSameBuild(this.state.events, build) })
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
      'server.unplanned_restarts_24h': this.state.events.filter((e) => e.kind === 'boot' && e.at > day && e.sameBuild === true).length,
      'server.deploys_24h': this.state.events.filter((e) => e.kind === 'boot' && e.at > day && e.sameBuild !== true).length,
      'server.shutdown_bails_24h': this.state.events.filter((e) => e.kind === 'shutdown-bail' && e.at > day).length,
    }
  }

  private async readShutdownBails(): Promise<void> {
    const file = this.deps.exitTraceFile
    if (file) this.state.events.push(...await shutdownBailsSince(file, this.state.events))
  }

  // ── evaluation ──

  private effectiveDef(def: AlarmDef, instanceId: string): AlarmDef {
    const o = effectiveOverride(this.state.overrides, instanceId, def.id)
    return o?.threshold !== undefined ? { ...def, threshold: o.threshold } : def
  }

  private async evaluateAll(now: number): Promise<void> {
    const index = indexRows(this.rows)
    const defs = allAlarms()
    // A custom alarm taken out of the config goes with it.
    for (const [id, inst] of Object.entries(this.state.alarms)) {
      if (inst.defId.startsWith('custom.') && !defs.some((d) => d.id === inst.defId)) delete this.state.alarms[id]
    }
    for (const def of defs) {
      for (const { id, key, labels } of this.instancesOf(def, index, now)) {
        const d = this.effectiveDef(def, id)
        const ev = evaluateAlarm(d, index, key, now)
        const verdict = ev.undetermined ? (this.state.alarms[id]?.state ?? 'INSUFFICIENT_DATA') : ev.state
        await this.apply(d, id, labels, verdict, ev.value, `${ev.breaching} of ${d.evaluationPeriods} periods crossed ${d.comparison} ${d.threshold} ${d.unit}`.trim(), now)
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
    verdict: AlarmState, value: number | null, reason: string, now: number, signature?: string,
  ): Promise<void> {
    let inst = this.state.alarms[id]
    let next = verdict
    if (!inst) {
      inst = { id, defId: def.id, ...(labels && Object.keys(labels).length ? { labels } : {}), state: next, since: now, value, evaluatedAt: now, history: [], actions: [], ...(signature ? { signature } : {}) }
      this.state.alarms[id] = inst
      if (next === 'ALARM') inst.history.push({ at: now, from: 'INSUFFICIENT_DATA', to: 'ALARM', value, reason })
      this.deps.onChange?.()
    } else {
      next = flapHeld(def, inst, verdict, now)
      if (inst.state !== next) {
        inst.history.push({ at: now, from: inst.state, to: next, value, reason })
        if (inst.history.length > HISTORY_MAX) inst.history.splice(0, inst.history.length - HISTORY_MAX)
        // Only OK is a recovery: no data (a check that failed, a gauge gone) proves nothing was fixed.
        if (inst.state === 'ALARM' && next === 'OK') this.recovered(def, inst, now)
        // A new episode starts from OK (or a first ring); back from no data it is the same one.
        if (next === 'ALARM') { if (!sameEpisode(inst)) inst.actions = []; delete inst.heldSince }
        inst.state = next
        inst.since = now
        log.obs.info('health monitor: alarm state', { alarm: id, state: next, value, reason })
        this.deps.onChange?.()
      }
    }
    inst.value = value
    inst.evaluatedAt = now
    if (next === 'ALARM') await this.act(def, inst, reason, now)
  }

  /** Back to OK: retire the card, and tell a task that works on it (never start one for that). */
  private recovered(def: AlarmDef, inst: AlarmInstanceState, now: number): void {
    inst.clearedAt = now
    if (inst.actions.some((a) => a.kind === 'notify')) this.deps.recover?.(inst.id)
    const told = inst.actions.find((a) => a.kind === 'fix-task' && a.ok && a.taskId && a.started)
    if (told?.taskId) {
      void this.deps.tellTask({ taskId: told.taskId, text: recoveredNote(def, inst, now), start: false })
        .catch((err) => log.obs.warn('health monitor: recovery note not sent', { alarm: inst.id, error: String(err) }))
    }
  }

  private held(inst: AlarmInstanceState, now: number): boolean {
    return overrideHolds(effectiveOverride(this.state.overrides, inst.id, inst.defId), now)
  }

  private async act(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): Promise<void> {
    if (this.deps.actsOn?.() === false || this.held(inst, now)) return
    const { autoFix, then, graceMin = 30 } = def.action
    if (autoFix && !inst.actions.some((a) => a.kind === 'auto-fix')) {
      let r: { ok: boolean; detail: string }
      try { r = await this.deps.autoFix(autoFix, inst.labels) } catch (err) { r = { ok: false, detail: err instanceof Error ? err.message : String(err) } }
      inst.actions.push({ at: now, kind: 'auto-fix', ok: r.ok, detail: r.detail })
      log.obs.info('health monitor: auto-fix ran', { alarm: inst.id, fix: autoFix, ok: r.ok, detail: r.detail })
      this.deps.onChange?.()
      return
    }
    const fixAt = inst.actions.find((a) => a.kind === 'auto-fix')?.at
    if (fixAt !== undefined && now - fixAt < graceMin * MINUTE_MS) return
    if (then === 'none') return
    // A task that owns the problem hears it instead of a new fix task (the user's card still goes out).
    const owner = ownerOf(effectiveOverride(this.state.overrides, inst.id, inst.defId), def.ownerTask)
    if (owner && await this.toOwner(def, inst, owner, reason, now) && then === 'fix-task') return
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

  private briefInput(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): BriefInput {
    return { def, inst, reason, now, rows: this.rows, hours: this.logHours.hours, ...(inst.signature ? { sample: this.signatureSample(inst.signature) } : {}) }
  }

  private record(inst: AlarmInstanceState, prev: AlarmActionRecord | undefined, r: Omit<AlarmActionRecord, 'at' | 'kind'>, now: number): void {
    inst.actions = inst.actions.filter((a) => a !== prev)
    inst.actions.push({ at: now, kind: 'fix-task', ...r })
    this.deps.onChange?.()
  }

  /** True once the owner task has it (told now or earlier this episode); false sends it the usual way. */
  private async toOwner(def: AlarmDef, inst: AlarmInstanceState, owner: string, reason: string, now: number): Promise<boolean> {
    const done = inst.actions.find((a) => a.kind === 'fix-task' && a.taskId === owner)
    // A closed owner (it finished, the alarm rings on) hands over to the fix-task path, which
    // files a new task after its usual delay (REOPEN_AFTER_MS) and never reopens the owner.
    if (!(await this.deps.isTaskOpen(owner).catch(() => !!done?.ok))) return false
    if (done?.ok) return true
    if (done && now - done.at < RETRY_MS) return true
    const mode = await this.deps.fixMode()
    if (mode === 'off') return false
    const r = await this.deps.tellTask({ taskId: owner, text: ringAgainNote(this.briefInput(def, inst, reason, now), true), start: mode === 'start' })
      .catch((err) => ({ delivered: false, started: false, detail: `could not reach its owner task: ${err instanceof Error ? err.message : String(err)}` }))
    inst.fixTaskId = owner
    this.record(inst, done, { ok: r.delivered || r.started, detail: r.detail, taskId: owner, started: r.delivered || r.started }, now)
    log.obs.info('health monitor: sent to its owner task', { alarm: inst.id, taskId: owner, delivered: r.delivered, started: r.started })
    return true
  }

  private async fixTask(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): Promise<void> {
    const done = inst.actions.find((a) => a.kind === 'fix-task')
    const open = async (id: string) => this.deps.isTaskOpen(id).catch(() => true)
    if (done?.ok && done.taskId) {
      // Filed while fix tasks only recorded, and they start now: start it (once).
      if (!done.started && await open(done.taskId) && (await this.deps.fixMode()) === 'start') {
        await this.tellReused(def, inst, done, done.taskId, reason, now, 'start')
        return
      }
      // Its task closed and the alarm is still on hours later: the fix did not hold, so a new one.
      if (now - done.at < REOPEN_AFTER_MS || await open(done.taskId)) return
      inst.fixTaskId = undefined
    } else if (done && now - done.at < RETRY_MS) {
      // A failed try (over the cap, a launch error, fix tasks off) is tried again at most every 30 minutes.
      return
    }
    const mode = await this.deps.fixMode()
    // Not a done action: switching fix tasks back on files one at the next retry.
    if (mode === 'off') { this.record(inst, done, { ok: false, detail: 'fix tasks are off (health_monitor.fix_tasks)' }, now); return }
    if (inst.fixTaskId && await this.deps.isTaskOpen(inst.fixTaskId).catch(() => false)) {
      await this.tellReused(def, inst, done, inst.fixTaskId, reason, now, mode)
      return
    }
    this.state.fixes = this.state.fixes.filter((f) => f.at > now - 86_400_000)
    if (this.state.fixes.length >= FIX_TASKS_PER_DAY) {
      this.record(inst, done, { ok: false, detail: `waiting: ${FIX_TASKS_PER_DAY} fix tasks were already opened in the last 24 hours` }, now)
      return
    }
    try {
      const { taskId, started } = await this.deps.openFixTask({
        alarmId: inst.id, title: fixTitle(def, inst), brief: this.brief(def, inst, reason, now), mode,
      })
      inst.fixTaskId = taskId
      this.state.fixes.push({ at: now, alarmId: inst.id, taskId })
      this.record(inst, done, { ok: true, detail: started ? 'opened a fix task and started it' : 'filed a fix task', taskId, started }, now)
      log.obs.info('health monitor: fix task opened', { alarm: inst.id, taskId, started })
    } catch (err) {
      this.record(inst, done, { ok: false, detail: `could not open a fix task: ${err instanceof Error ? err.message : String(err)}` }, now)
    }
  }

  /** Its open fix task gets the new episode (and a session, when fix tasks start). */
  private async tellReused(
    def: AlarmDef, inst: AlarmInstanceState, done: AlarmActionRecord | undefined, taskId: string, reason: string, now: number, mode: FixMode,
  ): Promise<void> {
    let r: TellTaskResult
    try {
      r = await this.deps.tellTask({ taskId, text: ringAgainNote(this.briefInput(def, inst, reason, now), false), start: mode === 'start' })
    } catch (err) {
      // A failed send or start (a full host, say) is tried again after RETRY_MS, never every minute.
      this.record(inst, done, { ok: false, detail: `its fix task is open; telling it failed: ${err instanceof Error ? err.message : String(err)}`, taskId }, now)
      return
    }
    this.record(inst, done, { ok: true, detail: r.delivered || r.started ? r.detail : 'its fix task is still open', taskId, started: r.delivered || r.started }, now)
  }

  /** The fix task's description: everything needed to start without asking. */
  brief(def: AlarmDef, inst: AlarmInstanceState, reason: string, now: number): string {
    return fixBrief(this.briefInput(def, inst, reason, now))
  }

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
  setOverride(id: string, patch: OverridePatch, by: string): AlarmOverride | null {
    const defId = this.state.alarms[id]?.defId ?? id
    // What it would inherit without an owner of its own: its alarm's (config) or, for an instance, its alarm's override.
    const inherited = ownerOf(defId === id ? undefined : this.state.overrides[defId], allAlarms().find((d) => d.id === defId)?.ownerTask)
    const next = patchOverride(this.state.overrides[id], patch, by, this.now(), inherited !== undefined)
    if (next) this.state.overrides[id] = next
    else delete this.state.overrides[id]
    this.save()
    this.deps.onChange?.()
    return next
  }

}

function fixTitle(def: AlarmDef, inst: AlarmInstanceState): string {
  const what = inst.signature ? `${def.id === 'log.spike' ? 'spike of' : 'constant'} "${inst.signature}"` : def.title
  const host = inst.labels?.host ? ` (${inst.labels.host})` : ''
  const t = `Fix: ${what}${host}`
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}
