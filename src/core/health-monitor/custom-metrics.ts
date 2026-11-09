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
 * A command runs through `sh -c` as a child process with a deadline, never on the
 * event loop, and only on the server that takes actions (never an isolated one).
 */

import { execFile } from 'node:child_process'
import { log } from '../../logging/index.js'
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

export type CommandRunner = (command: string) => Promise<string>

const shRun: CommandRunner = (command) => new Promise((resolve, reject) => {
  execFile('/bin/sh', ['-c', command], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
    if (err) reject(err)
    else resolve(String(stdout))
  })
})

/** Runs each metric when it is due and reports its number as a gauge. */
export class CustomMetricRunner {
  private lastRun = new Map<string, number>()
  private inFlight = new Set<string>()

  constructor(private readonly setGauge: (key: string, value: number | null) => void, private readonly run: CommandRunner = shRun) {}

  /** Start the due ones (no wait for them); `metrics` is the config's list now. */
  tick(metrics: readonly CustomMetricConfig[], now: number): Promise<void[]> {
    const due = metrics.filter((m) => !this.inFlight.has(m.id) && now - (this.lastRun.get(m.id) ?? 0) >= everyMin(m) * 60_000 - 1_000)
    return Promise.all(due.map(async (m) => {
      this.inFlight.add(m.id)
      this.lastRun.set(m.id, now)
      try {
        const n = firstNumber(await this.run(m.command))
        this.setGauge(`custom.${m.id}`, n)
        if (n === null) log.obs.warn('health monitor: custom metric printed no number', { id: m.id })
      } catch (err) {
        this.setGauge(`custom.${m.id}`, null)
        log.obs.warn('health monitor: custom metric failed', { id: m.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) })
      } finally {
        this.inFlight.delete(m.id)
      }
    }))
  }
}
