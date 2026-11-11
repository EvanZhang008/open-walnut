/**
 * Settings > Sessions > Remote history storage (core/history-remote/). The setting itself is
 * saved through the config like every other row; these routes read how much is stored there,
 * test a setting, and set up an AWS bucket in one click. None of them takes or answers a
 * credential: the server reads those from the AWS chain or a named ~/.aws profile.
 *
 * `test` and `setup` act on an outside account, so a test run on a real server is refused
 * (the header marks objects Walnut makes, not a bucket elsewhere); throwaway servers ignore it.
 */
import { Router, type Request, type Response } from 'express'
import type { HistoryRemoteConfig } from '../../core/types.js'
import { log } from '../../logging/index.js'

export const historyRemoteRouter = Router()

/** The setting to act on: the form's own (unsaved fields included) when sent, else the saved one. */
async function settingOf(req: Request) {
  const { getConfig } = await import('../../core/config-manager.js')
  const { resolveRemote } = await import('../../core/history-remote/store.js')
  const draft = req.body && typeof req.body === 'object' ? (req.body as { setting?: HistoryRemoteConfig }).setting : undefined
  const c = draft && typeof draft === 'object' ? draft : (await getConfig()).session?.history_remote ?? {}
  // Acting on it now, whether or not the tier is switched on.
  return resolveRemote({ ...c, enabled: true, days: c.days === 0 ? undefined : c.days })
}

async function refusedInTestRun(res: Response): Promise<boolean> {
  const { ambientTestRun } = await import('../../core/test-run.js')
  if (!ambientTestRun()) return false
  res.status(409).json({ error: 'A test run does not write to outside storage.', code: 'test_run' })
  return true
}

// GET /api/history-remote/status: the setting as it applies, and what is stored remotely now.
historyRemoteRouter.get('/status', async (_req, res) => {
  try {
    const { remoteStatus } = await import('../../core/history-remote/service.js')
    res.json(await remoteStatus())
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// POST /api/history-remote/test {setting?}: write, check, read back and remove one small object.
historyRemoteRouter.post('/test', async (req, res) => {
  if (await refusedInTestRun(res)) return
  const { testRemote } = await import('../../core/history-remote/store.js')
  const r = await settingOf(req)
  const out = await testRemote(r)
  log.web.info('history remote storage tested', { bucket: r.bucket, endpoint: r.endpoint, ok: out.ok, step: out.step, ms: out.ms })
  res.json(out)
})

// POST /api/history-remote/setup {setting?}: on AWS S3, create the bucket private, encrypted, Standard-IA after 30 days.
historyRemoteRouter.post('/setup', async (req, res) => {
  if (await refusedInTestRun(res)) return
  const { setupAwsBucket, plainError } = await import('../../core/history-remote/store.js')
  const r = await settingOf(req)
  try {
    const out = await setupAwsBucket(r)
    log.web.info('history remote storage set up', { bucket: r.bucket, region: r.region, created: out.created })
    res.json({ ok: true, ...out })
  } catch (e) {
    res.json({ ok: false, error: plainError(e) })
  }
})
