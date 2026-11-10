import { describe, it, expect, beforeEach } from 'vitest'
import { _resetFollowUpIntents, followUpIntentFor, noteFollowUpIntent } from '../../../src/core/org/thread-follow-up-intent.js'

describe('a Follow up announced before the companion relays its words', () => {
  beforeEach(() => _resetFollowUpIntents())

  it('names its thread for that node and message, and again for a retry', () => {
    noteFollowUpIntent('lead-1', 'th-aaa', 'qm-1', 1_000)
    expect(followUpIntentFor('lead-1', 'qm-1', 2_000)).toBe('th-aaa')
    expect(followUpIntentFor('lead-1', 'qm-1', 3_000)).toBe('th-aaa')
  })

  it('names nothing for another node, another message, or after an hour', () => {
    noteFollowUpIntent('lead-1', 'th-aaa', 'qm-1', 0)
    expect(followUpIntentFor('lead-2', 'qm-1', 1)).toBeUndefined()
    expect(followUpIntentFor('lead-1', 'qm-2', 1)).toBeUndefined()
    expect(followUpIntentFor(undefined, 'qm-1', 1)).toBeUndefined()
    expect(followUpIntentFor('lead-1', 'qm-1', 60 * 60_000 + 1)).toBeUndefined()
  })

  it('a later announcement of the same message wins, and the store stays bounded', () => {
    noteFollowUpIntent('lead-1', 'th-aaa', 'qm-1', 0)
    noteFollowUpIntent('lead-1', 'th-bbb', 'qm-1', 5)
    expect(followUpIntentFor('lead-1', 'qm-1', 6)).toBe('th-bbb')
    for (let i = 0; i < 2100; i++) noteFollowUpIntent('lead-1', 'th-ccc', `qm-n${i}`, 10)
    expect(followUpIntentFor('lead-1', 'qm-n0', 11)).toBeUndefined()
    expect(followUpIntentFor('lead-1', 'qm-n2099', 11)).toBe('th-ccc')
  })
})
