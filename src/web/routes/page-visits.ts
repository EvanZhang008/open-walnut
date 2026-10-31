/**
 * Local page-use counts (src/core/page-visits.ts).
 *
 *   POST   /api/page-visits  { keys: string[] }  -> { counted }
 *   GET    /api/page-visits                      -> the store
 *   DELETE /api/page-visits                      -> clears it
 *
 * A request carrying the test-run header (every automated browser, a labelled CLI or
 * curl) is answered and not counted, so test clicks never read as the user's visits.
 */
import { Router } from 'express'
import { TEST_RUN_HEADER, parseTestRunLabel } from '../../core/test-run.js'
import { readVisits, recordVisits, resetVisits } from '../../core/page-visits.js'

export const pageVisitsRouter = Router()

/** More keys in one POST than any batch of real visits holds. */
const MAX_KEYS_PER_POST = 50

pageVisitsRouter.post('/', async (req, res) => {
  const keys: unknown = req.body?.keys
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys must be an array of strings' })
  if (parseTestRunLabel(req.headers[TEST_RUN_HEADER])) return res.json({ counted: 0, testRun: true })
  const counted = await recordVisits(keys.slice(0, MAX_KEYS_PER_POST).filter((k): k is string => typeof k === 'string'))
  res.json({ counted })
})

pageVisitsRouter.get('/', async (_req, res) => {
  res.json(await readVisits())
})

pageVisitsRouter.delete('/', async (req, res) => {
  if (parseTestRunLabel(req.headers[TEST_RUN_HEADER])) return res.json({ ok: true, testRun: true })
  await resetVisits()
  res.json({ ok: true })
})
