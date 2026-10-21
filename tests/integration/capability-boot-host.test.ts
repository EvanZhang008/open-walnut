/**
 * A host replica (`walnut web --replica`) has no capability (src/core/capabilities.ts,
 * stage 5 of docs/plan/walnut-companion-unified-replica.md): the boot policy's
 * `replica` column alone decides it (the tunnel's proxy trust and its own
 * credentialed calls), and a WALNUT_CAPABILITIES that reached its env is
 * ignored with a warning. So no companion door or job opens here.
 *
 * The real startServer boots as a host replica in this process (the env a host
 * daemon gives it, tests/helpers/replica-host-env.ts), with every capability
 * named in the variable.
 */
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'
import { recordLogs, statusOf, upgradeAnswer } from '../helpers/capability-boot.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-caps-boot-host'))

import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { _resetServerRoleForTesting, isHostReplica } from '../../src/core/server-role.js'
import { getBackupLeader } from '../../src/core/leader/backup-leader.js'

let env: HostReplicaEnv | null = null
let port = 0
let stop: (() => Promise<void>) | null = null
let canary: (() => unknown) | null = null
const logs = recordLogs(log as never, ['web', 'leader'])
const savedCaps = process.env.WALNUT_CAPABILITIES
const ALL = 'public-door,bridge-door,cloud-exec,backup-leader'

beforeAll(async () => {
  env = useHostReplicaEnv(WALNUT_HOME)
  process.env.WALNUT_CAPABILITIES = ALL
  _resetServerRoleForTesting()
  expect(isHostReplica()).toBe(true)
  const server = await import('../../src/web/server.js')
  const http = await server.startServer({ port: 0, dev: true })
  stop = server.stopServer
  canary = server.getCanaryHandle
  port = (http.address() as AddressInfo).port
}, 120_000)

afterAll(async () => {
  try { await stop?.() } catch { /* already down */ }
  vi.restoreAllMocks()
  env?.restore()
  _resetServerRoleForTesting()
  if (savedCaps === undefined) delete process.env.WALNUT_CAPABILITIES
  else process.env.WALNUT_CAPABILITIES = savedCaps
}, 60_000)

describe('a host replica boots with no capability', () => {
  it('the role and boot policy lines say none, the value is reported as ignored, and only the replica column is on', () => {
    expect(logs.data('server role')).toMatchObject({ role: 'replica', placement: 'host', capabilities: [] })
    const boot = logs.data('boot policy') as { on: string[]; capabilities: string[] }
    expect(boot.capabilities).toEqual([])
    expect([...boot.on].sort()).toEqual(['self-api-credential', 'trust-proxy'])
    expect(logs.data('WALNUT_CAPABILITIES is ignored here: only the companion reads it')).toMatchObject({ value: ALL, placement: 'host' })
  })

  it('no bridge door on its public port: /bridge/* answers 404, the upgrades are dropped', async () => {
    expect(await statusOf(port, 'POST', '/bridge/replica')).toBe(404)
    expect(await statusOf(port, 'POST', '/bridge/journal')).toBe(404)
    expect(await upgradeAnswer(port, '/bridge')).toBe('closed')
    expect(await upgradeAnswer(port, '/daemon-tunnel')).toBe('closed')
  })

  it('no companion jobs: no local daemon, no setup token check, no takeover loop, no canary', async () => {
    expect(logs.has('host replica: no local session daemon (it never starts or reaches one)')).toBe(true)
    expect(logs.lines.some((l) => l.msg.startsWith('cloud mode'))).toBe(false)
    expect(logs.has('backup leader: watching the primary')).toBe(false)
    expect(await getBackupLeader()).toBeNull()
    expect(canary?.()).toBeNull()
  })
})
