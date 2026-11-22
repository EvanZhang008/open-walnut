/**
 * The real-use monitor's API (core/usage-watch/): the Real Use page in Settings and the
 * `usage_watch` op read and change it here.
 *
 *   GET  /api/v1/usage-watch?range=24h|7d   every tool, request and page error kind with its totals,
 *                                           its 7-day line and its alarm; the watches; the recent notes
 *   POST /api/v1/usage-watch                { action: set | exempt | drop | list | report | ship | probe, ... }
 *
 * Reads come from the monitor's own small file on this machine; nothing waits on a host.
 */
import { Router, type Request, type Response } from 'express'
import { usageReport, type ReportRange } from '../../core/usage-watch/report.js'
import { listWatches } from '../../core/usage-watch/watches.js'
import { recentNotes } from '../../core/usage-watch/route.js'
import { runUsageWatchAction, UsageWatchError } from '../../core/usage-watch/actions.js'
import { usageTargetOf } from '../../core/health-monitor/usage-alarms.js'

export const usageWatchV1Router = Router()

async function taskInfo(id: string): Promise<{ id: string; title: string; complete: boolean } | null> {
  const { listTasksByIds } = await import('../../core/task-manager.js')
  const [t] = await listTasksByIds([id]).catch(() => [])
  return t ? { id: t.id, title: t.title, complete: t.phase === 'COMPLETE' } : null
}

async function standsAbove(callerTask: string, taskId: string): Promise<boolean> {
  const { listTasks } = await import('../../core/task-manager.js')
  const { standsAbove: above } = await import('../../core/sessions/ask-answer.js')
  const all = await listTasks()
  const caller = all.find((t) => t.id === callerTask)
  const target = all.find((t) => t.id === taskId)
  return !!caller && !!target && above(caller, target, all)
}

/** Every real-use alarm instance with its state and what Walnut did, keyed `kind\tname`. */
async function alarmsByName(): Promise<Map<string, { id: string; state: string; since: number; did?: string }>> {
  const out = new Map<string, { id: string; state: string; since: number; did?: string }>()
  const { runningHealthMonitor, healthView } = await import('../../core/health-monitor/index.js')
  const m = runningHealthMonitor()
  if (!m) return out
  const view = healthView(m) as { alarms?: Array<{ id: string; defId?: string; labels?: Record<string, string>; state: string; since: number; actions?: Array<{ detail: string }> }> }
  for (const a of view.alarms ?? []) {
    const t = a.defId ? usageTargetOf(a.defId, a.labels) : null
    if (!t) continue
    const key = `${t.kind}\t${t.name}`
    const was = out.get(key)
    // One row shows its worst: an alarm over OK, the newest otherwise.
    if (was && (was.state === 'ALARM' || a.state !== 'ALARM')) continue
    const did = a.actions?.[a.actions.length - 1]?.detail
    out.set(key, { id: a.id, state: a.state, since: a.since, ...(did ? { did } : {}) })
  }
  return out
}

usageWatchV1Router.get('/usage-watch', async (req: Request, res: Response) => {
  const range: ReportRange = req.query.range === '24h' ? '24h' : '7d'
  const rep = usageReport(range)
  const alarms = await alarmsByName().catch(() => new Map())
  const watches = listWatches({ limit: 100 })
  const notes = recentNotes(20)
  // One read of every task the page names (watches and note recipients).
  const { listTasksByIds } = await import('../../core/task-manager.js')
  const ids = [...new Set([...watches.map((w) => w.taskId), ...notes.map((n) => n.recipient)])]
  const titles = new Map((await listTasksByIds(ids).catch(() => [])).map((t) => [t.id, t.title] as const))
  const { realUseOn } = await import('../../core/usage-watch/runtime.js')
  res.json({
    ...rep,
    rows: rep.rows.map((r) => ({ ...r, alarm: alarms.get(`${r.kind}\t${r.name}`) ?? null })),
    watches: watches.map((w) => ({ ...w, taskTitle: titles.get(w.taskId) ?? null })),
    notes: notes.map((n) => ({ ...n, recipientTitle: titles.get(n.recipient) ?? null })),
    alarmsOn: await realUseOn(),
    now: Date.now(),
  })
})

usageWatchV1Router.post('/usage-watch', async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { callerSidOf } = await import('../../core/sessions/outside-wait.js')
  const { callerTaskOf } = await import('../../core/sessions/user-spoke.js')
  const callerTask = await callerTaskOf(callerSidOf(req.headers)).catch(() => null)
  try {
    res.json(await runUsageWatchAction(body, { callerTask, taskInfo, standsAbove }))
  } catch (err) {
    if (err instanceof UsageWatchError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    throw err
  }
})
