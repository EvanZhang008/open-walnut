/**
 * The Mac (the leader) has no capability (src/core/capabilities.ts, stage 5 of
 * docs/plan/walnut-companion-unified-replica.md): its `leader` column decides
 * every boot row, and a WALNUT_CAPABILITIES it inherited is ignored with a
 * warning, never applied. So none of the companion's doors opens here: no
 * /bridge/* routes, no /bridge or /daemon-tunnel upgrade, no takeover loop, no
 * canary, no setup token check.
 *
 * A real startServer in this process, a temp home; the variable is set to two
 * capabilities before the boot to prove it changes nothing.
 */
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { recordLogs, statusOf, upgradeAnswer } from '../helpers/capability-boot.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-caps-boot-mac'))

import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { getCanaryHandle, startServer, stopServer } from '../../src/web/server.js'
import { getBackupLeader } from '../../src/core/leader/backup-leader.js'
import { BOOT_POLICY, type BootRow } from '../../src/core/boot-policy.js'

let server: HttpServer
let port = 0
const logs = recordLogs(log as never, ['web', 'leader'])
const savedCaps = process.env.WALNUT_CAPABILITIES

beforeAll(async () => {
  process.env.WALNUT_CAPABILITIES = 'bridge-door,backup-leader'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
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

describe('the Mac boots with no capability', () => {
  it('the role and boot policy lines say none, the inherited value is reported as ignored, and the leader column decides', () => {
    expect(logs.data('server role')).toMatchObject({ role: 'leader', placement: 'mac', capabilities: [] })
    const boot = logs.data('boot policy') as { on: string[]; capabilities: string[] }
    expect(boot.capabilities).toEqual([])
    expect([...boot.on].sort()).toEqual((BOOT_POLICY as readonly BootRow[]).filter((r) => r.leader).map((r) => r.job).sort())
    expect(logs.data('WALNUT_CAPABILITIES is ignored here: only the companion reads it')).toMatchObject({ value: 'bridge-door,backup-leader', placement: 'mac' })
  })

  it('no bridge door: no /bridge/* route, the /bridge and /daemon-tunnel upgrades are dropped', async () => {
    expect(await statusOf(port, 'POST', '/bridge/replica')).toBe(404)
    expect(await statusOf(port, 'POST', '/bridge/journal')).toBe(404)
    expect(await upgradeAnswer(port, '/bridge')).toBe('closed')
    expect(await upgradeAnswer(port, '/daemon-tunnel')).toBe('closed')
  })

  it('no companion jobs: no setup token check, no takeover loop, no canary', async () => {
    expect(logs.has('cloud mode: instance already claimed (device tokens active)')).toBe(false)
    expect(logs.has('backup leader: watching the primary')).toBe(false)
    expect(await getBackupLeader()).toBeNull()
    expect(getCanaryHandle()).toBeNull()
  })
})
