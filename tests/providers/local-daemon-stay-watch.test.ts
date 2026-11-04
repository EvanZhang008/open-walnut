/**
 * The probation of a daemon this server started to replace another one (local-daemon-replace.ts
 * StayWatch). 2026-11-04 review 5: it was 30 s on a monotonic clock, in memory only, and looked
 * once at its end, so a build that died later was kept (and took the one slot of the build before
 * it on a Mac), and a server restarted inside the window adopted it unwatched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STAY_CHECK_EVERY_MS, STAY_MS, StayWatch, type StayStore } from '../../src/providers/local-daemon-replace.js'
import { STAY_SETTLE_SLACK_MS } from '../../src/providers/local-daemon-stay.js'
import type { StayRecord } from '../../src/providers/daemon-update-store.js'

afterEach(() => { vi.useRealTimers() })

/** A store as daemon-update-store.ts keeps it, in memory. */
function memoryStore(): StayStore & { entry: StayRecord | null } {
  const s = {
    entry: null as StayRecord | null,
    read: async () => (s.entry ? { ...s.entry } : null),
    write: async (e: StayRecord | null) => { s.entry = e ? { ...e } : null },
  }
  return s
}

describe('the probation of a new local daemon', () => {
  it('lasts a quarter of an hour on the wall clock, not the 30 s it was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    expect(STAY_MS).toBeGreaterThanOrEqual(10 * 60_000)
    const watch = new StayWatch()
    const due = vi.fn()
    watch.start('new-version', 4242, due)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(watch.settle(() => true)).toBeNull()
    expect(watch.watching('new-version')).toBe(true)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(due).toHaveBeenCalled()
    expect(watch.settle(() => true)).toBeNull()
    expect(watch.watching('new-version')).toBe(false)
  })

  it('a daemon gone in the middle of it is seen at the next look, not at its end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    let alive = true
    const watch = new StayWatch(STAY_MS, () => Date.now(), { alive: () => alive })
    const due = vi.fn()
    watch.start('new-version', 4242, due)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(due).not.toHaveBeenCalled()
    alive = false
    await vi.advanceTimersByTimeAsync(STAY_CHECK_EVERY_MS + 100)
    expect(due).toHaveBeenCalledWith('new-version')
    expect(watch.settle(() => alive)).toMatchObject({ expected: 'new-version', reason: expect.stringMatching(/^it stopped within 1[23]\d s after it started on the real dir$/) })
  })

  it('is kept on disk: a server restarted inside it judges the same daemon', async () => {
    const store = memoryStore()
    const first = new StayWatch(STAY_MS, () => Date.now(), { store, alive: () => true })
    first.start('new-version', 4242, () => {})
    await vi.waitFor(() => expect(store.entry).toMatchObject({ expected: 'new-version', pid: 4242 }))
    first.clear()
    // clear() of a watch that ended forgets it on disk too; the restart lost the first one in memory only.
    store.entry = { expected: 'new-version', pid: 4242, at: Date.now() - 60_000, bootAt: Date.now() - 3_600_000 }
    const restarted = new StayWatch(STAY_MS, () => Date.now(), { store, alive: () => false, bootAt: () => Date.now() - 3_600_000 })
    const due = vi.fn()
    await restarted.resume(due)
    expect(restarted.watching('new-version')).toBe(true)
    expect(restarted.settle(() => false)).toMatchObject({ expected: 'new-version', reason: expect.stringMatching(/^it stopped within 6\d s/) })
    await vi.waitFor(() => expect(store.entry).toBeNull())
  })

  // 2026-11-04 review 6: the record of the same boot was taken however old, and a daemon gone by
  // then was refused for a day, though it may have died hours after its window. Review 7: ending the
  // watch there instead left its next start unwatched, so a build that kept dying was never refused.
  it('a daemon found gone only well past its window (no server looked at its end) is watched anew from its next start', async () => {
    const store = memoryStore()
    const boot = Date.now() - 86_400_000
    store.entry = { expected: 'new-version', pid: 4242, at: Date.now() - STAY_MS - STAY_SETTLE_SLACK_MS - 3 * 3600_000, bootAt: boot }
    const due = vi.fn()
    const gone = new StayWatch(STAY_MS, () => Date.now(), { store, alive: (pid) => pid === 5151, bootAt: () => boot })
    await gone.resume(due)
    expect(gone.settle((pid) => pid === 5151)).toBeNull()
    expect(gone.passed('new-version')).toBe(false)
    // Over again from now, its pid not known: the next start names it, and that one is judged.
    expect(gone.watching('new-version')).toBe(true)
    expect(gone.leftMs('new-version')).toBeGreaterThan(STAY_MS - 5_000)
    await vi.waitFor(() => expect(store.entry).toMatchObject({ expected: 'new-version', pid: null }))
    gone.claim('new-version', 6161)
    expect(gone.settle((pid) => pid === 5151)).toMatchObject({ expected: 'new-version', reason: expect.stringMatching(/^it stopped within \d+ s/) })
    // Alive then: it stayed through its window.
    store.entry = { expected: 'new-version', pid: 4242, at: Date.now() - 3 * 3600_000, bootAt: boot }
    const alive = new StayWatch(STAY_MS, () => Date.now(), { store, alive: () => true, bootAt: () => boot })
    await alive.resume(() => {})
    expect(alive.settle(() => true)).toBeNull()
    expect(alive.passed('new-version')).toBe(true)
    // Gone right at its end (within the slack): the last look in its window may have been the one before.
    store.entry = { expected: 'new-version', pid: 4242, at: Date.now() - STAY_MS - 5_000, bootAt: boot }
    const atEnd = new StayWatch(STAY_MS, () => Date.now(), { store, alive: () => false, bootAt: () => boot })
    await atEnd.resume(() => {})
    expect(atEnd.settle(() => false)).toMatchObject({ expected: 'new-version' })
    expect(atEnd.passed('new-version')).toBe(false)
  })

  it('a window that ends with no daemon of its build named (none started after a reboot) passes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const watch = new StayWatch(STAY_MS, () => Date.now(), { alive: () => true })
    watch.start('new-version', null, () => {})
    await vi.advanceTimersByTimeAsync(STAY_MS + 1_000)
    expect(watch.settle(() => true)).toBeNull()
    expect(watch.watching('new-version')).toBe(false)
    expect(watch.passed('new-version')).toBe(false)
  })

  it('a reboot since is no failure: the probation starts over, and the daemon started after it is the one watched', async () => {
    const store = memoryStore()
    store.entry = { expected: 'new-version', pid: 4242, at: Date.now() - 60_000, bootAt: Date.now() - 86_400_000 }
    const watch = new StayWatch(STAY_MS, () => Date.now(), { store, alive: (pid) => pid === 5151, bootAt: () => Date.now() - 300_000 })
    await watch.resume(() => {})
    expect(watch.watching('new-version')).toBe(true)
    // The pid of before the boot is not judged.
    expect(watch.settle(() => false)).toBeNull()
    expect(watch.leftMs('new-version')).toBeGreaterThan(STAY_MS - 5_000)
    watch.claim('new-version', 5151)
    await vi.waitFor(() => expect(store.entry).toMatchObject({ pid: 5151 }))
    expect(watch.settle((pid) => pid === 5151)).toBeNull()
    expect(watch.watching('new-version')).toBe(true)
    watch.clear()
  })
})
