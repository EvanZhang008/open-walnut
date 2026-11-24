/**
 * A card that asks the user to decide carries what he needs to decide (src/core/org/ask-clarity.ts
 * bareCardRefusal; 2026-11-23, the CEO's reflection on 11-22: "the cards that ask Evan to decide are
 * bare Yes/No, with no background": a delete card with only [Yes] [No] and its pick second, an ops
 * review that named "about 7 clusters" with no names or links, an approval with no body). The last
 * block is the class guard: every door that hands the user an agent's decision passes its choices,
 * in order, to the check, so a new door that drops them fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { askUserQuestionRefusal, bareCardRefusal, choiceShapes, turnEndAskRefusal, THIN_CARD_MIN } from '../../../src/core/org/ask-clarity.js'
import { userKindVerdict } from '../../../src/core/org/user-kind.js'

const KIND = { user_kind: 'cloud_delete', user_kind_why: 'It deletes cloud resources in his own account' }
const WHY = 'The three test clusters acme-dev-1, acme-dev-2 and acme-dev-3 have been idle since 11-10 and cost about $40 a day.'

describe('the cards as they were', () => {
  it('a delete card with only Yes and No, its pick second', () => {
    const v = userKindVerdict({ ...KIND, subject: 'Delete the idle test clusters?', detail: WHY, choices: [{ label: 'No' }, { label: 'Yes', recommended: true }] })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.message).toMatch(/your pick "Yes" is not the first choice/)
    // Its pick first and its background given, bare [Yes] [No] still say nothing of what a click does.
    const keys = userKindVerdict({ ...KIND, subject: 'Delete the idle test clusters?', detail: WHY, choices: [{ label: 'Yes', recommended: true }, { label: 'No' }] })
    expect(!keys.ok && keys.message).toMatch(/its button "Yes" does not say what happens on a click/)
    // With no background it is refused, Yes and No or not.
    const bare = userKindVerdict({ ...KIND, subject: 'Delete them?', choices: [{ label: 'Yes', recommended: true }, { label: 'No' }] })
    expect(!bare.ok && bare.message).toMatch(/says too little/)
  })

  it('an ops review that counts clusters without naming them', () => {
    const v = userKindVerdict({ ...KIND, subject: 'Run the ops review on about 7 edge clusters this week?', detail: 'The review needs a colleague to approve each change.', choices: [{ label: 'Run the review this week', recommended: true }, { label: 'Wait for next week' }] })
    expect(!v.ok && v.message).toMatch(/counts "about 7 edge clusters" without naming them/)
  })

  it('a sign-in card with only [Yes] [No] (11-23), as a yes/no ask or as its keys, in either language', () => {
    const ask = 'Please sign in again on the dev box to renew its certificate, or the change that lets the AI approve read-only requests cannot be pushed.'
    const signIn = { ...KIND, user_kind: 'user_own', subject: ask }
    expect(userKindVerdict({ ...signIn, choices: [{ label: 'Yes' }, { label: 'No' }] }).ok).toBe(false)
    expect(turnEndAskRefusal({ state: 'needs', ask, ask_kind: 'yes_no' })).toMatch(/does not say what happens on a click/)
    // "OK" and "Cancel" (in Chinese) too, marked recommended or not.
    expect(bareCardRefusal(ask, [{ label: '\u786e\u5b9a (recommended)' }, { label: '\u53d6\u6d88' }], { standalone: true })).toMatch(/does not say what happens/)
    // Keys that name their result pass; a bare key with its own line of what it does passes too.
    expect(turnEndAskRefusal({ state: 'needs', ask, ask_kind: 'single', ask_options: [{ label: 'I signed in again, push it now', recommended: true }, { label: 'Not today' }] })).toBeNull()
    expect(bareCardRefusal(ask, [{ label: 'Yes', detail: 'I push the change right after', recommended: true }, { label: 'No', detail: 'It waits until Monday' }], { standalone: true })).toBeNull()
    // A bare key beside a pick that names its result reads fine; a bare pick does not, whatever its marks.
    expect(bareCardRefusal(ask, [{ label: 'Push revision 2 now', recommended: true }, { label: 'Cancel' }], { standalone: true })).toBeNull()
    expect(bareCardRefusal(ask, [{ label: 'Yes, push it', recommended: true }, { label: 'No' }], { standalone: true })).toBeNull()
    expect(bareCardRefusal(ask, [{ label: '\u662f\uff08\u63a8\u8350\uff09' }, { label: 'Keep it unpushed' }], { standalone: true })).toMatch(/does not say what happens/)
    expect(bareCardRefusal(ask, [{ label: '\u2705 Yes' }, { label: '\u274c No' }], { standalone: true })).toMatch(/does not say what happens/)
    // In the chat, beside the work, a short yes or no stays fine.
    expect(bareCardRefusal(ask, [{ label: 'Yes' }, { label: 'No' }])).toBeNull()
  })

  it('a card with no body', () => {
    const v = userKindVerdict({ ...KIND, subject: 'Approve the ticket?', choices: [{ label: 'Approve the ticket', recommended: true }, { label: 'Leave it open' }] })
    expect(!v.ok && v.message).toMatch(/says too little to decide on/)
  })
})

describe('the same cards written well pass', () => {
  it('the pick first, each choice says what it does, the things named, the why given', () => {
    expect(userKindVerdict({ ...KIND, subject: 'Delete the idle test clusters? I recommend yes.', detail: WHY, choices: [
      { label: 'Yes', detail: 'Delete acme-dev-1, acme-dev-2 and acme-dev-3 now', recommended: true },
      { label: 'No', detail: 'Keep them another week' },
    ] }).ok).toBe(true)
    expect(userKindVerdict({ ...KIND, subject: 'Delete the 3 idle test clusters? I recommend it.', detail: WHY, choices: [
      { label: 'Delete the 3 clusters', recommended: true }, { label: 'Keep them a week' },
    ] }).ok).toBe(true)
    // Their list by link is a naming too.
    expect(bareCardRefusal('Run the ops review on about 7 edge clusters? List: https://example.com/review/7 . A colleague approves each change.', [], { standalone: true })).toBeNull()
  })

  it('counts read as things to name only for what a decision acts on, in either language', () => {
    const card = (q: string) => bareCardRefusal(`${q} They have been idle since 11-10 and cost money every day.`, [], { standalone: true })
    expect(card('Delete about seven old idle test clusters?')).toMatch(/without naming them/)
    expect(card('Delete several stale branches?')).toMatch(/without naming them/)
    // "Delete 7 production clusters?" in Chinese.
    expect(card('\u5220\u9664 7 \u4e2a\u751f\u4ea7\u96c6\u7fa4\u5417\uff1f')).toMatch(/without naming them/)
    expect(card('The outage hit over 100 users; raise the rate limit?')).toBeNull()
    // Things still to make have no names yet.
    expect(card('Should we create three alpha test accounts?')).toBeNull()
    expect(card('Create the three alpha test accounts?')).toBeNull()
    expect(card('Delete about 7 clusters? See e.g. the plan, i.e. the old ones.')).toMatch(/without naming them/)
    expect(card('Delete about 7 clusters:\n- acme-dev-1\n- acme-dev-2')).toBeNull()
  })

  it('a long card is checked in linear time', () => {
    const t0 = performance.now()
    bareCardRefusal(`Delete about 7 clusters?${'\n'.repeat(3_900)}x`, [], { standalone: true })
    expect(performance.now() - t0).toBeLessThan(20)
  })

  it('no pick at all is fine; a pick named in its label counts as one', () => {
    expect(bareCardRefusal(WHY, [{ label: 'Keep them a week' }, { label: 'Delete them now' }], { standalone: true })).toBeNull()
    expect(bareCardRefusal(WHY, [{ label: 'Keep them a week' }, { label: 'Delete them now (recommended)' }], { standalone: true })).toMatch(/not the first choice/)
  })

  it('a card read in the chat (not standalone) is not held to the background rules', () => {
    expect(bareCardRefusal('Retry?', [{ label: 'Retry with a clean cache' }, { label: 'Stop here' }])).toBeNull()
    expect(bareCardRefusal('Retry?', [{ label: 'Retry with a clean cache' }], { standalone: true })).toMatch(/says too little/)
  })

  it('weighs CJK text double, so a short Chinese card with its why passes', () => {
    // "Delete the three idle test clusters? They have been idle since 11-10 and cost money every day."
    const zh = '\u5220\u9664\u4e09\u4e2a\u95f2\u7f6e\u7684\u6d4b\u8bd5\u96c6\u7fa4\u5417\uff1f\u5b83\u4eec\u4ece 11-10 \u8d77\u5c31\u6ca1\u4eba\u7528\uff0c\u6bcf\u5929\u90fd\u5728\u82b1\u94b1\u3002'
    expect(bareCardRefusal(zh, [], { standalone: true })).toBeNull()
    expect(THIN_CARD_MIN).toBeGreaterThan(20)
  })
})

describe('every door reads the choices in order', () => {
  it('choiceShapes reads strings, {label, detail}, {label, description} and the pick', () => {
    expect(choiceShapes(['Keep', { label: 'Go', description: 'Ship it', recommended: true }, { label: 'x', detail: 'y' }, { nolabel: 1 }, 3]))
      .toEqual([{ label: 'Keep' }, { label: 'Go', detail: 'Ship it', recommended: true }, { label: 'x', detail: 'y' }])
  })

  it('a turn-end ask and an AskUserQuestion prompt refuse the same choices', () => {
    expect(turnEndAskRefusal({ state: 'needs', ask: 'Delete the idle test clusters?', ask_more: WHY, ask_options: [{ label: 'Keep them a week' }, { label: 'Delete them now', recommended: true }] })).toMatch(/not the first choice/)
    expect(turnEndAskRefusal({ state: 'needs', ask: 'Delete them?', ask_options: [{ label: 'Delete the clusters', recommended: true }, { label: 'Keep them' }] })).toMatch(/says too little/)
    const auq = (labels: string[]) => ({ questions: [{ question: 'Delete the idle test clusters?', header: 'Clusters', options: labels.map((label) => ({ label, description: '' })) }] })
    expect(askUserQuestionRefusal(auq(['Keep them a week', 'Delete them now (Recommended)']))).toMatch(/not the first choice/)
    // In the chat, beside the work: a short question is fine there.
    expect(askUserQuestionRefusal(auq(['Delete them now (Recommended)', 'Keep them a week']))).toBeNull()
  })
})

describe('class guard: a door that hands the user a decision passes its choices', () => {
  const SRC = path.resolve(__dirname, '../../../src')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.ts$/.test(e.name) ? [p] : []
  })
  const calls = (name: string) => files(SRC).flatMap((f) => {
    const text = fs.readFileSync(f, 'utf8')
    const out: Array<{ file: string; call: string }> = []
    const re = new RegExp(`(?<!function )\\b${name}\\(`, 'g')
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ file: path.relative(SRC, f), call: text.slice(m.index, m.index + 600) })
    return out
  })

  it('every userKindVerdict call with a subject passes choices', () => {
    const found = calls('userKindVerdict').filter((c) => /\bsubject\b/.test(c.call.split(');')[0]!))
    expect(found.length).toBeGreaterThanOrEqual(3)
    for (const c of found) expect(c.call.split(');')[0], c.file).toMatch(/choices:/)
  })

  it('every door that reads an ask\'s options passes its kind, so a yes/no ask is judged by its two keys', () => {
    const found = calls('choiceShapes').filter((c) => /ask_options/.test(c.call.split(')')[0]!))
    expect(found.length).toBeGreaterThanOrEqual(2)
    for (const c of found) expect(c.call.split(')')[0], c.file).toMatch(/ask_options,\s*[\w.]*ask_kind/)
  })

  it('every askClarityRefusal call outside its own file passes choices', () => {
    const found = calls('askClarityRefusal').filter((c) => c.file !== 'core/org/ask-clarity.ts')
    expect(found.length).toBeGreaterThanOrEqual(2)
    for (const c of found) expect(c.call.split(');')[0], c.file).toMatch(/choices:/)
  })
})
