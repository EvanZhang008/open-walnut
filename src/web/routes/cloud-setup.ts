/**
 * Cloud-companion setup API (mounted at /api/cloud-setup, normal console auth).
 *
 * Drives the resumable job in src/core/cloud-setup/job.ts. The job outlives any
 * single request — progress is read back via GET /job or streamed over the
 * replayable 'cloud-setup' SSE channel, NOT held open on the POST that started
 * it (a wizard tab reload must not lose a 10-minute provision).
 *
 * Every response body goes through redactCloudSetupJob(), so the pairing code
 * cannot leak. The one deliberate exception is GET /user-data: that blob IS the
 * thing the operator pastes into their VM, so it necessarily contains the code.
 */

import { Router } from 'express'
import {
  CloudSetupJobExistsError,
  CLOUD_SETUP_SSE_CHANNEL,
  cancelCloudSetupJob,
  deleteCloudSetupJob,
  getCloudSetupJob,
  provideCloudSetupInput,
  redactCloudSetupJob,
  retryCloudSetupJob,
  startCloudSetupJob,
} from '../../core/cloud-setup/job.js'
import type { CloudSetupDomainMode, CloudSetupProviderId } from '../../core/cloud-setup/job-types.js'
import { getDriver, listDrivers } from '../../core/cloud-setup/providers/index.js'
import { buildUserData, SSLIP_AUTO } from '../../core/cloud-setup/user-data.js'
import { log } from '../../logging/index.js'
import { attachSse } from '../sse-channels.js'

export const cloudSetupRouter = Router()

/** Credential probes shell out — never let a slow CLI hang the picker. */
const DETECT_TIMEOUT_MS = 5_000

const DOMAIN_MODES: CloudSetupDomainMode[] = ['own-domain', 'sslip']

function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}

// GET /api/cloud-setup/providers → [{ id, label, costHint, detect }]
cloudSetupRouter.get('/providers', async (_req, res, next) => {
  try {
    const providers = await Promise.all(listDrivers().map(async (driver) => {
      let detect: Awaited<ReturnType<typeof driver.detectCreds>>
      try {
        detect = await Promise.race([
          driver.detectCreds(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), DETECT_TIMEOUT_MS)
            t.unref?.()
          }),
        ])
      } catch {
        // A probe that hangs or throws is reported as "can't tell yet", never a 500.
        detect = { available: false, detail: 'Could not check credentials — try again.', needs: 'cli-login' }
      }
      return {
        id: driver.id,
        label: driver.label,
        costHint: driver.costHint,
        canProvision: driver.createVM != null,
        detect,
      }
    }))
    res.json({ providers })
  } catch (err) {
    next(err)
  }
})

// POST /api/cloud-setup/start → 202 { job } | 409 when one is in flight
cloudSetupRouter.post('/start', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      provider?: string
      domainMode?: string
      domain?: string
      region?: string
      instanceType?: string
      credentials?: string
      force?: boolean
    }
    if (!body.provider || !getDriver(body.provider)) {
      return badRequest(res, `Unknown or missing provider: ${body.provider ?? '(none)'}`)
    }
    if (!body.domainMode || !DOMAIN_MODES.includes(body.domainMode as CloudSetupDomainMode)) {
      return badRequest(res, `domainMode must be one of: ${DOMAIN_MODES.join(', ')}`)
    }
    if (body.domainMode === 'own-domain' && !body.domain) {
      return badRequest(res, 'own-domain mode requires a domain')
    }

    const job = await startCloudSetupJob({
      provider: body.provider as CloudSetupProviderId,
      domainMode: body.domainMode as CloudSetupDomainMode,
      domain: body.domain,
      region: body.region,
      instanceType: body.instanceType,
      credentials: body.credentials,
      force: body.force === true,
    })
    res.status(202).json({ job: redactCloudSetupJob(job) })
  } catch (err) {
    if (err instanceof CloudSetupJobExistsError) {
      res.status(409).json({ error: err.message })
      return
    }
    if (err instanceof Error) {
      // Preflight-shaped rejections (already configured, bad domain) are the
      // operator's problem to fix, not a server fault.
      log.web.warn('cloud-setup: start rejected', { error: err.message })
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/cloud-setup/job → redacted state | 404
cloudSetupRouter.get('/job', async (_req, res, next) => {
  try {
    const job = await getCloudSetupJob()
    if (!job) {
      res.status(404).json({ error: 'No cloud setup job exists' })
      return
    }
    res.json({ job: redactCloudSetupJob(job) })
  } catch (err) {
    next(err)
  }
})

// GET /api/cloud-setup/job/stream → replayable SSE progress
cloudSetupRouter.get('/job/stream', async (req, res, next) => {
  try {
    const job = await getCloudSetupJob()
    attachSse(CLOUD_SETUP_SSE_CHANNEL, req, res, {
      // Snapshot first so a late subscriber renders the checklist immediately,
      // then the ring replay brings it up to the live edge.
      onAttach: (write) => {
        if (job) write('snapshot', { job: redactCloudSetupJob(job) })
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/cloud-setup/job/input → 200 redacted | 409 when not awaiting
cloudSetupRouter.post('/job/input', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { ip?: string; credentials?: string; confirmDnsSkip?: boolean }
    const job = await provideCloudSetupInput(body)
    res.json({ job: redactCloudSetupJob(job) })
  } catch (err) {
    if (err instanceof Error) {
      const notAwaiting = /not awaiting input|No cloud setup job exists/.test(err.message)
      res.status(notAwaiting ? 409 : 400).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/cloud-setup/job/retry → 200 | 409
cloudSetupRouter.post('/job/retry', async (_req, res, next) => {
  try {
    const job = await retryCloudSetupJob()
    res.json({ job: redactCloudSetupJob(job) })
  } catch (err) {
    if (err instanceof Error) {
      res.status(409).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/cloud-setup/job/cancel → 200
cloudSetupRouter.post('/job/cancel', async (_req, res, next) => {
  try {
    const job = await cancelCloudSetupJob()
    if (!job) {
      res.status(404).json({ error: 'No cloud setup job exists' })
      return
    }
    res.json({ job: redactCloudSetupJob(job) })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/cloud-setup/job → clear a terminal record | 409 while in flight
cloudSetupRouter.delete('/job', async (_req, res, next) => {
  try {
    const deleted = await deleteCloudSetupJob()
    if (!deleted) {
      res.status(404).json({ error: 'No cloud setup job exists' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof CloudSetupJobExistsError) {
      res.status(409).json({ error: 'Cancel the running job before deleting it' })
      return
    }
    next(err)
  }
})

/**
 * GET /api/cloud-setup/user-data?provider=&domainMode=&domain= → { userData, steps }
 *
 * The manual path's copy box. This response DOES contain the pairing code — the
 * blob is exactly what the operator pastes into their VM, so redaction would
 * defeat the endpoint. It reads the code from the current job (start the job
 * first) so the value stays stable across reloads instead of minting a new one
 * per request, which would strand a box that already booted with the old code.
 */
cloudSetupRouter.get('/user-data', async (req, res, next) => {
  try {
    const providerId = typeof req.query.provider === 'string' ? req.query.provider : 'manual'
    const driver = getDriver(providerId)
    if (!driver) return badRequest(res, `Unknown provider: ${providerId}`)

    const job = await getCloudSetupJob()
    if (!job?.pairingCode) {
      res.status(409).json({ error: 'Start a setup job first — the boot script needs its pairing code.' })
      return
    }
    const domainMode = (typeof req.query.domainMode === 'string' ? req.query.domainMode : job.domainMode) as CloudSetupDomainMode
    if (!DOMAIN_MODES.includes(domainMode)) return badRequest(res, `Unknown domainMode: ${domainMode}`)
    const domain = domainMode === 'sslip'
      ? SSLIP_AUTO
      : ((typeof req.query.domain === 'string' && req.query.domain) || job.domain)
    if (!domain) return badRequest(res, 'own-domain mode requires a domain')

    // Same flavor the provision step would have used, so the blob an operator
    // copies for a Hetzner box reaches for apt rather than dnf.
    const userData = buildUserData({
      domain, pairingCode: job.pairingCode, flavor: driver.userDataFlavor ?? 'al2023',
    })
    const instructions = driver.instructions({ userData, domain, domainMode, region: job.region, instanceType: job.instanceType })
    res.json({ userData, steps: instructions.steps, consoleUrl: instructions.consoleUrl })
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})
