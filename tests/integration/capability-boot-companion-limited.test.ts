/**
 * A companion that set WALNUT_CAPABILITIES=public-door for itself (stage 5 of
 * docs/plan/walnut-companion-unified-replica.md): only that capability's jobs
 * run, the other three are off at their doors and jobs, and what the companion
 * still runs on its own pipeline (the `companionUntil` rows) is untouched.
 * Pins that each gate reads its capability, not CLOUD_MODE: with the constant
 * true, a gate still keyed on it would open here.
 *
 * Same boot as capability-boot-companion.test.ts, the variable set before it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { recordLogs, statusOf, upgradeAnswer } from '../helpers/capability-boot.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-caps-boot-companion-limited', { CLOUD_MODE: true }))
vi.mock('../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => ({ enabled: false }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { getCanaryHandle, startServer, stopServer } from '../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../src/core/device-auth.js'
import { getBackupLeader } from '../../src/core/leader/backup-leader.js'
import { jobsOfCapability } from '../../src/core/boot-policy.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE = crypto.randomBytes(16).toString('hex')
const logs = recordLogs(log as never, ['web', 'leader', 'cron'])
const savedCaps = process.env.WALNUT_CAPABILITIES

beforeAll(async () => {
  process.env.WALNUT_CAPABILITIES = 'public-door'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'marina-phone', id: 'd00000000000000a1', tokenHash: sha(PHONE), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha(crypto.randomBytes(16).toString('hex')), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  if (savedCaps === undefined) delete process.env.WALNUT_CAPABILITIES
  else process.env.WALNUT_CAPABILITIES = savedCaps
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the companion with WALNUT_CAPABILITIES=public-door', () => {
  it('the role and boot policy lines name only it; the other capabilities\' rows are off, its own pipeline rows on', () => {
    expect(logs.data('server role')).toMatchObject({ role: 'replica', placement: 'cloud', capabilities: ['public-door'] })
    const boot = logs.data('boot policy') as { on: string[]; off: string[]; capabilities: string[] }
    expect(boot.capabilities).toEqual(['public-door'])
    expect(boot.on).toEqual(expect.arrayContaining(jobsOfCapability('public-door')))
    for (const cap of ['bridge-door', 'cloud-exec', 'backup-leader'] as const) expect(boot.off, cap).toEqual(expect.arrayContaining(jobsOfCapability(cap)))
    expect(boot.on).toEqual(expect.arrayContaining(['v1-forward', 'companion-stream-forward', 'companion-queues', 'plugins', 'git-pull', 'notes-indexer']))
  })

  it('public-door: the setup token check ran', () => {
    expect(logs.has('cloud mode: instance already claimed (device tokens active)')).toBe(true)
  })

  it('no bridge-door: the /bridge/* routes are not mounted and the upgrades are dropped', async () => {
    expect(await statusOf(port, 'POST', '/bridge/replica')).toBe(404)
    expect(await statusOf(port, 'POST', '/bridge/journal')).toBe(404)
    expect(await upgradeAnswer(port, '/bridge')).toBe('closed')
    expect(await upgradeAnswer(port, '/bridge', PHONE)).toBe('closed')
    expect(await upgradeAnswer(port, '/daemon-tunnel')).toBe('closed')
  })

  it('no cloud-exec: no exec read, no local daemon, no stream cleanup, no canary', () => {
    expect(logs.has('cloud mode: no cloud-exec capability, no local session daemon')).toBe(true)
    expect(logs.has('cloud mode: session execution disabled')).toBe(false)
    expect(logs.has('cloud mode: skipping local session daemon startup')).toBe(false)
    expect(logs.has('startup: stream file cleanup done')).toBe(false)
    expect(getCanaryHandle()).toBeNull()
  })

  it('no backup-leader: no takeover loop, no instance, no cron; the plugins still load (5b decides them)', async () => {
    // Cron logs its start a moment after the boot line when it runs; give it that moment.
    await new Promise((r) => setTimeout(r, 2_000))
    expect(logs.has('backup leader: watching the primary')).toBe(false)
    expect(await getBackupLeader()).toBeNull()
    expect(logs.has('cron started')).toBe(false)
    expect(logs.has('integration plugins loaded')).toBe(true)
  })
})
