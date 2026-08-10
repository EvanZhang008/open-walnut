/**
 * /api/cloud-setup routes.
 *
 * The load-bearing assertion here is negative: EVERY response body is deep-
 * scanned for the live pairing-code value, which must never appear. The one
 * legitimate exception is GET /user-data — that blob IS the paste target, so it
 * is asserted to CONTAIN the code exactly once, in the token-file write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-setup-routes'))

let cloudRemote: { domain: string; token: string; secure: boolean } | null = null
vi.mock('../../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentials: () => cloudRemote,
  initSync: (url?: string) => {
    if (!url) return
    const parsed = new URL(url)
    cloudRemote = { domain: parsed.host, token: parsed.password, secure: parsed.protocol === 'https:' }
  },
  sync: async () => ({ pulled: 0, pushed: 0, conflicts: 0 }),
  gitSafeAsync: async () => 'ref\tHEAD',
}))

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { cloudSetupRouter } from '../../../src/web/routes/cloud-setup.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import {
  _resetCloudSetupJobForTesting,
  cancelCloudSetupJob,
  getCloudSetupJob,
} from '../../../src/core/cloud-setup/job.js'
import { _setCloudProviderDriverForTesting } from '../../../src/core/cloud-setup/providers/index.js'
import type { CloudProviderDriver } from '../../../src/core/cloud-setup/providers/types.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/cloud-setup', cloudSetupRouter)
  app.use(errorHandler)
  return app
}

/** A driver that never returns from createVM, so the job parks mid-provision. */
const stalledDriver: CloudProviderDriver = {
  id: 'aws',
  label: 'Stalled Test Driver',
  costHint: 'free',
  detectCreds: async () => ({ available: true, detail: 'ok', needs: 'nothing' }),
  createVM: () => new Promise(() => { /* never settles — the job stays running */ }),
  instructions: ({ userData }) => ({ steps: ['step one'], userData }),
}

const manualTestDriver: CloudProviderDriver = {
  id: 'manual',
  label: 'Manual Test Driver',
  costHint: 'free',
  detectCreds: async () => ({ available: true, detail: 'no credentials needed', needs: 'nothing' }),
  instructions: ({ userData }) => ({ steps: ['create a VM', 'paste this'], userData, consoleUrl: 'https://example.test' }),
}

/**
 * Stand-in for a driver whose real detectCreds shells out to a vendor CLI. The
 * azure and gcp drivers do exactly that, and GET /providers probes EVERY
 * registered driver — so without this, running this file on a machine that has
 * `az` or `gcloud` installed would make real CLI calls and take their latency.
 */
function cliGatedTestDriver(id: string, label: string): CloudProviderDriver {
  return {
    id: id as CloudProviderDriver['id'],
    label,
    costHint: '~$9/mo',
    detectCreds: async () => ({
      available: false,
      detail: `Install the ${label} CLI, or use the manual path.`,
      needs: 'cli-login',
    }),
    createVM: () => new Promise(() => { /* never settles */ }),
    instructions: ({ userData }) => ({ steps: ['step one'], userData }),
  }
}

const restores: Array<() => void> = []

/** Every string in a JSON tree, so a code can't hide in a nested field. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) allStrings(v, out)
  return out
}

/** The code is minted by the async `generate` step, so poll briefly for it. */
async function currentPairingCode(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const code = (await getCloudSetupJob())?.pairingCode
    if (code) return code
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`expected the job to hold a pairing code; state = ${JSON.stringify(await getCloudSetupJob())}`)
}

/** Wait until the job parks on operator input (manual driver). */
async function waitAwaitingInput(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await getCloudSetupJob())?.status === 'awaiting-input') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`job never reached awaiting-input; state = ${JSON.stringify(await getCloudSetupJob())}`)
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetCloudSetupJobForTesting()
  cloudRemote = null
  restores.push(_setCloudProviderDriverForTesting('aws', stalledDriver))
  restores.push(_setCloudProviderDriverForTesting('manual', manualTestDriver))
  restores.push(_setCloudProviderDriverForTesting('azure', cliGatedTestDriver('azure', 'Azure')))
  restores.push(_setCloudProviderDriverForTesting('gcp', cliGatedTestDriver('gcp', 'Google Cloud')))
})

afterEach(async () => {
  await cancelCloudSetupJob().catch(() => {})
  _resetCloudSetupJobForTesting()
  while (restores.length) restores.pop()?.()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /providers', () => {
  it('lists registered drivers with a credential probe result', async () => {
    const res = await request(createApp()).get('/api/cloud-setup/providers')
    expect(res.status).toBe(200)
    const ids = res.body.providers.map((p: { id: string }) => p.id)
    expect(ids).toContain('aws')
    expect(ids).toContain('manual')
    const manual = res.body.providers.find((p: { id: string }) => p.id === 'manual')
    expect(manual.detect.available).toBe(true)
    expect(manual.canProvision).toBe(false)
    expect(res.body.providers.find((p: { id: string }) => p.id === 'aws').canProvision).toBe(true)
  })

  it('offers hetzner as a one-click provider that needs a token', async () => {
    // The wizard derives two things from this payload: the "Needs API token"
    // pill, and whether to show the token field at all (canProvision +
    // needs==='api-token'). A driver that reported needs:'cli-login' would
    // leave the operator with no field to type into.
    const res = await request(createApp()).get('/api/cloud-setup/providers')
    const hetzner = res.body.providers.find((p: { id: string }) => p.id === 'hetzner')
    expect(hetzner).toBeDefined()
    expect(hetzner.canProvision).toBe(true)
    expect(hetzner.detect.needs).toBe('api-token')
    expect(hetzner.costHint).toMatch(/€/)
  })

  it('offers azure and gcp as one-click providers gated on a CLI login, not a token', async () => {
    // These two provision through the operator's own az/gcloud login, so the
    // wizard must NOT show a token field for them (that is keyed on
    // needs==='api-token'); needs:'cli-login' paints "CLI missing or signed out"
    // and the operator falls back to the manual paste path.
    const res = await request(createApp()).get('/api/cloud-setup/providers');
    for (const id of ['azure', 'gcp']) {
      const provider = res.body.providers.find((p: { id: string }) => p.id === id)
      expect(provider, id).toBeDefined()
      expect(provider.canProvision, id).toBe(true)
      expect(provider.detect.needs, id).toBe('cli-login')
    }
  })

  it('reports a throwing probe as unavailable instead of failing the request', async () => {
    restores.push(_setCloudProviderDriverForTesting('aws', {
      ...stalledDriver,
      detectCreds: async () => { throw new Error('CLI exploded') },
    }))
    const res = await request(createApp()).get('/api/cloud-setup/providers')
    expect(res.status).toBe(200)
    const aws = res.body.providers.find((p: { id: string }) => p.id === 'aws')
    expect(aws.detect.available).toBe(false)
    // The internal error text must not be echoed to the client verbatim.
    expect(JSON.stringify(res.body)).not.toContain('CLI exploded')
  })
})

describe('POST /start', () => {
  it('202s with a redacted job, and a second start 409s', async () => {
    const app = createApp()
    const first = await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    expect(first.status).toBe(202)
    expect(first.body.job.status).toBe('running')
    expect(first.body.job.pairingCode).toBeUndefined()

    const second = await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already in progress/)
  })

  it('force replaces an in-flight job', async () => {
    const app = createApp()
    const first = await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    const forced = await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com', force: true })
    expect(forced.status).toBe(202)
    expect(forced.body.job.id).not.toBe(first.body.job.id)
  })

  it('400s on a bad provider, bad domainMode, or a missing domain', async () => {
    const app = createApp()
    expect((await request(app).post('/api/cloud-setup/start').send({ provider: 'nope', domainMode: 'sslip' })).status).toBe(400)
    expect((await request(app).post('/api/cloud-setup/start').send({ provider: 'manual', domainMode: 'nope' })).status).toBe(400)
    const noDomain = await request(app).post('/api/cloud-setup/start').send({ provider: 'manual', domainMode: 'own-domain' })
    expect(noDomain.status).toBe(400)
    expect(noDomain.body.error).toMatch(/requires a domain/)
  })
})

describe('GET /job', () => {
  it('404s with no job, then returns the redacted state', async () => {
    const app = createApp()
    expect((await request(app).get('/api/cloud-setup/job')).status).toBe(404)
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    const res = await request(app).get('/api/cloud-setup/job')
    expect(res.status).toBe(200)
    expect(res.body.job.provider).toBe('aws')
    expect(res.body.job.domain).toBe('wn.example.com')
    expect(res.body.job.pairingCode).toBeUndefined()
  })
})

describe('pairing-code containment (deep scan of every response)', () => {
  it('no response body anywhere contains the live pairing code', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    const code = await currentPairingCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)

    const responses = [
      await request(app).get('/api/cloud-setup/providers'),
      await request(app).get('/api/cloud-setup/job'),
      await request(app).post('/api/cloud-setup/start')
        .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' }), // 409
      await request(app).post('/api/cloud-setup/job/input').send({ ip: '203.0.113.9' }),
      await request(app).post('/api/cloud-setup/job/retry'),
      await request(app).post('/api/cloud-setup/job/cancel'),
      await request(app).get('/api/cloud-setup/job'),
      await request(app).delete('/api/cloud-setup/job'),
    ]
    for (const res of responses) {
      // Raw text too, in case a field is serialized outside the JSON tree.
      expect(res.text ?? '', `${res.req.method} ${res.req.path}`).not.toContain(code)
      for (const s of allStrings(res.body)) expect(s).not.toContain(code)
      expect(allStrings(res.body).some((s) => s.includes('pairingCode'))).toBe(false)
    }
  })

  it('the persisted state file holds the code but no response exposes it', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    const code = await currentPairingCode()
    // On disk (it must survive a restart) …
    const onDisk = await fs.readFile(path.join(WALNUT_HOME, 'cloud-setup-job.json'), 'utf-8')
    expect(onDisk).toContain(code)
    // … but not over the wire.
    const res = await request(app).get('/api/cloud-setup/job')
    expect(res.text).not.toContain(code)
  })
})

describe('POST /job/input', () => {
  it('409s when the job is not awaiting input', async () => {
    const app = createApp()
    // The stalled aws driver keeps the job 'running', never awaiting.
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    const res = await request(app).post('/api/cloud-setup/job/input').send({ ip: '203.0.113.9' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/not awaiting input/)
  })

  it('409s when no job exists at all', async () => {
    const res = await request(createApp()).post('/api/cloud-setup/job/input').send({ ip: '203.0.113.9' })
    expect(res.status).toBe(409)
  })

  it('400s on a malformed IP for an awaiting job', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    await waitAwaitingInput()
    const res = await request(app).post('/api/cloud-setup/job/input').send({ ip: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/valid IPv4/)
  })
})

describe('retry / cancel / delete', () => {
  it('retry 409s while the job is running', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    const res = await request(app).post('/api/cloud-setup/job/retry')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already running/)
  })

  it('cancel then delete clears the record; delete 409s while in flight', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'aws', domainMode: 'own-domain', domain: 'wn.example.com' })
    expect((await request(app).delete('/api/cloud-setup/job')).status).toBe(409)

    const cancelled = await request(app).post('/api/cloud-setup/job/cancel')
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.job.status).toBe('cancelled')

    expect((await request(app).delete('/api/cloud-setup/job')).status).toBe(200)
    expect((await request(app).get('/api/cloud-setup/job')).status).toBe(404)
    expect((await request(app).delete('/api/cloud-setup/job')).status).toBe(404)
  })

  it('cancel 404s with no job', async () => {
    expect((await request(createApp()).post('/api/cloud-setup/job/cancel')).status).toBe(404)
  })
})

describe('GET /user-data', () => {
  it('409s before a job exists (the code must be the job\'s, not a fresh one)', async () => {
    const res = await request(createApp()).get('/api/cloud-setup/user-data?provider=manual')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Start a setup job first/)
  })

  it('returns the paste blob + steps, containing the code exactly once', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    const code = await currentPairingCode()

    const res = await request(app).get('/api/cloud-setup/user-data?provider=manual')
    expect(res.status).toBe(200)
    expect(res.body.steps.length).toBeGreaterThan(0)
    expect(res.body.consoleUrl).toBe('https://example.test')
    // Deliberate: this blob IS what the operator pastes into the VM.
    const hits = (res.body.userData as string).split('\n').filter((l) => l.includes(code))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('/etc/walnut/setup-token')
    expect(res.body.userData).toContain("DOMAIN='wn.example.com'")
  })

  it('is stable across calls (never mints a new code per request)', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    const a = await request(app).get('/api/cloud-setup/user-data?provider=manual')
    const b = await request(app).get('/api/cloud-setup/user-data?provider=manual')
    expect(a.body.userData).toBe(b.body.userData)
  })

  it('sslip mode emits the resolver block instead of a literal domain', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start').send({ provider: 'manual', domainMode: 'sslip' })
    await currentPairingCode()
    const res = await request(app).get('/api/cloud-setup/user-data?provider=manual&domainMode=sslip')
    expect(res.status).toBe(200)
    expect(res.body.userData).toContain('.sslip.io')
    expect(res.body.userData).toContain('169.254.169.254')
  })

  it('400s on an unknown provider', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start').send({ provider: 'manual', domainMode: 'sslip' })
    await currentPairingCode()
    expect((await request(app).get('/api/cloud-setup/user-data?provider=nope')).status).toBe(400)
  })

  it('builds the blob for the PROVIDER\'S image family, not always AL2023', async () => {
    // The paste blob has to match the box the operator is about to boot: a
    // Hetzner server is Ubuntu, so a dnf-first script would try the wrong
    // package manager first on every one of them.
    const app = createApp()
    await request(app).post('/api/cloud-setup/start').send({ provider: 'manual', domainMode: 'sslip' })
    await currentPairingCode()

    const hetzner = await request(app).get('/api/cloud-setup/user-data?provider=hetzner&domainMode=sslip')
    expect(hetzner.status).toBe(200)
    const h = hetzner.body.userData as string
    expect(h.indexOf('apt-get install -y git')).toBeLessThan(h.indexOf('dnf install -y git'))

    const manual = await request(app).get('/api/cloud-setup/user-data?provider=manual&domainMode=sslip')
    const m = manual.body.userData as string
    expect(m.indexOf('dnf install -y git')).toBeLessThan(m.indexOf('apt-get install -y git'))
  })

  it('400s on a shell-unsafe domain override', async () => {
    const app = createApp()
    await request(app).post('/api/cloud-setup/start')
      .send({ provider: 'manual', domainMode: 'own-domain', domain: 'wn.example.com' })
    await currentPairingCode()
    const res = await request(app)
      .get(`/api/cloud-setup/user-data?provider=manual&domain=${encodeURIComponent("evil.test'; id; '")}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid domain/)
  })
})
