/**
 * list-dirs is never the thing that dials a host this server should not reach:
 * C23 (an ephemeral test server answers kind 'ephemeral' with no connection),
 * C25 (a replica relays server.list-dirs to the primary), a disabled or
 * unknown host is a 404 with no dial, and C37 (the host_key hint from this path
 * names the non-default port). The daemon connection and the relay are spies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const flags = { ephemeral: false, cloud: false }
vi.mock('../../../src/constants.js', () => {
  const base = createMockConstants() as Record<string, unknown>
  return { ...base, get IS_EPHEMERAL() { return flags.ephemeral }, get CLOUD_MODE() { return flags.cloud } }
})

const dial = vi.fn(async () => { throw new Error('Host key verification failed.') })
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.com', user: 'alice', label: 'Dev box', port: 2222 },
      offbox: { hostname: 'off.example.com', label: 'Off box', enabled: false },
    },
  }),
}))
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDaemonConnection: dial,
  getDaemonConnectState: () => ({ host: 'devbox', connected: false, phase: 'failed', phaseElapsedMs: 0, connectElapsedMs: 0 }),
}))
const relay = vi.fn(async () => ({ ok: true, result: { dirs: ['/home/alice/work'], parent: '/home/alice/', exists: true } }))
vi.mock('../../../src/web/routes/v1-control-relay.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callPrimaryControl: relay,
}))

const { listSessionDirs } = await import('../../../src/core/sessions/session-extras.js')

beforeEach(() => { flags.ephemeral = false; flags.cloud = false; dial.mockClear(); relay.mockClear() })

describe('list-dirs never dials what it must not', () => {
  it('C23: on an ephemeral test server the answer is kind ephemeral, with no connection at all', async () => {
    flags.ephemeral = true
    const r = await listSessionDirs('/home/alice/', 'devbox', 2, { pending: true })
    expect(r.hostError).toMatchObject({ kind: 'ephemeral', retryable: false })
    expect(dial).not.toHaveBeenCalled()
  })

  it('C25: a replica relays server.list-dirs to the primary and never dials', async () => {
    flags.cloud = true
    const r = await listSessionDirs('/home/alice/', 'devbox', 2, { pending: true, waitMs: 500 })
    expect(r.dirs).toEqual(['/home/alice/work'])
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay.mock.calls[0][0]).toBe('server.list-dirs')
    expect(relay.mock.calls[0][2]).toMatchObject({ host: 'devbox', prefix: '/home/alice/', pending: true, waitMs: 500 })
    expect(dial).not.toHaveBeenCalled()
  })

  it('a disabled or unknown host is a 404 without dialling', async () => {
    await expect(listSessionDirs('/', 'offbox', 2, { pending: true })).rejects.toMatchObject({ statusCode: 404, message: 'unknown host' })
    await expect(listSessionDirs('/', 'nosuch', 2, { pending: true })).rejects.toMatchObject({ statusCode: 404 })
    expect(dial).not.toHaveBeenCalled()
  })

  it("C37: the host_key hint from list-dirs names '[host]:port' for a non-default port", async () => {
    const r = await listSessionDirs('/home/alice/', 'devbox', 2, { pending: true })
    expect(dial).toHaveBeenCalledTimes(1)
    expect(r.hostError?.kind).toBe('host_key')
    expect(r.hostError?.hint).toContain("'[devbox.example.com]:2222'")
    expect(r.hostError?.retryable).toBe(false)
  })
})
