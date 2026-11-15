import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants())
import type { Server } from 'node:http'
import { startServer, stopServer } from '../../src/web/server.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'

let server: Server
let base: string
beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no TCP address')
  base = `http://127.0.0.1:${address.port}`
}, 60_000)
afterAll(async () => { vi.restoreAllMocks(); await stopServer() })

const feed = async (): Promise<Array<{ title: string; body?: string; detail?: string }>> => {
  const response = await fetch(`${base}/api/notifications`)
  expect(response.ok).toBe(true)
  return (await response.json()).feed
}

describe('managed daemon update notices through a real server', () => {
  it('a service scope that cannot be updated keeps serving without creating an error notification', async () => {
    const conn = new DaemonConnection('notice-fixture', { hostname: 'fixture.invalid', user: 'tester' })
    const internals = conn as unknown as {
      getExpectedDaemonVersion(): string | null
      sshExec(command: string, timeout?: number): Promise<string>
      shouldUpgradeDaemon(file: string, service: { managed: boolean; present: string[]; unknown: string[] }): Promise<boolean>
    }
    vi.spyOn(internals, 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-notice-new')
    // Only SSH is replaced: the service verdict, update decision, logger and notification store are real.
    vi.spyOn(internals, 'sshExec').mockImplementation(async (command) => command.includes('daemon.version') ? 'walnut-daemon-notice-old' : '')
    const errors = vi.spyOn(log.session, 'error')
    const prior = await feed()
    try {
      for (let n = 0; n < 3; n++) {
        expect(await internals.shouldUpgradeDaemon('/fixture/daemon', {
          managed: true, present: ['/tmp/open-walnut/daemon.service'], unknown: [],
        })).toBe(false)
      }
      expect(errors).not.toHaveBeenCalled()
      expect((await feed()).filter((row) => /"host":"notice-fixture"|managed daemon update not available/.test(`${row.title} ${row.body} ${row.detail}`))).toEqual([])
      expect((await feed()).length).toBeGreaterThanOrEqual(prior.length)
    } finally { conn.disconnect(); errors.mockRestore() }
  })

  it('an older producer using the legacy title remains quiet while a real failure is still reported', async () => {
    for (const title of [
      'DaemonConnection: managed daemon update was deferred; use `walnut daemon install --yes --executable <daemon binary>` on that host.',
      'Managed local daemon version differs; automatic update was deferred; use walnut daemon install --yes --executable <daemon binary>',
    ]) log.session.error(title, { host: 'legacy-notice-fixture', expected: 'new', remoteVersion: 'old' })
    log.session.error('Managed daemon update failed: the service could not start', { host: 'real-failure-fixture' })
    await vi.waitFor(async () => {
      expect((await feed()).some((entry) => entry.detail?.includes('real-failure-fixture'))).toBe(true)
    })
    expect((await feed()).some((entry) => entry.detail?.includes('legacy-notice-fixture'))).toBe(false)
  })
})
