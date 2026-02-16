/**
 * Heartbeat routes — status, manual trigger, and checklist CRUD.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getHeartbeatHandle } from '../server.js'
import { readHeartbeatChecklist, writeHeartbeatChecklist } from '../../heartbeat/checklist-io.js'

export const heartbeatRouter = Router()

// GET /api/heartbeat — get heartbeat status
heartbeatRouter.get('/', (_req: Request, res: Response) => {
  const handle = getHeartbeatHandle()

  if (!handle) {
    res.json({
      enabled: false,
      state: null,
      message: 'Heartbeat is not enabled. Set heartbeat.enabled: true in config.yaml.',
    })
    return
  }

  const state = handle.getState()
  res.json({
    enabled: true,
    state: {
      running: state.running,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      nextDueAt: state.nextDueAt ? new Date(state.nextDueAt).toISOString() : null,
      stopped: state.stopped,
    },
  })
})

// POST /api/heartbeat/trigger — manually trigger a heartbeat
heartbeatRouter.post('/trigger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const handle = getHeartbeatHandle()

    if (!handle) {
      res.status(400).json({
        error: 'Heartbeat is not enabled. Set heartbeat.enabled: true in config.yaml.',
      })
      return
    }

    const context = typeof req.body?.context === 'string' ? req.body.context : undefined
    handle.requestNow('manual', context)

    res.json({ ok: true, message: 'Heartbeat triggered (debounced, will fire within 250ms).' })
  } catch (err) {
    next(err)
  }
})

// GET /api/heartbeat/checklist — read HEARTBEAT.md content
heartbeatRouter.get('/checklist', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const content = await readHeartbeatChecklist()
    res.json({ content })
  } catch (err) {
    next(err)
  }
})

// PUT /api/heartbeat/checklist — update HEARTBEAT.md content
heartbeatRouter.put('/checklist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    await writeHeartbeatChecklist(content)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
