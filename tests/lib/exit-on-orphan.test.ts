import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchForOrphan } from '../../src/lib/exit-on-orphan.js'

afterEach(() => { vi.useRealTimers() })

describe('watchForOrphan (OPEN_WALNUT_EXIT_ON_ORPHAN, the Mac app)', () => {
  const asked = { OPEN_WALNUT_EXIT_ON_ORPHAN: '1' }

  it('runs once when the parent pid changes (the app died, launchd took the process)', () => {
    vi.useFakeTimers()
    let ppid = 4242
    const onOrphan = vi.fn()
    const timer = watchForOrphan(onOrphan, { env: asked, ppid: () => ppid, everyMs: 100 })
    expect(timer).not.toBeNull()
    vi.advanceTimersByTime(500)
    expect(onOrphan).not.toHaveBeenCalled()
    ppid = 1
    vi.advanceTimersByTime(100)
    expect(onOrphan).toHaveBeenCalledTimes(1)
    ppid = 7
    vi.advanceTimersByTime(1_000)
    expect(onOrphan).toHaveBeenCalledTimes(1)
  })

  it('a subreaper that takes the process counts too', () => {
    vi.useFakeTimers()
    let ppid = 4242
    const onOrphan = vi.fn()
    watchForOrphan(onOrphan, { env: asked, ppid: () => ppid, everyMs: 100 })
    ppid = 900
    vi.advanceTimersByTime(100)
    expect(onOrphan).toHaveBeenCalledTimes(1)
  })

  it('does nothing unless asked, or when it is launchd\'s already', () => {
    expect(watchForOrphan(vi.fn(), { env: {}, ppid: () => 4242 })).toBeNull()
    expect(watchForOrphan(vi.fn(), { env: { OPEN_WALNUT_EXIT_ON_ORPHAN: '0' }, ppid: () => 4242 })).toBeNull()
    expect(watchForOrphan(vi.fn(), { env: asked, ppid: () => 1 })).toBeNull()
    expect(watchForOrphan(vi.fn(), { env: asked, ppid: () => 0 })).toBeNull()
  })
})
