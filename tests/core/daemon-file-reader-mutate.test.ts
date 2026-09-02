/**
 * DaemonFileReader's mutation family: the capability gate and the per-call RPC
 * timeout.
 *
 * Two rules pinned here, both learned from answers that could not help the user:
 *
 * 1. UNKNOWN capabilities is not a MISSING capability. `_capabilities` is null
 *    until `hello` is answered (and stays null if that handshake failed), and the
 *    gate used to read that as "this daemon can't change files" → HTTP 501 "the
 *    daemon needs an upgrade, it upgrades itself on your next session message".
 *    That is advice no amount of following can fix, because nothing was out of
 *    date. Unknown now means "assume capable and let the RPC decide" — the same
 *    posture daemon-connection.ts takes for its other capability checks. A daemon
 *    that genuinely predates the family answers "unknown command", which the HTTP
 *    edge maps to daemon_needs_upgrade for real.
 *
 * 2. A recursive delete/copy gets a caller-supplied timeout. conn.send's 30s
 *    default rejected mid-delete, the route mapped that to 502 "could not
 *    complete on the remote host", and the daemon went on to finish deleting —
 *    the user was told it failed AND lost the folder.
 */

import { describe, it, expect, vi } from 'vitest'

const { sendMock, connState } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  connState: { capabilitiesKnown: false as boolean, caps: [] as string[] },
}))

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({
    send: sendMock,
    get capabilitiesKnown() { return connState.capabilitiesKnown },
    hasCapability: (c: string) => connState.caps.includes(c),
  }),
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { marina: { hostname: 'host.example.com', user: 'u' } } }),
}))

const { DaemonFileReader } = await import('../../src/core/daemon-file-reader.js')

describe('mutateConnection capability gate', () => {
  it('proceeds when capabilities are UNKNOWN and lets the RPC report the truth', async () => {
    connState.capabilitiesKnown = false
    connState.caps = []
    sendMock.mockResolvedValue({ ok: false, error: 'unknown command: fs.rm' })
    const reader = new DaemonFileReader('marina')
    // The failure the user sees comes from the daemon itself, not from a guess.
    await expect(reader.removePath('/a/b/c', true)).rejects.toThrow(/unknown command/)
    expect(sendMock).toHaveBeenCalledWith('fs.rm', { path: '/a/b/c', recursive: true }, undefined)
  })

  it('still refuses a daemon KNOWN to lack fs-mutate-v1', async () => {
    connState.capabilitiesKnown = true
    connState.caps = ['snapshot-v1']
    const reader = new DaemonFileReader('marina')
    await expect(reader.removePath('/a/b/c', true)).rejects.toThrow(/needs an upgrade/)
  })
})

describe('per-call RPC timeout for the unbounded ops', () => {
  it('threads the caller timeout into conn.send for a copy', async () => {
    connState.capabilitiesKnown = true
    connState.caps = ['fs-mutate-v1']
    sendMock.mockResolvedValue({ ok: true })
    await new DaemonFileReader('marina').copyPath('/a/b', '/a/c', 600_000)
    expect(sendMock).toHaveBeenCalledWith('fs.copy', { from: '/a/b', to: '/a/c' }, 600_000)
  })

  it('threads it for a delete too, and omits it when the caller does not care', async () => {
    connState.capabilitiesKnown = true
    connState.caps = ['fs-mutate-v1']
    sendMock.mockResolvedValue({ ok: true })
    const reader = new DaemonFileReader('marina')
    await reader.removePath('/a/b/c', true, 600_000)
    expect(sendMock).toHaveBeenLastCalledWith('fs.rm', { path: '/a/b/c', recursive: true }, 600_000)
    await reader.removePath('/a/b/d', false)
    // undefined → conn.send falls back to its own default, unchanged behaviour.
    expect(sendMock).toHaveBeenLastCalledWith('fs.rm', { path: '/a/b/d', recursive: false }, undefined)
  })
})
