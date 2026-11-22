/**
 * Guard: the proof of a result goes where the user reads the result, never only in a letter,
 * and a reference to a letter is a link to it (2026-11-02, the user, after thread summaries
 * said "video in the letter": "the link shoudl be here, why it is in the letter, update the
 * wlanut isntruction etc, the way to verify shoudl be here, or u cna give me a link to the
 * letter"). Fails when a place an agent reads the rule loses it. A thread op carries it only when
 * the prompt of a role that keeps Threads does not (since 2026-11-22: thread-rule-places.ts).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { PROOF_IN_PLACE_RULE } from '../../../src/core/org/thread-rules.js'
import { AWAY_INBOX_LINE, THREADS_LINE } from '../../../src/core/sessions/session-context.js'
import { getOp } from '../../../src/ops/index.js'
import { opsWhereRuleIsUnread } from './thread-rule-places.js'

describe('the proof-in-place rule', () => {
  it('says the proof goes in the thread summary and the chat reply, never only in a letter, and how to link a letter', () => {
    expect(PROOF_IN_PLACE_RULE).toContain('never only in a letter')
    expect(PROOF_IN_PLACE_RULE).toMatch(/thread's summary and in your chat reply itself/)
    expect(PROOF_IN_PLACE_RULE).toContain('lt-...')
    expect(PROOF_IN_PLACE_RULE).toContain('(letter:lt-...)')
  })

  it('rides Main\'s and every lead\'s prompt and the away-inbox line', () => {
    expect(THREADS_LINE).toContain(PROOF_IN_PLACE_RULE)
    expect(AWAY_INBOX_LINE).toContain(PROOF_IN_PLACE_RULE)
  })

  it('reaches every thread writer (its prompt or the op), rides the letter op and the walnut skill', () => {
    expect(opsWhereRuleIsUnread(PROOF_IN_PLACE_RULE, ['thread_update', 'thread_create'])).toEqual([])
    expect(getOp('human_inbox_send')?.description).toContain(PROOF_IN_PLACE_RULE)
    const skill = fs.readFileSync('src/data/skills/walnut/SKILL.md', 'utf-8')
    expect(skill).toContain('**The proof stays where the user reads the result.**')
    expect(skill).toContain('`[words](letter:lt-...)`')
  })
})
