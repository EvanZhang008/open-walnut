/**
 * git-sync: a merge git refuses because a STORE moved during the fetch window is
 * a clock problem, not a content one (2026-10-01: three "NON-conflict" cards,
 * each followed by a push rejection that the bundle fallback then forced,
 * dropping the other box's commit). The classifier below is what keeps that
 * refusal out of the remote-wins fallback and off the error feed.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-git-sync-dirty-refusal'))

import { isDirtyTreeRefusal, dirtyFilesInRefusal } from '../../src/integrations/git-sync.js'

const MERGE_REFUSAL = [
  'error: Your local changes to the following files would be overwritten by merge:',
  '\tnotifications.json',
  '\tsessions/projection.json',
  'Please commit your changes or stash them before you merge.',
  'Aborting',
].join('\n')

describe('isDirtyTreeRefusal', () => {
  it('recognises the merge and rebase refusals for a tree that changed under git', () => {
    expect(isDirtyTreeRefusal(`git exited 2: ${MERGE_REFUSAL}`)).toBe(true)
    expect(isDirtyTreeRefusal('error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.')).toBe(true)
    expect(isDirtyTreeRefusal('error: Your local changes to the following files would be overwritten by checkout:\n\tx.json')).toBe(true)
  })

  it('leaves the refusals that DO need the loud fallback alone', () => {
    expect(isDirtyTreeRefusal('fatal: refusing to merge unrelated histories')).toBe(false)
    expect(isDirtyTreeRefusal("fatal: Unable to create '.git/index.lock': File exists.")).toBe(false)
    expect(isDirtyTreeRefusal('CONFLICT (content): Merge conflict in tasks.json')).toBe(false)
    expect(isDirtyTreeRefusal('')).toBe(false)
  })
})

describe('dirtyFilesInRefusal', () => {
  it('lists the indented paths and skips git\'s advice lines', () => {
    expect(dirtyFilesInRefusal(MERGE_REFUSAL)).toEqual(['notifications.json', 'sessions/projection.json'])
  })

  it('is empty when the message names no file', () => {
    expect(dirtyFilesInRefusal('error: cannot rebase: You have unstaged changes.')).toEqual([])
  })
})
