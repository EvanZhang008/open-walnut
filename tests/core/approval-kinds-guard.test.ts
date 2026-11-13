/**
 * What agents are told with approvals off and what answers_ask lets them do read ONE list
 * (src/core/approval-kinds.ts). 2026-11-12: the prompt said an outward message was no longer the
 * user's decision while answers_ask still refused every outward ask, because each kept its own
 * idea of the kinds. A new approval kind must be put on one side or the other here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { APPROVAL_KINDS, needsUsersWords, STILL_THE_USERS, SWITCH_OFF_SETTLES } from '../../src/core/approval-kinds.js'
import { approvalsLine } from '../../src/core/sessions/reply-language-context.js'

describe('the Approvals switch and answers_ask read one list of kinds', () => {
  it('every approval kind is either settled by the switch or named as still the user\'s, never both', () => {
    for (const kind of APPROVAL_KINDS) {
      const settled = SWITCH_OFF_SETTLES.has(kind)
      const still = kind in STILL_THE_USERS
      expect(settled !== still, kind).toBe(true)
    }
    for (const kind of [...SWITCH_OFF_SETTLES, ...Object.keys(STILL_THE_USERS)]) expect(APPROVAL_KINDS.has(kind), kind).toBe(true)
  })

  it('with the switch on, every kind needs the user\'s words; off, only the ones still his', () => {
    for (const kind of APPROVAL_KINDS) {
      expect(needsUsersWords(kind, true), kind).toBe(true)
      expect(needsUsersWords(kind, false), kind).toBe(!SWITCH_OFF_SETTLES.has(kind))
    }
    expect(needsUsersWords('decision', false)).toBe(false)
    expect(needsUsersWords(undefined, true)).toBe(false)
  })

  it('the prompt\'s approvals-off line names every kind still the user\'s and says answers_ask settles the rest', () => {
    expect(approvalsLine(true)).toBe('')
    const line = approvalsLine(false)
    for (const words of Object.values(STILL_THE_USERS)) expect(line, words).toContain(words)
    expect(line).toContain('answers_ask')
    expect(line).toContain('a `walnut approve` in a script still asks the user')
  })

  it('both places read the shared list, not a copy of their own', () => {
    const answer = fs.readFileSync('src/core/sessions/ask-answer.ts', 'utf8')
    expect(answer).toMatch(/needsUsersWords\(kind, await asksPerson\(\)\)/)
    expect(answer).not.toMatch(/APPROVAL_KINDS\.has/)
    expect(fs.readFileSync('src/core/sessions/reply-language-context.ts', 'utf8')).toMatch(/Object\.values\(STILL_THE_USERS\)/)
    expect(fs.readFileSync('src/core/same-ask.ts', 'utf8')).not.toMatch(/new Set\(\['outward'/)
  })
})
