/**
 * What his words typed on a Board choice's thread answer (src/core/boards/choice-follow-up.ts
 * choiceWordsPick), by the letter's guards (human-inbox/answer-approval.ts): a bare yes picks the
 * recommended option only, short words pick the one option they name, other words are his note,
 * and anything else stays a follow-up.
 */
import { describe, expect, it } from 'vitest'
import { choiceWordsPick } from '../../../src/core/boards/choice-follow-up.js'

const options = [{ value: 'now', label: 'This week' }, { value: 'later', label: 'Next week' }]

describe('choiceWordsPick', () => {
  it('a bare yes picks the recommended option, and nothing when none is recommended', () => {
    expect(choiceWordsPick('K', { options, recommended: 'later' })).toEqual({ option: 'later' })
    expect(choiceWordsPick('ok', { options, recommended: 'now' })).toEqual({ option: 'now' })
    expect(choiceWordsPick('yes', { options })).toBeNull()
  })

  it('words that name one option pick it; words naming both pick nothing', () => {
    expect(choiceWordsPick('This week', { options })).toEqual({ option: 'now' })
    expect(choiceWordsPick('later', { options })).toEqual({ option: 'later' })
    expect(choiceWordsPick('week', { options })).toBeNull()
  })

  it('other words are his note; empty or one stray letter stays a follow-up', () => {
    expect(choiceWordsPick('Wait until the frost is over', { options })).toEqual({ text: 'Wait until the frost is over' })
    expect(choiceWordsPick('   ', { options })).toBeNull()
    expect(choiceWordsPick('q', { options })).toBeNull()
  })
})
