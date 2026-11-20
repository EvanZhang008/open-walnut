/**
 * The judge's answer is checked word for word (src/core/org/reflection/judge.ts verifyFinding): a
 * finding whose session, user or rule quote is not in the record is dropped, so a judge that makes
 * up a sentence or a rule produces nothing.
 */
import { describe, it, expect } from 'vitest'
import { judge, quoteHolds, verifyFinding } from '../../../src/core/org/reflection/judge.js'

const SESSION = 'I kept the package on major version 1.4. Opening 1.8 would touch four packages and the version set, a much bigger change. My recommendation is to keep it this way.'
const USER = 'No no no, this is completely wrong. Of course we want a clean version, do not do a hack.'
const RULES = '## USER.md\n- Fix root causes, not symptoms.\n- Decide the rest and say what you did.'
const input = { signal: 'frustration' as const, sessionText: SESSION, userText: USER, rulesText: RULES, guidance: ['Keep names true to what they hold.'] }

const answer = (finding: Record<string, unknown>) => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'change_too_big_excuse', session_quote: 'Opening 1.8 would touch four packages and the version set, a much bigger change.',
  user_quote: 'do not do a hack', rule_quote: 'Fix root causes, not symptoms.', what_went_wrong: 'Kept 1.8.1 in 1.4 to avoid changing dependents.',
  correct_action: 'Open 1.8 and move the dependents.', already_fixed: false, correction: 'Open 1.8 now.', guidance: 'Do not keep old version numbers to avoid changing dependents.', same_as: 0, skill: null,
  ...finding,
} })

describe('reflection judge: quotes are checked', () => {
  it('keeps a finding whose quotes are all in the record, across line breaks and ellipses', () => {
    const v = verifyFinding(answer({}), input)
    expect(v.verdict).toBe('bad_decision')
    expect(quoteHolds('I kept the package\non major version 1.4 ... My recommendation', SESSION)).toBe(true)
    expect(quoteHolds('ok', SESSION)).toBe(false)
  })

  it('drops a made-up session quote, user quote or rule', () => {
    expect(verifyFinding(answer({ session_quote: 'I decided to skip the tests.' }), input).verdict).toBe('unverified')
    expect(verifyFinding(answer({ user_quote: 'you never listen to me' }), input).verdict).toBe('unverified')
    expect(verifyFinding(answer({ rule_quote: 'Always ask before any change.' }), input).verdict).toBe('unverified')
    // A rule is optional (a missing fact), a user quote is not, except before he answered.
    expect(verifyFinding(answer({ rule_quote: '' }), input).verdict).toBe('bad_decision')
    expect(verifyFinding(answer({ user_quote: '' }), input).verdict).toBe('unverified')
    expect(verifyFinding(answer({ user_quote: '' }), { ...input, signal: 'needs_ask' }).verdict).toBe('bad_decision')
  })

  it('reads no_issue, bad JSON and a failed call as no finding', async () => {
    expect(verifyFinding('{"verdict":"no_issue","why":"he chose another option"}', input)).toEqual({ verdict: 'no_issue', why: 'he chose another option' })
    expect(verifyFinding('I think it was fine', input).verdict).toBe('unverified')
    const failed = await judge({ ...input, taskTitle: 't', turnsText: '', momentAt: '2026-11-19T00:00:00Z', replyLanguage: null }, async () => { throw new Error('throttled') })
    expect(failed.verdict).toBe('unverified')
    // An empty reply is asked once more, never more.
    const replies = ['', answer({})]
    const again = await judge({ ...input, taskTitle: 't', turnsText: '', momentAt: '2026-11-19T00:00:00Z', replyLanguage: null }, async () => replies.shift() ?? '')
    expect(again.verdict).toBe('bad_decision')
    let n = 0
    await judge({ ...input, taskTitle: 't', turnsText: '', momentAt: '2026-11-19T00:00:00Z', replyLanguage: null }, async () => { n++; return '' })
    expect(n).toBe(2)
  })

  it('drops a quote cut into crumbs', () => {
    expect(quoteHolds('I kept ... package ... major ... 1.4', SESSION)).toBe(false)
    expect(quoteHolds('I kept the package ... a much bigger change', SESSION)).toBe(true)
  })

  it('keeps same_as only when it names a listed line, and a skill only with a valid name', () => {
    const v = verifyFinding(answer({ same_as: 1, skill: { name: 'Bad Name', description: 'd', text: 't' } }), input)
    expect(v.verdict === 'bad_decision' && v.finding.same_as).toBe(1)
    expect(v.verdict === 'bad_decision' && v.finding.skill).toBe(null)
    const w = verifyFinding(answer({ same_as: 9, skill: { name: 'open-a-new-major-version', description: 'When upstream moves a major version', text: '1. Open it. 2. Move the dependents.' } }), input)
    expect(w.verdict === 'bad_decision' && w.finding.same_as).toBe(0)
    expect(w.verdict === 'bad_decision' && w.finding.skill?.name).toBe('open-a-new-major-version')
  })
})
