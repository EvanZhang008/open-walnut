/**
 * A task's change links with their live status (core/changes/watch.ts), mounted on the tasks router:
 *
 *   GET  /api/tasks/:id/changes                    { enabled, changes }: the change links a provider
 *                                                  reads, tag order; one not read yet has checkedAt ''.
 *   POST /api/tasks/:id/changes/refresh            the same, after reading them now; a read still
 *                                                  running at the deadline answers what is stored with
 *                                                  `stale: true` (its result arrives as a task event).
 *   GET  /api/tasks/:id/changes/stage?url=&stage=  { detail, error? }: one stage's steps, read live,
 *                                                  cached a minute, `{ detail: null, error: 'timeout' }`
 *                                                  past its deadline; only a stage the task's snapshot
 *                                                  of that link names, and only with the experiment on.
 *
 * Every answer has a deadline: a slow provider never pins a response.
 */

import type { NextFunction, Request, Response, Router } from 'express'
import { getTask } from '../../core/task-manager.js'
import { taskChangeLinks } from '../../core/changes/model.js'

const REFRESH_DEADLINE_MS = 10_000

function id(req: Request): string {
  const v = req.params.id
  return Array.isArray(v) ? v.join('/') : String(v ?? '')
}

export function registerTaskChangeRoutes(router: Router): void {
  router.get('/:id/changes', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await getTask(id(req))
      const { taskChangeView } = await import('../../core/changes/watch.js')
      res.json(await taskChangeView(task))
    } catch (err) {
      next(err)
    }
  })

  router.post('/:id/changes/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const taskId = (await getTask(id(req))).id
      const { changeStatusEnabled, refreshTaskChanges, taskChangeView } = await import('../../core/changes/watch.js')
      let stale = false
      if (await changeStatusEnabled()) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), REFRESH_DEADLINE_MS) })
        stale = (await Promise.race([refreshTaskChanges(taskId).catch(() => null), late])) === 'late'
        clearTimeout(timer)
      }
      const view = await taskChangeView(await getTask(taskId))
      res.json(stale ? { ...view, stale: true } : view)
    } catch (err) {
      next(err)
    }
  })

  router.get('/:id/changes/stage', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = typeof req.query.url === 'string' ? req.query.url : ''
      const stage = typeof req.query.stage === 'string' ? req.query.stage : ''
      if (!url || !stage) { res.status(400).json({ error: 'url and stage are required' }); return }
      const { changeStatusEnabled } = await import('../../core/changes/watch.js')
      if (!(await changeStatusEnabled())) { res.status(409).json({ detail: null, error: 'disabled' }); return }
      const task = await getTask(id(req))
      // Only a link the task holds and a stage its snapshot names: the route never reads anything else.
      const link = taskChangeLinks(task.tags).find((l) => l.url === url)
      if (!link) { res.status(404).json({ error: 'This task holds no such change link.' }); return }
      if (!task.change_status?.[url]?.deploy?.stages.some((s) => s.name === stage)) {
        res.status(404).json({ error: 'That change has no such stage.' })
        return
      }
      const { changeStageDetail } = await import('../../core/changes/stage-detail.js')
      res.json(await changeStageDetail(link, stage))
    } catch (err) {
      next(err)
    }
  })
}
