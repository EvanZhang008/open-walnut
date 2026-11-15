/** Existing sessions resolve the host alias again after a transport change, never stale SSH. */
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ link: vi.fn() }))
vi.mock('../../src/core/hosts/link.js', () => ({ link: state.link }))
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
afterEach(() => vi.resetAllMocks())

describe('a running session follows its host transport', () => {
  it('uses the current joined link on every reconnect instead of the constructor SSH target', async () => {
    const mgr = new RemoteSessionManager('sid-host-move', 'devbox', { hostname: 'old.example.test', user: 'runner' })
    const oldLink = { connected: true, kind: 'ssh' }
    const joinedLink = { connected: true, kind: 'net' }
    state.link.mockResolvedValueOnce(oldLink).mockResolvedValueOnce(joinedLink)
    const connect = (mgr as unknown as { ensureConnected(): Promise<unknown> }).ensureConnected.bind(mgr)
    await expect(connect()).resolves.toBe(oldLink)
    await expect(connect()).resolves.toBe(joinedLink)
    expect(state.link.mock.calls).toEqual([['devbox'], ['devbox']])
  })

  it('does not fall back to the captured SSH target if the current link is unavailable', async () => {
    const mgr = new RemoteSessionManager('sid-host-down', 'devbox', { hostname: 'old.example.test' })
    state.link.mockRejectedValue(new Error('host network unavailable'))
    await expect((mgr as unknown as { ensureConnected(): Promise<unknown> }).ensureConnected()).rejects.toThrow('host network unavailable')
    expect(state.link).toHaveBeenCalledOnce()
  })
})
