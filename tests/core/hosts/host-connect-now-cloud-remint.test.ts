/**
 * A person's Retry on the Cloud row lifts the machine credential re-mint
 * window (integrations/cloud-bridge-config.ts allowNextRemint): the window
 * paces AUTOMATIC redials only, and a dead token is already dropped, so a
 * Retry that could not mint would leave the card with nothing to do.
 *
 * The REAL pool and connectHostNow run, as in host-connect-now-reconnect.test.ts;
 * reconnect() is stubbed (it would dial), and allowNextRemint is observed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/providers/ssh-credential-evidence.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/ssh-credential-evidence.js')>()),
  annotateCredentialFailure: async (err: unknown) => err,
}))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({
    hosts: {
      __cloudbox__: { hostname: 'companion.example.com', label: 'Cloud', cloud_box: true },
      devbox: { hostname: 'devbox.example.com', user: 'alice', label: 'Dev box' },
    },
  }),
}))
const allow = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  allowNextRemint: (host: string) => { allow.calls.push(host) },
}))

const dc = await import('../../../src/providers/daemon-connection.js')
const { connectHostNow } = await import('../../../src/core/hosts/host-connect-action.js')
const { clearReconnectCause } = await import('../../../src/providers/daemon-reconnect-cause.js')

type Internals = { _disconnectedSince: number | null; scheduleReconnect: (d: number) => void }
// The targets getConfig names: a pooled connection with another target is a
// different machine, so connectHostNow would replace it with a new one and dial.
const TARGETS = {
  __cloudbox__: { hostname: 'companion.example.com' },
  devbox: { hostname: 'devbox.example.com', user: 'alice' },
} as const
const HOSTS = Object.keys(TARGETS) as Array<keyof typeof TARGETS>
const reconnects: Record<string, ReturnType<typeof vi.fn>> = {}

beforeEach(async () => {
  vi.useFakeTimers()
  allow.calls = []
  for (const host of HOSTS) {
    const conn = new dc.DaemonConnection(host, TARGETS[host])
    dc.setPooledConnectionForTest(host, conn)
    ;(conn as unknown as Internals)._disconnectedSince = Date.now()
    conn.setPhaseForTest('reconnecting')
    reconnects[host] = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => { throw new Error('Cloud companion tunnel failed: HTTP 401') }) as never) as never
    vi.spyOn(conn, 'connect').mockImplementation(async () => { throw new Error('connect() must not run: it would dial for real') })
    ;(conn as unknown as Internals).scheduleReconnect(60_000)
  }
})

afterEach(() => {
  for (const host of HOSTS) {
    dc.cancelReconnectBackoff(host)
    dc.clearDaemonFailureCache(host)
    dc.setPooledConnectionForTest(host, null)
    clearReconnectCause(host)
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Retry on the Cloud row', () => {
  it('lets the next machine credential mint run now', async () => {
    const r = await connectHostNow('__cloudbox__')
    expect(r.httpStatus).toBe(200)
    expect(allow.calls).toEqual(['__local__'])
    // The loop's (stubbed) attempt ran: nothing was replaced, nothing dialled.
    expect(reconnects.__cloudbox__).toHaveBeenCalledTimes(1)
  })

  it('an SSH host\'s Retry leaves the Cloud credential window alone', async () => {
    const r = await connectHostNow('devbox')
    expect(r.httpStatus).toBe(200)
    expect(allow.calls).toEqual([])
    expect(reconnects.devbox).toHaveBeenCalledTimes(1)
  })
})
