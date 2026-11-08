import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'

const mocks = vi.hoisted(() => ({ run: vi.fn(), prewarm: vi.fn() }))
vi.mock('../../src/constants.js', () => createMockConstants('demo-oneshot', { IS_DEMO: true }))
vi.mock('../../src/providers/oneshot-core.js', () => ({
  createOneShotCore: () => ({ run: mocks.run, prewarm: mocks.prewarm, disposeAll: vi.fn() }),
}))
import { _setOneShotDaemonForTest, prewarmOneShot, startOneShot, type OneShotConn } from '../../src/providers/oneshot-client.js'
import { closeDemoAdmission, resetDemoAdmissionForTests } from '../../src/core/sessions/demo-admission.js'

const spec = { command: '/fixture/claude', args: ['-p'], env: {} }
const listener = { onExit: vi.fn() }
function conn(reply: Record<string, unknown> | Error): OneShotConn {
  return { connected: true, connectionEpoch: 1, hasCapability: () => true,
    send: vi.fn(async () => { if (reply instanceof Error) throw reply; return reply }),
  }
}
beforeEach(() => { resetDemoAdmissionForTests(); vi.clearAllMocks() })
afterEach(() => { resetDemoAdmissionForTests(); _setOneShotDaemonForTest(null) })

describe('Demo one-shot work stays in its owned daemon', () => {
  it.each(['missing', 'refused', 'disconnected', 'oversized'])('refuses local fallback when %s', async reason => {
    const daemon = reason === 'refused' ? conn({ ok: false, error: 'stopping' })
      : reason === 'disconnected' ? conn(markLinkFailure(new Error('no link'), 'no-link'))
      : reason === 'oversized' ? conn({ ok: true }) : null
    _setOneShotDaemonForTest(() => daemon)
    await expect(startOneShot({ ...spec, ...(reason === 'oversized' ? { input: 'x'.repeat(9 * 1024 * 1024) } : {}) }, listener)).rejects.toThrow(/own daemon/)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.prewarm).not.toHaveBeenCalled()
    if (reason === 'oversized') expect(daemon!.send).not.toHaveBeenCalled()
  })

  it('rechecks admission after resolving the daemon link', async () => {
    const daemon = conn({ ok: true })
    _setOneShotDaemonForTest(async () => { closeDemoAdmission(); return daemon })
    await expect(startOneShot(spec, listener)).rejects.toThrow(/stopping/)
    expect(daemon.send).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('never starts a server warm child without its daemon', () => {
    _setOneShotDaemonForTest(() => null)
    prewarmOneShot({ ...spec, warmKey: 'fixture' })
    expect(mocks.prewarm).not.toHaveBeenCalled()
  })

  it('never prewarms after the link resolves into a closed Demo', async () => {
    const daemon = conn({ ok: true })
    _setOneShotDaemonForTest(async () => { closeDemoAdmission(); return daemon })
    prewarmOneShot({ ...spec, warmKey: 'fixture' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(daemon.send).not.toHaveBeenCalled()
    expect(mocks.prewarm).not.toHaveBeenCalled()
  })
})
