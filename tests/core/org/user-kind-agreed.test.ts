/**
 * A question whose reason says the user already agreed to it is refused: the step that follows is the
 * task's own (src/core/org/user-kind.ts followsAgreedStep; 2026-11-20, the user: "why ... is this need
 * you ... nothing need from me" about a task asking whether to swap in new CR descriptions after he had
 * agreed to publish the CRs). A reason that names what is new in the step still reaches him.
 */
import { describe, it, expect } from 'vitest'
import { followsAgreedStep, userKindVerdict } from '../../../src/core/org/user-kind.js'
import { emptyThreads, openThread, updateThread } from '../../../src/core/org/threads-model.js'

const AT = '2026-11-20T21:22:00.000Z'

describe('a follow-up of what the user already agreed to is never his', () => {
  const followUps = [
    'He already approved publishing both CRs; this swaps in their new descriptions',
    'The user already agreed to the CR, this only updates its pictures',
    'The user said yes to the release earlier, so this runs their words',
    'She already gave the go-ahead for the reply',
    '\u4ed6\u5df2\u7ecf\u540c\u610f\u53d1\u5e03\u8fd9\u4e24\u4e2a CR\uff0c\u8fd9\u91cc\u53ea\u662f\u6362\u63cf\u8ff0',
    '\u8fd9\u4e2a CR \u4ed6\u540c\u610f\u8fc7\u4e86\uff0c\u8865\u4e24\u5f20\u56fe',
  ]
  const stillHis = [
    'Alex already agreed to move the meeting; only he can pick the new time',
    'The team already approved the budget; this extra $500 is spending',
    'He already approved the purchase; the card needs his one-time code',
    'It posts in his name to a channel of colleagues, though he agreed to the draft',
    'It posts in his name to a channel of colleagues',
    'He already approved the CR, but publishing the release to npm is a new public step',
    'They approved the draft; sending it to another team was never agreed',
    '\u4ed6\u5df2\u7ecf\u540c\u610f\u4e86 CR\uff0c\u4f46\u5bf9\u5916\u53d1\u5e03\u662f\u65b0\u7684\u4e00\u6b65',
  ]

  it('reads the reasons', () => {
    for (const why of followUps) expect(followsAgreedStep(why), why).toBe(true)
    for (const why of stillHis) expect(followsAgreedStep(why), why).toBe(false)
  })

  it('refuses the verdict with a pointer to do it, and keeps a new step', () => {
    for (const why of followUps) {
      const v = userKindVerdict({ user_kind: 'outward', user_kind_why: why, subject: 'Swap in the new descriptions?' })
      expect(v.ok, why).toBe(false)
      if (!v.ok) expect(v.message).toMatch(/the step that follows is yours\. Do it now and tell them in one line afterwards/)
    }
    for (const why of stillHis) expect(userKindVerdict({ user_kind: 'outward', user_kind_why: why, subject: 'Go ahead?' }).ok, why).toBe(true)
    // The turn-end line has no subject: it keeps the old verdict (a refusal there would silently drop the ask).
    expect(userKindVerdict({ user_kind: 'outward', user_kind_why: followUps[0] }).ok).toBe(true)
  })

  it('refuses a thread opened or moved to needs on such a reason', () => {
    const why = followUps[0]!
    expect(() => openThread(emptyThreads('vp'), { title: 'Swap CR descriptions', text: 'Swap them in?', from: 'task', user_kind: 'outward', user_kind_why: why }, 'task:cis', AT)).toThrow(/the step that follows is yours/)
    const { file, thread } = openThread(emptyThreads('vp'), { title: 'CRs published', text: 'Published.', from: 'task', state: 'answered' }, 'task:cis', AT)
    expect(() => updateThread(file, thread.id, { state: 'needs', user_kind: 'outward', user_kind_why: why }, 'task:cis', AT)).toThrow(/the step that follows is yours/)
  })
})

describe('words of his cover only what they were about', () => {
  // His words in another task, about one CR; the ask is about two other CRs.
  const why = 'You said the CR descriptions and pictures go to you first'
  const words = 'show me the description and the diagram before you publish it'
  const ask = 'Swap in the new descriptions of CR-400000111 and CR-400000222?'

  it('a reason that rests on his earlier words must carry them and what they were about', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: why, subject: ask })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/user_kind_words .* user_kind_about/)
  })

  it('words about another CR are refused for this one, with the rule in the refusal', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777 (task abcd1234)', subject: ask })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/Those words cover only what they were about/)
    expect(() => openThread(emptyThreads('vp'), {
      title: 'New CR descriptions', text: ask, from: 'task', user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777',
    }, 'task:cis', AT)).toThrow(/Those words cover only what they were about/)
  })

  it('naming the other CR in the reason does not make the ask about it', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: 'You said on CR-100000777 that descriptions go to you first', user_kind_words: words, user_kind_about: 'CR-100000777', subject: ask })
    expect(v.ok).toBe(false)
  })

  it('reasons that only mention someone speaking are no citation', () => {
    for (const why2 of ['He wrote the original post, so a reply in his name is his', 'They said Tuesday or Wednesday works', 'The vendor said they required his signature']) {
      expect(userKindVerdict({ user_kind: 'outward', user_kind_why: why2, subject: 'Reply?' }).ok, why2).toBe(true)
    }
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: 'He asked to see CR descriptions before publishing', subject: ask })
    expect(v.ok).toBe(false)
  })

  it('words about this very CR pass, and asking alone is no citation', () => {
    const same = 'Swap in the new description of CR-100000777?'
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777', subject: same }).ok).toBe(true)
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: 'The user asked to pick the date himself', subject: 'Pick a date' }).ok).toBe(true)
    // The turn-end line has no room for the words: it is judged as before.
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: why }).ok).toBe(true)
  })
})
