/**
 * The 2026-11-27 audit of the reflection (src/core/org/reflection/): the tidy held lessons quoting the user
 * with no reason and no rewrite; a standing instruction in his own words was held and found nowhere; a
 * rewritten card still lacking a link got no second correction; what his own rule let through was never
 * recorded; and a correction rested on a change withdrawn minutes before it went out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-audit6'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import type { ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { readDayEntries, readGuidance, reflectionDayFileOf, reflectionDayJsonOf } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { ASK_FIRST_SYSTEM, checkCached, checkStepOf, keepPermissionsHeld } from '../../../src/core/org/reflection/step-gate.js'
import { TAKEN_UP_SYSTEM, takenUp } from '../../../src/core/org/reflection/moment-age.js'
import { turnsSince } from '../../../src/core/org/reflection/context.js'
import { backfillDropped } from '../../../src/core/org/reflection/guidance-merge.js'
import { askTidy } from '../../../src/core/org/reflection/guidance-tidy.js'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const day = localDate(NOW)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
})

async function seed(guidance: string, quote: string, extra: Record<string, unknown> = {}) {
  const f = reflectionDayJsonOf(vp.id, day)
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, JSON.stringify({ schemaVersion: 1, nodeId: vp.id, nodeName: 'Marina VP', date: day, entries: [{
    at: iso(60), signal: 'frustration', task: { id: 'w-1', title: 'x' }, corrected: 'sent', rule: { kind: 'none', text: `not added (day_full): ${guidance}` }, ...extra,
    finding: { kind: 'other', session_quote: 's', user_quote: quote, rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: 'c', guidance, same_as: 0, skill: null },
  }] }))
}

describe('no lesson is held silently', () => {
  it('only holdLesson writes the held list (source guard: a new writer elsewhere fails this)', async () => {
    const dir = path.join(process.cwd(), 'src/core/org/reflection')
    const writers: string[] = []
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = await fs.readFile(path.join(dir, f), 'utf-8')
      const n = (src.match(/\bstepHeld\s*=(?!=)/g) ?? []).length
      if (n) writers.push(`${f}:${n}`)
    }
    // guidance-merge.ts holdLesson, and step-gate.ts resetForGateVersion emptying it.
    expect(writers.sort()).toEqual(['guidance-merge.ts:1', 'step-gate.ts:1'])
  })

  it('the tidy leaves a held lesson to the backfill, which holds it and says why in the day record', async () => {
    const L = 'Decide the permission switch yourself without asking, and tell him after.'
    await seed(L, 'just turn it on, why do you ask')
    const checkStep = async () => ({ steps: ['user_account' as const], why: 'a permission', by: 'model' as const })
    await askTidy(vp, 'Marina VP', { send: async () => true, checkStep }, NOW)
    expect((await readReflectionState(vp.id, NOW)).stepHeld ?? []).toEqual([])
    await backfillDropped(vp, 'Marina VP', { callModel: async () => '{}', replyLanguage: async () => null, checkStep }, NOW)
    expect((await readReflectionState(vp.id, NOW)).stepHeld).toHaveLength(1)
    expect(await fs.readFile(reflectionDayFileOf(vp.id, day), 'utf-8')).toContain('was not taken up: the step check held it (user_account)')
  })
})

describe('his words behind a held "act on his yes" lesson go to the node with their place, never into the guidance by themselves', () => {
  const L = 'For every new change of this kind, list them and tag the reviewer without asking about each.'
  const Q = 'for all the changes, list them and tag the reviewer'
  const checkStep = async () => ({ steps: ['in_his_name' as const], why: 'a ping as him', by: 'model' as const })

  it('held, no line written, no rewrite asked; the day record quotes him whole with the task, thread and time', async () => {
    let calls = 0
    await seed(L, Q, { thread: { id: 'th-cr0001', title: 'CRs' }, saidAt: iso(26 * 60) })
    await backfillDropped(vp, 'Marina VP', { callModel: async (system) => { if (system === ASK_FIRST_SYSTEM) calls++; return '{}' }, replyLanguage: async () => null, checkStep }, NOW)
    expect(calls).toBe(0)
    expect(await readGuidance(vp.id)).toEqual([])
    expect((await readReflectionState(vp.id, NOW)).stepHeld).toHaveLength(1)
    const md = await fs.readFile(reflectionDayFileOf(vp.id, day), 'utf-8')
    expect(md).toContain(`"${Q}"`)
    expect(md).toContain('task w-1, thread th-cr0001')
    expect(md).toContain(iso(26 * 60))
  })
})

describe('what his own rule lets through is recorded, and only when it holds', () => {
  const RULE = 'Run commands, logins, sudo, 2FA and confirm pages on his machines yourself.'
  it('a permission, key or credential change: an account step his rule settled is taken back (in code, not only the prompt)', () => {
    const g = { steps: [], why: 'his rule', by: 'model' as const, settled: [{ step: 'user_account' as const, rule: RULE }] }
    expect(keepPermissionsHeld('Grant the speech permission on the existing key yourself.', g).steps).toEqual(['user_account'])
    expect(keepPermissionsHeld('\u7ed9\u73b0\u6709 key \u52a0\u6743\u9650', g).steps).toEqual(['user_account'])
    expect(keepPermissionsHeld('Sign in to the dashboard yourself.', g).steps).toEqual([])
  })

  it('a pass resting on his rule is asked twice and taken only when both agree', async () => {
    let n = 0
    const flip = checkStepOf({ checkStep: async () => (++n === 1
      ? { steps: [], why: 'his rule', by: 'model', settled: [{ step: 'user_browser', rule: RULE }] }
      : { steps: ['user_browser'], why: 'his browser', by: 'model' }) })
    expect((await checkCached(vp.id, 'Reconnect the extension.', flip, NOW)).steps).toEqual(['user_browser'])
    expect(n).toBe(2)
    let m = 0
    const same = checkStepOf({ checkStep: async () => { m++; return { steps: [], why: 'his rule', by: 'model', settled: [{ step: 'user_browser', rule: RULE }] } } })
    expect((await checkCached(vp.id, 'Restart the extension.', same, NOW)).steps).toEqual([])
    expect(m).toBe(2)
  })

  it('the cached verdict keeps the rule it was settled by', async () => {
    const rule = { step: 'user_browser' as const, rule: 'Run commands, logins, sudo, 2FA and confirm pages on his machines yourself.' }
    const check = checkStepOf({ checkStep: async () => ({ steps: [], why: 'his rule', by: 'model', settled: [rule] }) })
    expect((await checkCached(vp.id, 'Reconnect the browser extension yourself.', check, NOW)).settled).toEqual([rule])
    // Read back from the cache, the rule is still there.
    const again = await checkCached(vp.id, 'Reconnect the browser extension yourself.', async () => { throw new Error('not called') }, NOW)
    expect(again.settled).toEqual([rule])
  })
})

describe('a rewritten card that still lacks what was asked gets one more correction', () => {
  const card = (askId: string, reply: string, at: string): ReflectionThread[] => [{ id: 'th-card01', title: 'Reply to the reporter', state: 'needs', closed: false, replyAt: at, replySid: 'sess-vp', reply, options: [], askId, messages: [] } as never]
  const run = async (threads: ReflectionThread[], nowMs: number) => {
    const sent: string[] = []
    // The node's own chat cap is another brake (state.ts takeChatSend): out of the way here.
    await updateReflectionState(vp.id, (s) => { delete s.lastChatSendAt }, nowMs)
    await reflectForNode(vp, 'Marina VP', [vp], {
      readTranscript: async () => [] as never, readMessages: async () => [], readThreads: async (id) => (id === vp.id ? threads : []),
      callModel: async (system) => (system === TAKEN_UP_SYSTEM ? '{"done":[]}' : JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: { kind: 'unclear_ask', session_quote: 'Reply to the reporter now?', user_quote: '', rule_quote: '', what_went_wrong: 'No link.', correct_action: 'Add the link.', already_fixed: false, correction: 'Put the full link of the issue on the card.', guidance: '', same_as: 0, skill: null } })),
      checkStep: async () => ({ steps: [], why: '', by: 'model' }),
      send: async (_t, text) => { sent.push(text); return true }, confirmSend: async () => true, rulesText: async () => '', replyLanguage: async () => null, nowMs: () => nowMs,
    })
    return sent
  }

  it('rewritten and still lacking: sent once more; rewritten again within the gap: not a third time; not rewritten: not again', async () => {
    expect(await run(card('ask-1', 'Reply to the reporter now? (no link)', iso(10)), NOW)).toHaveLength(1)
    // Not rewritten since (the same card): not again.
    expect(await run(card('ask-1', 'Reply to the reporter now? (no link)', iso(10)), NOW + 5 * 60_000)).toHaveLength(0)
    // Its time moved but not its words (a new decision id, a touch): not a rewrite, not again.
    expect(await run(card('ask-1b', 'Reply to the reporter now? (no link)', new Date(NOW + 4 * 60_000).toISOString()), NOW + 8 * 60_000)).toHaveLength(0)
    // Rewritten after the correction, still with no link: once more.
    expect(await run(card('ask-2', 'Reply to the reporter now? I updated the card.', new Date(NOW + 5 * 60_000).toISOString()), NOW + 10 * 60_000)).toHaveLength(1)
    // Rewritten again, still lacking: the gap's two are spent.
    expect(await run(card('ask-3', 'Reply to the reporter now? Updated again.', new Date(NOW + 20 * 60_000).toISOString()), NOW + 25 * 60_000)).toHaveLength(0)
  })
})

describe('the judge reads what other agents told the session since the moment', () => {
  const WITHDRAWN = 'The widened rule for the staging accounts was withdrawn and never committed.'
  const judgeOf = async (threads: ReflectionThread[], tasks: Task[], transcript: unknown[], messages: Array<{ id: string; at: string; text: string }> = []) => {
    const prompts: string[] = []
    await reflectForNode(vp, 'Marina VP', tasks, {
      readTranscript: async () => transcript as never, readMessages: async () => messages, readThreads: async (id) => (id === vp.id ? threads : []),
      callModel: async (_system, user) => { prompts.push(user); return JSON.stringify({ verdict: 'fine', why: 'withdrawn since' }) },
      checkStep: async () => ({ steps: [], why: '', by: 'model' }),
      send: async () => true, confirmSend: async () => true, rulesText: async () => '', replyLanguage: async () => null, nowMs: () => NOW,
    })
    const p = prompts.find((x) => x.includes('LATER ('))
    return p ? p.slice(p.indexOf('LATER (')) : ''
  }

  it('a thread moment: the node session\'s agent mail since is in LATER (the 11-27 case)', async () => {
    const threads: ReflectionThread[] = [{ id: 'th-aa0001', title: 'Rule 25', messages: [
      { id: 'tm-aa0010', at: iso(30), text: 'why is this still open', sid: 'sess-vp', answer: { text: 'I will widen the rule.', at: iso(29) } },
    ] }]
    const later = await judgeOf(threads, [vp], [{ role: 'user', sentBy: 'agent', text: WITHDRAWN, timestamp: iso(20) }, { role: 'assistant', text: 'About another thread.', timestamp: iso(19) }])
    expect(later).toContain(WITHDRAWN)
    // The node's own turns are about many threads: never read as this thread's later turns.
    expect(later).not.toContain('About another thread.')
  })

  it('a task moment: its session\'s turns and agent mail since are in LATER', async () => {
    const worker = { id: 'w-1', title: 'Rule 25', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1', parent_task_id: vp.id } as Task
    const msgs = [{ id: 'm-1', at: iso(60), text: 'why is this still open' }]
    const transcript = [
      { role: 'assistant', text: 'I will widen the rule.', timestamp: iso(61) },
      { role: 'user', text: msgs[0].text, timestamp: msgs[0].at, sentBy: 'person' },
      ...[50, 45, 40].map((m) => ({ role: 'assistant', text: `Working on it (${m}).`, timestamp: iso(m) })),
      { role: 'user', sentBy: 'agent', text: WITHDRAWN, timestamp: iso(20) },
    ]
    expect(await judgeOf([], [vp, worker], transcript, msgs)).toContain(WITHDRAWN)
  })
})

describe('LATER is not crowded out, and the reflection is not its own proof', () => {
  const T = (role: string, text: string, min: number, sentBy?: string) => ({ role, text, timestamp: iso(min), ...(sentBy ? { sentBy } : {}) })
  it('the session\'s turns and agent mail are taken apart: two notices after the fix leave the fix in', async () => {
    const tr = [T('assistant', 'Fixed: the link is on the card now.', 20), T('user', 'Notice one.', 15, 'agent'), T('user', 'Notice two.', 14, 'agent')]
    const later = await turnsSince('s', iso(30), async () => tr as never, 2, 3)
    expect(later.map((t) => t.text)).toEqual(['Fixed: the link is on the card now.', 'Notice one.', 'Notice two.'])
  })
  it('the reflection\'s own earlier correction is not read as mail', async () => {
    const tr = [T('user', "Marina VP's reflection looked at your recent turn and found a decision to fix. Put the link on the card.", 15, 'agent')]
    expect(await turnsSince('s', iso(30), async () => tr as never, 2, 3)).toEqual([])
  })
  it('a done item that quotes the correction itself proves nothing', async () => {
    const C = 'Put the full link of the issue on the card.'
    const later = [{ role: 'agent' as const, at: iso(10), text: `Earlier note: ${C}` }]
    expect(await takenUp([C], later, async () => JSON.stringify({ done: [{ n: 1, quote: C }] }), 'n')).toEqual([])
  })
})
