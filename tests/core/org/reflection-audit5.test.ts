/**
 * The 2026-11-26 audit of the reflection (src/core/org/reflection/): the step check held a correction that
 * said what the user's own rule says (a sign-in agents do themselves) and one that only asked for a walk
 * through the team's own app; a held correction's note carried its diagnosis, and a session took a decision
 * of his on it; lessons quoting him were held out of the queue for good; one card was corrected four times
 * in two hours (its key held its words); and most wrong "not done" findings said a card lacked what it, or
 * the letter it named, had.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-audit5'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import type { ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { readDayEntries, readGuidance, reflectionDayJsonOf } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { ASK_FIRST_CONFLICTS, ASK_FIRST_SYSTEM, GATE_SYSTEM, askFirstLesson, GATE_VERSION, checkStepOf, gateText, resetForGateVersion } from '../../../src/core/org/reflection/step-gate.js'
import { TAKEN_UP_SYSTEM } from '../../../src/core/org/reflection/moment-age.js'
import { backfillDropped } from '../../../src/core/org/reflection/guidance-merge.js'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const RULE = 'Run commands, logins, sudo, 2FA and confirm pages on his machines yourself.'
const USER_RULES = `## Standing rules\n- ${RULE} Ask only for what needs his hand.`

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
})

describe('his own rules settle a sign-in, never a send in his name or a cloud write', () => {
  const model = (raw: string, asked: string[] = []) => async (system: string, user: string) => { expect(system).toBe(GATE_SYSTEM); asked.push(user); return raw }

  it('a sign-in his rule tells agents to do passes, with the rule quoted word for word; fixed words included', async () => {
    const asked: string[] = []
    const settled = `{"steps":[],"why":"a sign-in","settled":[{"step":"user_account","rule":"${RULE}"},{"step":"user_browser","rule":"${RULE}"}]}`
    const g = await gateText('Sign in with walnut browser fill-login yourself; ask him only for the phone code.', model(settled, asked), 'n', USER_RULES)
    expect(g.steps).toEqual([])
    expect(asked[0]).toContain('USER RULES:')
    expect(asked[0]).toContain(RULE)
  })

  it('a rule quote that is not in his rules, or a step a rule may not settle, is still held', async () => {
    const fake = '{"steps":["user_account"],"why":"x","settled":[{"step":"user_account","rule":"Agents may use any of his accounts freely."}]}'
    expect((await gateText('Sign in to his mail.', model(fake), 'n', USER_RULES)).steps).toEqual(['user_account'])
    const send = `{"steps":["in_his_name","cloud_account_write"],"why":"x","settled":[{"step":"in_his_name","rule":"${RULE}"},{"step":"cloud_account_write","rule":"${RULE}"}]}`
    expect((await gateText('Post the reply as him and set the weight in gamma.', model(send), 'n', USER_RULES)).steps).toEqual(['in_his_name', 'cloud_account_write'])
  })

  it('a rule settles a step only as one unbroken passage about signing in: no other sentence of his rules, no stitched quote', async () => {
    const OTHER = 'Never put his conversations anywhere public, whatever the reason.'
    const rules = `${USER_RULES}\n- ${OTHER}`
    const settle = (rule: string) => model(`{"steps":["user_account"],"why":"x","settled":[{"step":"user_account","rule":${JSON.stringify(rule)}}]}`)
    expect((await gateText('Sign in to the dashboard.', settle(OTHER), 'n', rules)).steps).toEqual(['user_account'])
    expect((await gateText('Sign in to the dashboard.', settle('Run commands, logins ... confirm pages on his machines yourself.'), 'n', rules)).steps).toEqual(['user_account'])
    expect((await gateText('Sign in to the dashboard.', settle('logins, sudo, 2FA'), 'n', rules)).steps).toEqual(['user_account'])
    expect((await gateText('Sign in to the dashboard.', settle(RULE), 'n', rules)).steps).toEqual([])
  })

  it('fixed words of a step no rule settles are held with no call; a failed call keeps the fixed words held', async () => {
    let calls = 0
    const never = async () => { calls++; return '{"steps":[]}' }
    // No rules: the fixed words hold, as before.
    expect((await gateText('Open walnut browser.', never, 'n')).steps).toEqual(['user_browser'])
    expect(calls).toBe(0)
    expect((await gateText('Open walnut browser.', async () => { throw new Error('throttled') }, 'n', USER_RULES)).steps).toEqual(['user_browser'])
  })

  it('the pass wrapper keeps the fixed words held when its model layer passes the text without settling them', async () => {
    const check = checkStepOf({ checkStep: async () => ({ steps: [], why: 'fine', by: 'model' }) })
    expect((await check('Finish it in walnut browser.', 'n')).steps).toEqual(['user_browser'])
    const settled = checkStepOf({ checkStep: async () => ({ steps: [], why: 'his rule', by: 'model', settled: [{ step: 'user_browser', rule: RULE }] }) })
    expect((await settled('Finish it in walnut browser.', 'n')).steps).toEqual([])
  })

  it('the prompt does not count asking first, nor using or testing the team\'s own product, as a step', () => {
    expect(GATE_SYSTEM).toContain('take the step only on that person\'s explicit yes')
    expect(GATE_SYSTEM).toContain('using, testing or recording the team\'s own product')
    expect(GATE_SYSTEM).toContain('settled is only for user_browser and user_account')
  })

  it('a new version of the check judges again what the old one held, once', async () => {
    await updateReflectionState(vp.id, (s) => { s.stepHeld = ['a held lesson']; s.stepChecked = { k: { steps: ['user_account'], why: 'x' } } }, NOW)
    expect(await resetForGateVersion(vp.id, NOW)).toBe(true)
    const s = await readReflectionState(vp.id, NOW)
    expect(s.stepHeld).toEqual([])
    expect(s.stepChecked).toEqual({})
    expect(s.gateVersion).toBe(GATE_VERSION)
    expect(await resetForGateVersion(vp.id, NOW)).toBe(false)
  })
})

describe('a held correction never carries its diagnosis', () => {
  it('the note names the step only: what went wrong is not in it', async () => {
    const sent: string[] = []
    const WRONG = 'This was a technical call the agent should have made: pick option A for him.'
    const threads: ReflectionThread[] = [{ id: 'th-aa0001', title: 'Role fix', messages: [
      { id: 'tm-aa0010', at: iso(30), text: 'why do you ask me this', sid: 'sess-vp', answer: { text: 'Pick a fix.', at: iso(29) } },
    ] }]
    const d: ReflectDeps = {
      readTranscript: async () => [] as never, readMessages: async () => [], readThreads: async (id) => (id === vp.id ? threads : []),
      callModel: async () => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
        kind: 'question_not_for_user', session_quote: 'Pick a fix.', user_quote: 'why do you ask me this', rule_quote: '', what_went_wrong: WRONG,
        correct_action: 'Post option A in his name.', already_fixed: false, correction: 'Post option A in his name.', guidance: '', same_as: 0, skill: null } }),
      checkStep: async (t) => (t.includes('in his name') ? { steps: ['in_his_name'], why: 'a post as him', by: 'model' } : { steps: [], why: '', by: 'model' }),
      send: async (_t, text) => { sent.push(text); return true }, confirmSend: async () => true, rulesText: async () => '', replyLanguage: async () => null, nowMs: () => NOW,
    }
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('held its correction back')
    expect(sent[0]).not.toContain('What it saw')
    expect(sent[0]).not.toContain('technical call')
  })
})

describe('one card is corrected once a while, whatever its words or decision id', () => {
  it('a rewritten card with a new ask id on the same thread gets no second correction within the gap', async () => {
    const card = (askId: string, reply: string, at: string): ReflectionThread[] => [{ id: 'th-card01', title: 'Publish the change', state: 'needs', closed: false, replyAt: at, replySid: 'sess-vp', reply, options: [], askId, messages: [] } as never]
    const run = async (threads: ReflectionThread[], nowMs: number) => {
      const sent: string[] = []
      await reflectForNode(vp, 'Marina VP', [vp], {
        readTranscript: async () => [] as never, readMessages: async () => [], readThreads: async (id) => (id === vp.id ? threads : []),
        callModel: async () => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: { kind: 'unclear_ask', session_quote: 'Publish?', user_quote: '', rule_quote: '', what_went_wrong: 'No buttons.', correct_action: 'Add buttons.', already_fixed: false, correction: 'Add the buttons.', guidance: '', same_as: 0, skill: null } }),
        checkStep: async () => ({ steps: [], why: '', by: 'model' }),
        send: async (_t, text) => { sent.push(text); return true }, confirmSend: async () => true, rulesText: async () => '', replyLanguage: async () => null, nowMs: () => nowMs,
      })
      return sent
    }
    expect(await run(card('ask-one001', 'Publish?', iso(10)), NOW)).toHaveLength(1)
    // Two hours later, rewritten with a new decision id: same place, no new word of his: not again.
    expect(await run(card('ask-two002', 'Publish? (rewritten)', new Date(NOW + 110 * 60_000).toISOString()), NOW + 2 * 3600_000)).toHaveLength(0)
    expect((await readDayEntries(vp.id, localDate(NOW)))!.some((e) => e.notSent === 'card_corrected')).toBe(true)
  })
})

describe('an ask\'s correction is checked against the card as he reads it now', () => {
  const lacking = JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: { kind: 'unclear_ask', session_quote: 'Send the DM?', user_quote: '', rule_quote: '', what_went_wrong: 'No draft, no buttons.', correct_action: 'Add the draft and buttons.', already_fixed: false, correction: 'Put the full draft and two buttons on the card.', guidance: '', same_as: 0, skill: null } })
  const worker = { id: 'w-1', title: 'Restart the agent', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1', parent_task_id: vp.id,
    user_status: { state: 'needs', source: 'session', ask: 'Send the DM? Details in lt-mwxacxce-c9ab9d', at: iso(30), askSessionId: 'sess-1' } } as unknown as Task
  const run = async (over: Partial<ReflectDeps>, takenUp = '{"done":[]}') => {
    const sent: string[] = []
    const checks: string[] = []
    await reflectForNode(vp, 'Marina VP', [vp, worker], {
      readTranscript: async () => [{ role: 'assistant', text: 'Send the DM?', timestamp: iso(31) }] as never, readMessages: async () => [], readThreads: async () => [],
      callModel: async (system, user) => { if (system === TAKEN_UP_SYSTEM) { checks.push(user); return takenUp } return lacking },
      checkStep: async () => ({ steps: [], why: '', by: 'model' }),
      send: async (_t, text) => { sent.push(text); return true }, confirmSend: async () => true, rulesText: async () => '', replyLanguage: async () => null, nowMs: () => NOW,
      ...over,
    })
    return { sent, checks }
  }

  it('a card the letter it names already completes: not sent; the check read the letter', async () => {
    const { sent, checks } = await run({
      askNow: async () => worker.user_status!,
      letterText: async (id) => (id === 'lt-mwxacxce-c9ab9d' ? 'Subject: Restart\nThe full English DM ...\nButtons: [Send it (recommended)] [Skip]' : null),
    }, '{"done":[{"n":1,"quote":"Buttons: [Send it (recommended)] [Skip]"}]}')
    expect(sent).toHaveLength(0)
    expect(checks[0]).toContain('The full English DM')
    const e = (await readDayEntries(vp.id, localDate(NOW)))![0]
    expect(e.notSent).toBe('handled_since')
    // The record says what showed it done (review of 57063edbcd).
    expect(e.handledQuote).toBe('Buttons: [Send it (recommended)] [Skip]')
  })

  it('a done item quoting under 20 characters of the card proves nothing: sent', async () => {
    const { sent } = await run({
      askNow: async () => worker.user_status!,
      letterText: async () => 'Subject: Restart\nThe full English DM ...',
    }, '{"done":[{"n":1,"quote":"The full English DM ..."}]}')
    expect(sent).toHaveLength(1)
  })

  it('an ask that left Needs you since: not sent, no call', async () => {
    const { sent, checks } = await run({ askNow: async () => ({ state: 'waiting', source: 'session' }) as never })
    expect(sent).toHaveLength(0)
    expect(checks).toHaveLength(0)
  })

  it('a card that still lacks it, or no way to read the card now: sent', async () => {
    expect((await run({ askNow: async () => worker.user_status! })).sent).toHaveLength(1)
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
    expect((await run({})).sent).toHaveLength(1)
  })
})

describe('a held lesson that quotes him is rewritten to ask first, never dropped for good', () => {
  const day = localDate(NOW)
  const seed = async (guidance: string, quote: string) => {
    const f = reflectionDayJsonOf(vp.id, day)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, JSON.stringify({ schemaVersion: 1, nodeId: vp.id, nodeName: 'Marina VP', date: day, entries: [{
      at: iso(60), signal: 'frustration', task: { id: 'w-1', title: 'x' }, corrected: 'sent', rule: { kind: 'none', text: `not added (step_check_held: it would have sessions x): ${guidance}` },
      finding: { kind: 'other', session_quote: 's', user_quote: quote, rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: 'c', guidance, same_as: 0, skill: null },
    }] }))
  }

  it('his words: rewritten once, checked, and written; the rewrite is kept for later passes', async () => {
    await seed('Turn the experimental switch on yourself in his account.', 'this is an experimental feature')
    const rewrites: string[] = []
    const callModel = async (system: string, user: string) => {
      if (system === ASK_FIRST_SYSTEM) { rewrites.push(user); return 'Ask the person your rules name before turning an experimental switch on, a step only the user may allow, and do it only on their yes.' }
      return '{}'
    }
    const checkStep = async (t: string) => (t.startsWith('Ask the person') ? { steps: [], why: '', by: 'model' as const } : { steps: ['user_account' as const], why: 'his account', by: 'model' as const })
    await backfillDropped(vp, 'Marina VP', { callModel, replyLanguage: async () => null, checkStep }, NOW)
    expect(rewrites).toHaveLength(1)
    expect((await readGuidance(vp.id)).map((l) => l.text)).toContain('Ask the person your rules name before turning an experimental switch on, a step only the user may allow, and do it only on their yes.')
    expect((await readReflectionState(vp.id, NOW)).stepHeld ?? []).toEqual([])
  })

  it('a lesson whose point is to act on his yes without asking again is never rewritten to ask first: held, and the record says why', async () => {
    await seed('Go ahead with the same-batch posts in his name once he said yes to the batch, without asking about each.', 'I said yes to all of them')
    await backfillDropped(vp, 'Marina VP', {
      callModel: async (system) => (system === ASK_FIRST_SYSTEM ? 'CONFLICTS' : '{}'), replyLanguage: async () => null,
      checkStep: async () => ({ steps: ['in_his_name'], why: 'a post as him', by: 'model' }),
    }, NOW)
    expect(await readGuidance(vp.id)).toEqual([])
    expect((await readReflectionState(vp.id, NOW)).stepHeld?.length).toBe(1)
    const md = await fs.readFile(path.join(path.dirname(reflectionDayJsonOf(vp.id, day)), `${day}.md`), 'utf-8').catch(() => '')
    expect(md).toContain('would reverse')
  })

  it('a lesson whose own words say not to ask is held with no call; one that asks for his yes is rewritten (the 11-26 held lessons)', async () => {
    let calls = 0
    const call = async () => { calls++; return 'Ask the person your rules name first, and act only on their yes.' }
    const pass = async () => ({ steps: [], why: '', by: 'model' as const })
    // English, and Chinese as escapes: "decide it yourself and tell him after; no card for him" / "clean up yourself and report after".
    for (const l of ['Run the check yourself and tell him after; do not ask about each one.', 'Decide it yourself, without asking.',
      '\u81ea\u5df1\u51b3\u5b9a\u5e76\u4e8b\u540e\u544a\u8bc9\u4ed6\uff0c\u4e0d\u505a\u6210\u5f85\u4ed6\u70b9\u5934\u7684\u5361\u3002',
      '\u7528\u5b8c\u7531\u81ea\u5df1\u6e05\u7406\u5e76\u4e8b\u540e\u62a5\u544a\u3002']) {
      expect(await askFirstLesson(l, ['user_account'], call, pass, 'n')).toBe(ASK_FIRST_CONFLICTS)
    }
    expect(calls).toBe(0)
    expect(await askFirstLesson('A prod write needs his approval: the card asks only whether he approves, and the agent does it after.', ['user_browser'], call, pass, 'n'))
      .toBe('Ask the person your rules name first, and act only on their yes.')
    expect(calls).toBe(1)
  })

  it('a lesson with no words of his is held as before', async () => {
    await seed('Turn the experimental switch on yourself in his account.', '')
    let rewrites = 0
    await backfillDropped(vp, 'Marina VP', {
      callModel: async (system) => { if (system === ASK_FIRST_SYSTEM) rewrites++; return '{}' }, replyLanguage: async () => null,
      checkStep: async () => ({ steps: ['user_account'], why: 'his account', by: 'model' }),
    }, NOW)
    expect(rewrites).toBe(0)
    expect((await readReflectionState(vp.id, NOW)).stepHeld?.length).toBe(1)
  })
})
