/**
 * The companion as it boots today (WALNUT_CLOUD_MODE=1 and nothing else): it has
 * all four capabilities (src/core/capabilities.ts), and each one's jobs and
 * doors are on (stage 5 of docs/plan/walnut-companion-unified-replica.md):
 *
 *   public-door    the setup token banner's check ran (the box is claimed)
 *   bridge-door    /bridge/replica and /bridge/journal ask for the Mac's
 *                  credential (401), the /bridge and /daemon-tunnel upgrades too
 *   cloud-exec     the cloud.exec read ran, the local daemon is skipped only for
 *                  cloud.exec.enabled false, stream cleanup ran, the canary runs
 *   backup-leader  the takeover loop watches the primary; cron started
 *
 * A real startServer in this process, a temp home, auth.json written fresh.
 * capability-boot-companion-limited.test.ts takes capabilities away;
 * capability-boot-mac.test.ts and capability-boot-host.test.ts are the other two kinds.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { recordLogs, statusOf, upgradeAnswer } from '../helpers/capability-boot.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-caps-boot-companion', { CLOUD_MODE: true }))
vi.mock('../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => ({ enabled: false }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { getCanaryHandle, startServer, stopServer } from '../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../src/core/device-auth.js'
import { getBackupLeader } from '../../src/core/leader/backup-leader.js'
import { CAPABILITIES } from '../../src/core/capabilities.js'
import { jobsOfCapability } from '../../src/core/boot-policy.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE = crypto.randomBytes(16).toString('hex')
const logs = recordLogs(log as never, ['web', 'leader', 'cron'])
const savedCaps = process.env.WALNUT_CAPABILITIES

beforeAll(async () => {
  delete process.env.WALNUT_CAPABILITIES
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

describe('the companion with no WALNUT_CAPABILITIES has all four', () => {
  it('the role and boot policy lines name them, and every capability row is on', () => {
    expect(logs.data('server role')).toMatchObject({ role: 'replica', placement: 'cloud', capabilities: [...CAPABILITIES] })
    const boot = logs.data('boot policy') as { on: string[]; capabilities: string[] }
    expect(boot.capabilities).toEqual([...CAPABILITIES])
    for (const cap of CAPABILITIES) expect(boot.on, cap).toEqual(expect.arrayContaining(jobsOfCapability(cap)))
    expect(logs.lines.some((l) => l.msg.startsWith('WALNUT_CAPABILITIES is ignored'))).toBe(false)
  })

  it('public-door: the setup token check ran', () => {
    expect(logs.has('cloud mode: instance already claimed (device tokens active)')).toBe(true)
  })

  it('bridge-door: the /bridge/* routes are mounted and ask for the Mac\'s credential', async () => {
    expect(await statusOf(port, 'POST', '/bridge/replica')).toBe(401)
    expect(await statusOf(port, 'POST', '/bridge/journal')).toBe(401)
  })

  it('bridge-door: the /bridge and /daemon-tunnel upgrades are answered (401 without a machine token)', async () => {
    expect(await upgradeAnswer(port, '/bridge')).toMatch(/^HTTP\/1\.1 401/)
    expect(await upgradeAnswer(port, '/bridge', PHONE)).toMatch(/^HTTP\/1\.1 401/)
    expect(await upgradeAnswer(port, '/daemon-tunnel')).toMatch(/^HTTP\/1\.1 40[13]/)
  })

  it('cloud-exec: the cloud.exec read ran, the daemon waits on cloud.exec.enabled, cleanup ran, the canary runs', () => {
    expect(logs.has('cloud mode: session execution disabled')).toBe(true)
    expect(logs.has('cloud mode: skipping local session daemon startup')).toBe(true)
    expect(logs.has('cloud mode: no cloud-exec capability, no local session daemon')).toBe(false)
    expect(logs.has('startup: stream file cleanup done')).toBe(true)
    expect(getCanaryHandle()).not.toBeNull()
  })

  it('backup-leader: the takeover loop watches the primary, and cron started', async () => {
    expect(logs.has('backup leader: watching the primary')).toBe(true)
    expect(await getBackupLeader()).not.toBeNull()
    await vi.waitFor(() => expect(logs.has('cron started')).toBe(true), { timeout: 15_000 })
  })
})
