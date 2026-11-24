/**
 * A pull that keeps failing to land is named once (2026-11-24).
 *
 * Each failed pull logs one ordinary deferral and the next tick tries again. On 2026-11-24 the
 * pull did not land for six hours (first a merge that timed out on every tick, then a store
 * rewritten inside every pull's window), and the only loud signal was a "push rejected" spike.
 * STALLED_PULL_TICKS pulls in a row that did not land, whatever the reason, are now one error
 * naming the last reason and the files in the way of every one of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-starved-pull'))

const errors: Array<{ message: string; data: unknown }> = []
vi.mock('../../src/logging/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/logging/index.js')>()
  return {
    ...real,
    log: {
      ...real.log,
      git: { ...real.log.git, error: (message: string, data: unknown) => { errors.push({ message, data }) } },
    },
  }
})

import { notePullStalled, stalledPullsForTest, resetSyncGuardForTest } from '../../src/integrations/git-sync.js'

beforeEach(() => {
  errors.length = 0
  resetSyncGuardForTest()
})

describe('a pull that keeps failing to land', () => {
  it('ten in a row are named once, with the last reason and the files in the way of each', () => {
    for (let i = 0; i < 9; i++) notePullStalled('a store was rewritten while the pull was in flight', ['host-exec-grants.json', i % 2 ? 'a.json' : 'b.json'])
    expect(errors).toEqual([])
    notePullStalled('a store was rewritten while the pull was in flight', ['host-exec-grants.json', 'org/team-notes.json'])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/has not landed for many ticks/)
    expect(errors[0].data).toMatchObject({
      pullsNotLanded: 10, lastReason: 'a store was rewritten while the pull was in flight', filesInTheWay: ['host-exec-grants.json'], recoveryKey: 'git',
    })
    for (let i = 0; i < 20; i++) notePullStalled('a store was rewritten while the pull was in flight', ['host-exec-grants.json'])
    expect(errors).toHaveLength(1)
    expect(stalledPullsForTest().ticks).toBe(30)
  })

  it('a merge that times out on every tick counts the same, with no files', () => {
    for (let i = 0; i < 10; i++) notePullStalled('the merge could not be computed: git timed out after 30000ms')
    expect(errors).toHaveLength(1)
    expect(errors[0].data).toMatchObject({ lastReason: 'the merge could not be computed: git timed out after 30000ms', filesInTheWay: [] })
  })

  it('a pull that lands ends the streak, and the next streak is named again', () => {
    for (let i = 0; i < 9; i++) notePullStalled('the apply deferred: busy')
    resetSyncGuardForTest()
    for (let i = 0; i < 9; i++) notePullStalled('the apply deferred: busy')
    expect(errors).toEqual([])
    notePullStalled('the apply deferred: busy')
    expect(errors).toHaveLength(1)
  })
})
