/**
 * The Board choice that waits on the user for one task (src/core/boards/open-choice.ts), found
 * by the rule the task's status counts by: any Board, unanswered, naming the task by id or an
 * unambiguous prefix, or the owner's own when it names none. Real files in an isolated home.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-open-choice'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { setBoardHtml } from '../../../src/core/boards/board-store.js'
import { setBoardChoice } from '../../../src/core/boards/board-items.js'
import { openChoiceFor, resolveChoiceRef } from '../../../src/core/boards/open-choice.js'

const LEAD = 'mvlead00-0001'
const WORK = 'mvwork11-0002'
const OTHER = 'mvwork22-0003'
const IDS = [LEAD, WORK, OTHER]

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('resolveChoiceRef', () => {
  it('takes an id or an unambiguous prefix of 4+ characters', () => {
    expect(resolveChoiceRef(WORK, IDS)).toBe(WORK)
    expect(resolveChoiceRef('mvwork1', IDS)).toBe(WORK)
    expect(resolveChoiceRef('mvwork', IDS)).toBeUndefined() // two tasks
    expect(resolveChoiceRef('mvw', IDS)).toBeUndefined() // too short
    expect(resolveChoiceRef('nope', IDS)).toBeUndefined()
  })
})

describe('openChoiceFor', () => {
  it('finds a lead\'s choice about a project task, with its options, and nothing once it is answered', async () => {
    await setBoardHtml(LEAD, [
      '<h1>Marina</h1>',
      `<walnut-choice id="plan" task="${WORK.slice(0, 7)}" title="Which plan?" options="a:Plan A,b:Plan B,c:Plan C" recommended="b"></walnut-choice>`,
      '<walnut-choice id="own" title="Ship this week?" options="yes:Yes,no:No"></walnut-choice>',
    ].join('\n'), { by: 'human' })
    expect(await openChoiceFor(WORK, IDS)).toEqual({
      owner: LEAD, id: 'plan', title: 'Which plan?', recommended: 'b',
      options: [{ value: 'a', label: 'Plan A' }, { value: 'b', label: 'Plan B' }, { value: 'c', label: 'Plan C' }],
    })
    // A choice naming no task is its Board owner's.
    expect((await openChoiceFor(LEAD, IDS))?.id).toBe('own')
    expect(await openChoiceFor(OTHER, IDS)).toBeNull()
    await setBoardChoice(LEAD, 'plan', { option: 'a' })
    expect(await openChoiceFor(WORK, IDS)).toBeNull()
  })

  it('answers null when there is no Board at all', async () => {
    expect(await openChoiceFor(WORK, IDS)).toBeNull()
  })
})
