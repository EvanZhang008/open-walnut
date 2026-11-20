/**
 * The held-threads ledger (src/core/org/held-threads.ts): which items ever had a thread, so a thread
 * deleted a week after it closed is never opened a second time.
 *
 *   1. A live item's entry is stamped again once a day, so it outlives the 90-day expiry while
 *      the item waits; an entry nobody notes again expires.
 *   2. forgetHeld drops only what it matches, by kind, key and when written.
 *   3. A ledger Walnut cannot read is written again from the threads as they are, and later
 *      writes work again (never stuck failing forever).
 *   4. startHeldThreads runs its boot sweep with the experiment off too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-held-threads'))

// The threads the rebuild reads: one open letter thread, one set-aside choice thread, one ended.
vi.mock('../../../src/core/org/threads-store.js', () => ({
  threadTaskIds: async () => ['task-garden'],
  readThreads: async (taskId: string) => ({
    version: 1, task_id: taskId, threads: [
      { id: 'th-letter-a', title: 'Net the cherries?', state: 'needs', letter: { id: 'lt-cherries' } },
      { id: 'th-choice-b', title: 'Cedar or pine?', state: 'needs', closed: { how: 'dropped' }, choice: { board: 'task-garden', id: 'fence', options: [], off: true } },
      { id: 'th-letter-c', title: 'Done one', state: 'answered', letter: { id: 'lt-done', done: true } },
    ],
  }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { forgetHeld, heldSeen, noteHeld, startHeldThreads } from '../../../src/core/org/held-threads.js'

const file = () => path.join(WALNUT_HOME, 'org', 'held-threads.json')
const DAY = 24 * 3600_000
const readLedger = async () => JSON.parse(await fs.readFile(file(), 'utf8')) as { entries: Record<string, { kind: string; key: string; state: string; at: string }> }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.join(WALNUT_HOME, 'org'), { recursive: true })
})
afterEach(() => { vi.useRealTimers() })

describe('the held-threads ledger', () => {
  it('a live item noted again each day never expires; one left alone expires after 90 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await noteHeld('th-live', 'letter', 'lt-live', 'open')
    await noteHeld('th-left', 'letter', 'lt-left', 'open')
    const first = (await readLedger()).entries['th-live']!.at
    // The same state within a day writes nothing new.
    vi.setSystemTime(new Date('2026-01-01T06:00:00Z'))
    await noteHeld('th-live', 'letter', 'lt-live', 'open')
    expect((await readLedger()).entries['th-live']!.at).toBe(first)
    // Each sync of the live item for 100 days stamps it anew once a day.
    for (let d = 1; d <= 100; d++) {
      vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + d * DAY + 1000))
      await noteHeld('th-live', 'letter', 'lt-live', 'open')
    }
    expect(await heldSeen('th-live')).toBe('open')
    expect(await heldSeen('th-left')).toBeNull()
  })

  it('forgetHeld drops only the entries it matches', async () => {
    await noteHeld('th-1', 'letter', 'lt-1', 'open')
    await noteHeld('th-2', 'choice', 'task-garden/fence', 'off')
    const at = (await readLedger()).entries['th-1']!.at
    await forgetHeld((e) => e.kind === 'letter' && e.at <= at)
    expect(await heldSeen('th-1')).toBeNull()
    expect(await heldSeen('th-2')).toBe('off')
  })

  it('an unreadable ledger is written again from the threads, and later writes work', async () => {
    await fs.writeFile(file(), '{ "version": 1, "entries": { "th-')
    await noteHeld('th-new', 'letter', 'lt-new', 'open')
    const ledger = await readLedger()
    expect(ledger.entries['th-letter-a']).toMatchObject({ kind: 'letter', key: 'lt-cherries', state: 'open' })
    expect(ledger.entries['th-choice-b']).toMatchObject({ kind: 'choice', key: 'task-garden/fence', state: 'off' })
    expect(ledger.entries['th-letter-c']).toBeUndefined()
    expect(ledger.entries['th-new']).toMatchObject({ key: 'lt-new', state: 'open' })
    // A read of a torn file rebuilds it too.
    await fs.writeFile(file(), 'not json')
    expect(await heldSeen('th-letter-a')).toBe('open')
    expect(JSON.parse(await fs.readFile(file(), 'utf8')).entries['th-letter-a']).toBeTruthy()
  })
})

describe('startHeldThreads', () => {
  it('runs the boot sweep with the experiment off', async () => {
    const syncAll = vi.fn(async () => ({}))
    const flag = { now: () => false, on: async () => false, set: () => {} }
    const handle = startHeldThreads({ name: 'held-threads-test', flag, events: ['test:event'], onEvent: () => {}, syncAll, firstMs: 10 })
    try {
      await vi.waitFor(() => expect(syncAll).toHaveBeenCalledTimes(1), { timeout: 5000 })
    } finally {
      handle.stop()
    }
  })
})
