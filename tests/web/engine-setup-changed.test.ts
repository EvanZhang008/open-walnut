/**
 * An install that ended makes every picker read the host again at once
 * (web/src/hooks/useHostEngineAvailability.ts engineSetupChanged). 2026-11-25: after
 * "Install Antigravity" the picker kept reading "Not installed here" for up to a minute,
 * its own cache of the host's answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiGet = vi.fn()
const refreshEngineCatalog = vi.fn()
vi.mock('../../web/src/api/client', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))
vi.mock('../../web/src/hooks/useEngineCatalog', () => ({ refreshEngineCatalog: () => refreshEngineCatalog() }))
vi.mock('../../web/src/utils/log', () => ({ log: { warn: vi.fn(), info: vi.fn() } }))

const mod = await import('../../web/src/hooks/useHostEngineAvailability')

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('engineSetupChanged', () => {
  beforeEach(() => { apiGet.mockReset(); refreshEngineCatalog.mockReset() })

  it('this machine: the engine catalog is read again', () => {
    mod.engineSetupChanged('__local__')
    mod.engineSetupChanged(undefined)
    expect(refreshEngineCatalog).toHaveBeenCalledTimes(2)
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('another host: its cached answer is dropped and read again, inside the minute', async () => {
    apiGet.mockResolvedValueOnce({ engines: { antigravity: { installed: false, version: null, reason: 'agy is not installed' } } })
    expect(mod.getHostEngineAvailability('devbox')).toBeNull()
    await flush()
    expect(mod.getHostEngineAvailability('devbox')?.antigravity?.installed).toBe(false)
    // Within the minute a plain read serves the cache and asks nothing.
    expect(apiGet).toHaveBeenCalledTimes(1)

    apiGet.mockResolvedValueOnce({ engines: { antigravity: { installed: true, version: '1.5.17', reason: null } } })
    mod.engineSetupChanged('devbox')
    expect(mod.getHostEngineAvailability('devbox')).toBeNull()
    await flush()
    expect(mod.getHostEngineAvailability('devbox')?.antigravity?.installed).toBe(true)
    expect(refreshEngineCatalog).not.toHaveBeenCalled()
  })
})
