/**
 * The health monitor's API (core/health-monitor/): the Health page in Settings
 * and the `health_monitor` / `health_alarm_set` ops read and change it here.
 *
 *   GET   /api/v1/health-monitor              every alarm with its state and a 24-hour spark
 *   GET   /api/v1/health-monitor/alarms/:id   one alarm: its series and its history
 *   PATCH /api/v1/health-monitor/alarms/:id   { threshold?, enabled?, muted_for?, muted_until?, owner_task? }
 *   PUT   /api/v1/health-monitor/settings     { fix_tasks: record | start | off }  (config.yaml health_monitor)
 *
 * Reads come from memory; nothing here waits on a host or the disk.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { alarmDetail, healthView, runningHealthMonitor } from '../../core/health-monitor/index.js'
import { builtinAlarm } from '../../core/health-monitor/alarms.js'
import type { OverridePatch } from '../../core/health-monitor/overrides.js'

export const healthMonitorV1Router = Router()

function notRunning(res: Response): void {
  res.status(503).json({ error: 'not_running', message: 'The health monitor does not run on this server (it runs on the primary).' })
}

healthMonitorV1Router.get('/health-monitor', async (req: Request, res: Response) => {
  const m = runningHealthMonitor()
  if (!m) { notRunning(res); return }
  // ?alarm=<id>: that one alarm in full (the op's one binding).
  const one = typeof req.query.alarm === 'string' ? req.query.alarm : ''
  if (one) {
    const detail = alarmDetail(m, one)
    if (!detail) { res.status(404).json({ error: 'unknown_alarm', message: `No alarm "${one}".` }); return }
    res.json(detail)
    return
  }
  res.json({ ...healthView(m), fixTasks: await fixTasksMode() })
})

async function fixTasksMode(): Promise<'record' | 'start' | 'off'> {
  const { getConfig } = await import('../../core/config-manager.js')
  const v = (await getConfig()).health_monitor?.fix_tasks
  return v === 'start' || v === 'off' ? v : 'record'
}

/** Who made a change: the calling session's task, else a person. */
async function changedBy(req: Request): Promise<string> {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!sid) return 'human'
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(sid).catch(() => null)
  return caller?.kind === 'session' && caller.record.taskId ? `task:${caller.record.taskId}` : 'agent'
}

healthMonitorV1Router.put('/health-monitor/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = (req.body ?? {}).fix_tasks
    if (mode !== 'record' && mode !== 'start' && mode !== 'off') {
      res.status(400).json({ error: 'bad_fix_tasks', message: 'fix_tasks is record (file a task), start (start a session on it) or off.' }); return
    }
    // A test run never changes the person's config (core/test-run.ts).
    const { ambientTestRun } = await import('../../core/test-run.js')
    if (ambientTestRun()) { res.status(409).json({ error: 'test_run', message: 'A test run does not change the health monitor settings.' }); return }
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const cur = (await getConfig()).health_monitor ?? {}
    await updateConfig({ health_monitor: { ...cur, fix_tasks: mode } })
    const { log } = await import('../../logging/index.js')
    log.obs.info('health monitor: fix tasks set', { fixTasks: mode, by: await changedBy(req) })
    res.json({ fixTasks: await fixTasksMode() })
  } catch (err) {
    next(err)
  }
})

healthMonitorV1Router.get('/health-monitor/alarms/:id', (req: Request, res: Response) => {
  const m = runningHealthMonitor()
  if (!m) { notRunning(res); return }
  const detail = alarmDetail(m, String(req.params.id))
  if (!detail) { res.status(404).json({ error: 'unknown_alarm', message: `No alarm "${req.params.id}".` }); return }
  res.json(detail)
})

/** "90m", "2h", "3d" → ms. */
function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2].toLowerCase() as 'm' | 'h' | 'd']
  return n > 0 && n <= 30 * 86_400_000 ? n : null
}

healthMonitorV1Router.patch('/health-monitor/alarms/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const m = runningHealthMonitor()
    if (!m) { notRunning(res); return }
    const id = String(req.params.id)
    // A built-in's own id changes all its instances; an instance id (a host's, a log kind's) only that one.
    if (!m.alarms[id] && !builtinAlarm(id)) { res.status(404).json({ error: 'unknown_alarm', message: `No alarm "${id}".` }); return }
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: OverridePatch = {}
    if (body.threshold !== undefined) {
      if (body.threshold !== null && (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold))) {
        res.status(400).json({ error: 'bad_threshold', message: 'threshold is a number, or null to go back to the default.' }); return
      }
      if (typeof body.threshold === 'number' && (id.startsWith('log.') || m.alarms[id]?.signature)) {
        res.status(400).json({ error: 'bad_threshold', message: 'A log alarm has no threshold of its own: mute or disable it instead.' }); return
      }
      patch.threshold = body.threshold as number | null
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'bad_enabled', message: 'enabled is true or false.' }); return }
      patch.enabled = body.enabled
    }
    if (body.muted_for !== undefined) {
      const ms = typeof body.muted_for === 'string' ? parseDuration(body.muted_for) : null
      if (ms === null) { res.status(400).json({ error: 'bad_muted_for', message: 'muted_for is like "90m", "2h" or "3d" (at most 30 days).' }); return }
      patch.mutedUntil = m.now() + ms
    } else if (body.muted_until !== undefined) {
      if (body.muted_until === null) patch.mutedUntil = null
      else {
        const t = typeof body.muted_until === 'string' ? Date.parse(body.muted_until) : NaN
        if (!Number.isFinite(t)) { res.status(400).json({ error: 'bad_muted_until', message: 'muted_until is an ISO time, or null to unmute.' }); return }
        patch.mutedUntil = t
      }
    }
    if (body.owner_task !== undefined) {
      if (body.owner_task === null) patch.ownerTask = null
      else {
        if (typeof body.owner_task !== 'string' || !body.owner_task.trim()) {
          res.status(400).json({ error: 'bad_owner_task', message: 'owner_task is a task id, or null to file fix tasks again.' }); return
        }
        const { getTask } = await import('../../core/task-manager.js')
        const task = await getTask(body.owner_task.trim()).catch(() => null)
        if (!task) { res.status(404).json({ error: 'unknown_task', message: `No task "${body.owner_task}".` }); return }
        patch.ownerTask = task.id
      }
    }
    if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing_to_change', message: 'Give threshold, enabled, muted_for, muted_until or owner_task.' }); return }
    const override = m.setOverride(id, patch, await changedBy(req))
    res.json({ id, override, alarm: m.alarms[id] ? alarmDetail(m, id) : null })
  } catch (err) {
    next(err)
  }
})
