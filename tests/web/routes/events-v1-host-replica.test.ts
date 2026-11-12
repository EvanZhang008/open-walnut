/**
 * The phone feed's bridge push is the leader's alone (events-v1.ts). A host replica
 * used to be kept off it only because it happens to have no `__local__` daemon link;
 * with one (or a daemon link registered under that name), it pushed `mobile-event`
 * frames to the companion as if it were the Mac. Now any replica refuses itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
const send = vi.fn(async () => ({ ok: true }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => ({ hasCapability: () => true, send }),
}))

const { forwardMobileEventToBridge } = await import('../../../src/web/routes/events-v1.js')

afterEach(() => {
  delete process.env.WALNUT_HOST_SERVER
  send.mockClear()
})

describe('mobile-event bridge push on a host replica', () => {
  it('the leader pushes a frame down its local daemon link', async () => {
    expect(await forwardMobileEventToBridge('task-upsert', { id: 't1' })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe('mobile-event')
  })

  it('a host replica pushes nothing, even with a daemon link that takes the frame', async () => {
    process.env.WALNUT_HOST_SERVER = '1'
    expect(await forwardMobileEventToBridge('task-upsert', { id: 't1' })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
