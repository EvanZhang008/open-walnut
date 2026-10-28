import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeExitOnOrphanRequest, watchForOrphan } from '../../src/lib/exit-on-orphan.js'

afterEach(() => { vi.useRealTimers() })

describe('OPEN_WALNUT_EXIT_ON_ORPHAN (the Mac app)', () => {
  it('the request is read once and leaves the environment, so no child inherits it', () => {
    const env: NodeJS.ProcessEnv = { OPEN_WALNUT_EXIT_ON_ORPHAN: '1', PATH: '/bin' }
    expect(takeExitOnOrphanRequest(env, () => 4242)).toBe(4242)
    expect(env).toEqual({ PATH: '/bin' })
    expect(takeExitOnOrphanRequest(env, () => 4242)).toBeNull()
    expect(takeExitOnOrphanRequest({ OPEN_WALNUT_EXIT_ON_ORPHAN: '0' }, () => 4242)).toBeNull()
  })

  it('runs once when the parent pid changes (the app died, launchd took the process)', () => {
    vi.useFakeTimers()
    let ppid = 4242
    const onOrphan = vi.fn()
    expect(watchForOrphan(4242, onOrphan, { ppid: () => ppid, everyMs: 100 })).not.toBeNull()
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
    watchForOrphan(4242, onOrphan, { ppid: () => ppid, everyMs: 100 })
    ppid = 900
    vi.advanceTimersByTime(100)
    expect(onOrphan).toHaveBeenCalledTimes(1)
  })

  it('an app that died during startup, before the watch armed, stops it at once', () => {
    const gone = vi.fn()
    expect(watchForOrphan(4242, gone, { ppid: () => 1 })).toBeNull()
    expect(gone).toHaveBeenCalledTimes(1)
    // Asked for, and launchd's at the first look: the app is gone already.
    const early = vi.fn()
    expect(watchForOrphan(1, early, { ppid: () => 1 })).toBeNull()
    expect(early).toHaveBeenCalledTimes(1)
  })

  it('not asked: nothing is watched', () => {
    const onOrphan = vi.fn()
    expect(watchForOrphan(null, onOrphan, { ppid: () => 1 })).toBeNull()
    expect(onOrphan).not.toHaveBeenCalled()
  })
})
