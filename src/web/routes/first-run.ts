/**
 * First-run setup (core/first-run.ts).
 *
 * GET  /api/first-run          -> { pending: step[] }: the questions this install still asks
 * POST /api/first-run/answer   { step } -> { ok, pending }: the person answered one (Done or Not now)
 *
 * A cloud companion and a host replica ask nothing (their config is not the person's
 * first install); a replica's answer would need the Mac, and it never shows the dialog.
 */
import { Router } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { modifyConfigDoc } from '../../core/config-store.js'
import { isFirstRunStep, pendingFirstRunSteps, recordFirstRunAnswer } from '../../core/first-run.js'
import { isCompanion, isHostReplicaProgram } from '../../core/server-role.js'
import { emitSettingsConfigChanged } from '../../core/config-broadcast.js'
import { ambientTestRun } from '../../core/test-run.js'
import { log } from '../../logging/index.js'

export const firstRunRouter = Router()

const asksNothing = (): boolean => isCompanion() || isHostReplicaProgram()

firstRunRouter.get('/', async (_req, res, next) => {
  try {
    if (asksNothing()) {
      res.json({ pending: [] })
      return
    }
    res.json({ pending: pendingFirstRunSteps(await getConfig()) })
  } catch (err) {
    next(err)
  }
})

firstRunRouter.post('/answer', async (req, res, next) => {
  try {
    const step = (req.body as { step?: unknown } | undefined)?.step
    if (!isFirstRunStep(step)) {
      res.status(400).json({ error: 'unknown step', code: 'bad_step' })
      return
    }
    if (asksNothing()) {
      res.json({ ok: true, pending: [] })
      return
    }
    // A test run's answer (an automated browser on the person's own server) is not theirs:
    // it records nothing, so their first run still asks (CLAUDE.md, test runs).
    if (ambientTestRun()) {
      res.json({ ok: true, pending: pendingFirstRunSteps(await getConfig()).filter((s) => s !== step), recorded: false })
      return
    }
    const wrote = await modifyConfigDoc((doc) => {
      const w = recordFirstRunAnswer(doc, step)
      return { write: w, result: w }
    })
    const config = await getConfig()
    if (wrote) {
      log.web.info('first-run: step answered', { step })
      emitSettingsConfigChanged(config)
    }
    res.json({ ok: true, pending: pendingFirstRunSteps(config) })
  } catch (err) {
    next(err)
  }
})
