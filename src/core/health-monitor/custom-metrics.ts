/**
 * The person's own metrics: a command that prints a number, run every few
 * minutes on this machine, recorded as the gauge `custom.<id>`, with an optional
 * alarm on it. They live in the person's own config.yaml, so a check of a private
 * tool (a deploy queue, a test gate) never reaches the public code:
 *
 *   health_monitor:
 *     metrics:
 *       - id: deploy-queue-wait
 *         title: Deploy queue wait
 *         command: my-deploy-tool queue --oldest-minutes
 *         every_min: 5
 *         unit: min
 *         alarm: { comparison: '>', threshold: 60, minutes: 15 }
 *         owner_task: <task id>        # optional: who hears it instead of a new fix task
 *
 * A command runs through `sh -c` as a child process group with a deadline, never on
 * the event loop, and only on the server that takes actions (never an isolated one).
 */

import { spawn } from 'node:child_process'
import { log } from '../../logging/index.js'
import { safeKillProcessGroup } from '../process-group-kill.js'
import type { AlarmDef, Comparison } from './types.js'

export interface CustomMetricConfig {
  id: string
  title?: string
  command: string
  every_min?: number
  unit?: string
  alarm?: { comparison?: Comparison; threshold: number; minutes?: number; then?: 'fix-task' | 'notify' | 'none' }
  owner_task?: string
}

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/i
const COMPARISONS: readonly Comparison[] = ['>', '>=', '<', '<=']
export const COMMAND_TIMEOUT_MS = 30_000

/** The valid entries of the config list (a bad one is skipped and logged, never fatal). */
export function readCustomMetrics(raw: unknown, warn = true): CustomMetricConfig[] {
  if (!Array.isArray(raw)) return []
  const out: CustomMetricConfig[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const m = r as Partial<CustomMetricConfig> | null
    if (!m || typeof m.id !== 'string' || !ID.test(m.id) || seen.has(m.id) || typeof m.command !== 'string' || !m.command.trim() || m.command.length > 2000) {
      if (warn) log.obs.warn('health monitor: custom metric skipped', { id: m && typeof m.id === 'string' ? m.id : undefined })
      continue
    }
    seen.add(m.id)
    out.push(m as CustomMetricConfig)
  }
  return out
}

/** The alarm defs of the metrics that ask for one. */
export function customAlarmDefs(metrics: readonly CustomMetricConfig[]): AlarmDef[] {
  const defs: AlarmDef[] = []
  for (const m of metrics) {
    const a = m.alarm
    if (!a || typeof a.threshold !== 'number' || !Number.isFinite(a.threshold)) continue
    const comparison = a.comparison && COMPARISONS.includes(a.comparison) ? a.comparison : '>'
    const minutes = Math.min(Math.max(Math.round(a.minutes ?? 15), 1), 240)
    defs.push({
      id: `custom.${m.id}`,
      title: m.title?.trim() || m.id,
      description: `Your own metric: the number \`${m.command.slice(0, 120)}\` prints, every ${everyMin(m)} min.`,
      metric: `custom.${m.id}`, kind: 'gauge', stat: comparison.startsWith('<') ? 'min' : 'max', periodMin: 1,
      comparison, threshold: a.threshold, evaluationPeriods: minutes, datapointsToAlarm: minutes, missing: 'missing',
      unit: m.unit ?? '', action: { then: a.then ?? 'fix-task' },
      ...(m.owner_task ? { ownerTask: m.owner_task } : {}),
    })
  }
  return defs
}

function everyMin(m: CustomMetricConfig): number {
  return Math.min(Math.max(Math.round(m.every_min ?? 5), 1), 60)
}

/** The first number a command printed. */
export function firstNumber(stdout: string): number | null {
  const hit = /-?\d+(?:\.\d+)?/.exec(stdout)
  if (!hit) return null
  const n = Number(hit[0])
  return Number.isFinite(n) ? n : null
}

export type CommandRunner = (command: string, signal: AbortSignal) => Promise<string>

const OUTPUT_MAX = 64 * 1024
/** After the group was killed, how long to wait for its pipes to close before giving up on it. */
const KILL_SETTLE_MS = 5_000

/**
 * `sh -c` in its own process group: at the deadline, past the output cap or on abort the
 * WHOLE group is killed (a command's children too), and it settles only once that group
 * has gone, so a hung check never piles up beside the next one.
 */
const shRun: CommandRunner = (command, signal) => new Promise((resolve, reject) => {
  const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  let failure: Error | null = null
  let settled = false
  const settle = (err: Error | null): void => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    clearTimeout(giveUp)
    signal.removeEventListener('abort', onAbort)
    if (err) reject(err)
    else resolve(out)
  }
  let giveUp: ReturnType<typeof setTimeout> | undefined
  const stop = (why: string): void => {
    if (failure) return
    failure = new Error(why)
    safeKillProcessGroup(child.pid, 'SIGKILL')
    giveUp = setTimeout(() => settle(failure), KILL_SETTLE_MS)
  }
  const deadline = setTimeout(() => stop(`timed out after ${COMMAND_TIMEOUT_MS / 1000}s`), COMMAND_TIMEOUT_MS)
  const onAbort = (): void => stop('stopped: the metric changed or the monitor stopped')
  signal.addEventListener('abort', onAbort)
  if (signal.aborted) onAbort()
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString()
    if (out.length > OUTPUT_MAX) stop(`printed more than ${OUTPUT_MAX / 1024} KB`)
  })
  child.on('error', (err) => settle(failure ?? err))
  child.on('close', (code) => settle(failure ?? (code === 0 ? null : new Error(`exit ${code}`))))
})

interface Slot { command: string; lastRun: number; ctrl?: AbortController }

/** Runs each metric when it is due and reports its number as a gauge. */
export class CustomMetricRunner {
  private slots = new Map<string, Slot>()

  constructor(private readonly setGauge: (key: string, value: number | null) => void, private readonly run: CommandRunner = shRun) {}

  /** Start the due ones (no wait for them); `metrics` is the config's list now. */
  tick(metrics: readonly CustomMetricConfig[], now: number): Promise<void[]> {
    const wanted = new Map(metrics.map((m) => [m.id, m] as const))
    // A metric removed or given another command: its run is stopped, its number forgotten,
    // and a late answer of the old command never lands on the new one.
    for (const [id, slot] of this.slots) {
      if (wanted.get(id)?.command === slot.command) continue
      slot.ctrl?.abort()
      this.slots.delete(id)
      this.setGauge(`custom.${id}`, null)
    }
    const due = metrics.filter((m) => {
      const slot = this.slots.get(m.id)
      return !slot || (!slot.ctrl && now - slot.lastRun >= everyMin(m) * 60_000 - 1_000)
    })
    return Promise.all(due.map(async (m) => {
      const slot: Slot = this.slots.get(m.id) ?? { command: m.command, lastRun: 0 }
      this.slots.set(m.id, slot)
      const ctrl = new AbortController()
      slot.ctrl = ctrl
      slot.lastRun = now
      const current = (): boolean => this.slots.get(m.id) === slot && !ctrl.signal.aborted
      try {
        const n = firstNumber(await this.run(m.command, ctrl.signal))
        if (!current()) return
        this.setGauge(`custom.${m.id}`, n)
        if (n === null) log.obs.warn('health monitor: custom metric printed no number', { id: m.id })
      } catch (err) {
        if (!current()) return
        this.setGauge(`custom.${m.id}`, null)
        log.obs.warn('health monitor: custom metric failed', { id: m.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) })
      } finally {
        if (slot.ctrl === ctrl) delete slot.ctrl
      }
    }))
  }

  /** Stop every run in flight; nothing they print is recorded. */
  stop(): void {
    for (const slot of this.slots.values()) slot.ctrl?.abort()
    this.slots.clear()
  }
}
