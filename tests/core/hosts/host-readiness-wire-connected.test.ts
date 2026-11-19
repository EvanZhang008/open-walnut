/**
 * wireHostReadiness probes a host whose link came up BEFORE it was wired.
 *
 * The readiness probe (and with it the automatic fixes) used to run only on a handshake edge seen
 * after wiring. When another caller dialled the host first, the edge fired before the listener
 * existed and the host was never probed: no `host preflight` line, no fix, nothing logged (the
 * remote-host onboarding CI job: the host reconnected 0.4 s after its links were dropped, while
 * the test was still waiting to wire readiness, and its own connect then took the pool's fast path).
 *
 * Only the daemon connection is faked; it sits in the real pool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-readiness-wire-connected'))

import { clearHostReadiness, getHostReadiness, wireHostReadiness } from '../../../src/core/hosts/host-readiness.js'
import { setPooledConnectionForTest } from '../../../src/providers/daemon-connection.js'

const NPM_NO_NODE = {
  ok: true,
  claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'npm', needsNode: true, nodeFound: false, error: 'needs node' },
  compiler: { found: false },
  dtach: { found: true, path: '/home/dev/.local/bin/walnut-dtach' },
  platform: 'linux', arch: 'x64',
}

function pooled(host: string, connected: boolean) {
  const send = vi.fn(async (_cmd: string) => NPM_NO_NODE as { ok: boolean })
  const conn = { host, connected, connectionEpoch: 1, connectPhaseSince: Date.now(), hasCapability: (c: string) => c === 'preflight-v1', send, fenceFileChanges: () => {} }
  setPooledConnectionForTest(host, conn as never)
  return conn
}

/** An onConnected that never fires: every handshake in these cases came before the wiring. */
const noEdges = () => () => {}

let pooledHosts: string[] = []
beforeEach(() => { clearHostReadiness(); pooledHosts = [] })
afterEach(() => { for (const h of pooledHosts) setPooledConnectionForTest(h, null); clearHostReadiness() })

describe('wireHostReadiness: hosts connected before the wiring', () => {
  it('probes a known host whose link is already up, with no handshake edge after the wiring', async () => {
    const conn = pooled('devbox', true)
    pooledHosts.push('devbox')
    const emit = vi.fn()
    const off = wireHostReadiness({ onConnected: noEdges, isKnownHost: (h) => h === 'devbox', emit, sessionUse: false })
    try {
      await vi.waitFor(() => expect(getHostReadiness('devbox')?.problems.map((p) => p.kind)).toContain('claude_needs_node'))
      expect(conn.send.mock.calls.map((c) => c[0])).toEqual(['host.preflight'])
      expect(emit).toHaveBeenCalledWith('devbox')
    } finally { off() }
  })

  it('leaves alone a pooled host that is down or not configured, and still probes on a later edge', async () => {
    const up = pooled('devbox', true)
    const down = pooled('down-box', false)
    const stranger = pooled('stranger', true)
    pooledHosts.push('devbox', 'down-box', 'stranger')
    let fire: ((host: string) => void) | null = null
    const off = wireHostReadiness({
      onConnected: (cb) => { fire = cb; return () => { fire = null } },
      isKnownHost: (h) => h === 'devbox' || h === 'down-box', emit: vi.fn(), sessionUse: false,
    })
    try {
      // One pass over the pool probes every host it keeps: devbox's probe proves the pass ran.
      await vi.waitFor(() => expect(up.send).toHaveBeenCalledWith('host.preflight', expect.anything(), expect.any(Number)))
      expect(stranger.send).not.toHaveBeenCalled()
      expect(down.send).not.toHaveBeenCalled()
      // It comes up later: its handshake edge probes it, as before.
      down.connected = true
      fire!('down-box')
      await vi.waitFor(() => expect(getHostReadiness('down-box')?.problems.map((p) => p.kind)).toContain('claude_needs_node'))
      expect(stranger.send).not.toHaveBeenCalled()
    } finally { off() }
  })

  it('probes nothing once unwired before the listing answers', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const listed = vi.fn(async () => { await gate; return ['devbox'] })
    const refresh = vi.fn(async () => null)
    const off = wireHostReadiness({ onConnected: noEdges, isKnownHost: (h) => h === 'devbox', emit: vi.fn(), refresh, connectedNow: listed, sessionUse: false })
    await vi.waitFor(() => expect(listed).toHaveBeenCalledTimes(1))
    off()
    open()
    // Every microtask of the listing settles before the next macrotask.
    await new Promise<void>((r) => setImmediate(r))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('with a refresh seam, the hosts connectedNow lists are probed through it, never the pool', async () => {
    const conn = pooled('devbox', true)
    pooledHosts.push('devbox')
    const refresh = vi.fn(async () => null)
    const off = wireHostReadiness({ onConnected: noEdges, isKnownHost: (h) => h === 'devbox', emit: vi.fn(), refresh, connectedNow: () => ['devbox'], sessionUse: false })
    try {
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith('devbox'))
      expect(conn.send).not.toHaveBeenCalled()
    } finally { off() }
  })
})
