/**
 * The step check (src/core/org/reflection/step-gate.ts), 2026-11-25 audit: a prompt rule alone let two
 * corrections send sessions to the user's Chrome and sign-ins; one submitted a change in a cloud test
 * stage with his login. Every correction, held correction and lesson passes a check in code now.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { defaultDeps, reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import type { ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { readDayEntries } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { gateText, gatedByWords, readGateAnswer, GATE_SYSTEM, type StepCheck } from '../../../src/core/org/reflection/step-gate.js'
import { tellHeldLines } from '../../../src/core/org/reflection/guidance-tidy.js'
import { guidanceFileOf, renderGuidance, readGuidance } from '../../../src/core/org/reflection/records.js'
import { sendHeld, stillNeeded } from '../../../src/core/org/reflection/held-corrections.js'
import { backfillDropped, droppedLessons, BACKFILL_DAYS } from '../../../src/core/org/reflection/guidance-merge.js'
import { reflectionDayJsonOf } from '../../../src/core/org/reflection/records.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const worker = { id: 'w-1', title: 'Reopen the test stage', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1' } as Task
const BEFORE = 'Put a card up for him to reopen the stage.'

// Test data in the reply language of the real case, written as escapes: "In the test stage, set the
// weight to 100% yourself with walnut browser" (as the 11-25 correction said it).
const BROWSER_ZH = '\u81ea\u5df1\u7528 walnut browser \u5728\u6d4b\u8bd5\u9636\u6bb5\u628a\u6743\u91cd\u8bbe\u4e3a 100%\uff0c\u8bfb\u56de\u5f00\u5173\u5df2\u6253\u5f00\u3002'
// "After the browser reconnects, delete that sentence from the published comment yourself": no English tool name.
const COMMENT_ZH = '\u6d4f\u89c8\u5668\u91cd\u8fde\u540e\u81ea\u5df1\u5220\u6389\u5df2\u53d1\u5e03\u8bc4\u8bba\u91cc\u7684\u90a3\u53e5\u3002'

const answer = (over: Record<string, unknown> = {}) => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'question_not_for_user', session_quote: BEFORE, user_quote: 'why do you ask me this', rule_quote: '', what_went_wrong: 'The card asked him for a step.',
  correct_action: BROWSER_ZH, already_fixed: false, correction: `Take the card down. ${BROWSER_ZH}`,
  guidance: 'Reopen a test stage yourself with walnut browser.', same_as: 0, skill: null, ...over,
} })

const threads: ReflectionThread[] = [{ id: 'th-aa0001', title: 'Reopen the stage', messages: [
  { id: 'tm-aa0010', at: iso(100), text: 'why do you ask me this', sid: 'sess-vp', answer: { text: BEFORE, at: iso(99) } },
] }]

function deps(over: Partial<ReflectDeps> & { answerText?: string } = {}) {
  const sent: Array<{ task: string; text: string; title: string }> = []
  const d: ReflectDeps = {
    readTranscript: async () => [{ role: 'assistant', text: BEFORE, timestamp: iso(200) }] as never,
    readMessages: async () => [],
    readThreads: async (id) => (id === vp.id ? threads : []),
    callModel: async () => over.answerText ?? answer(),
    send: async (task, text, title) => { sent.push({ task: task.id, text, title }); return true },
    confirmSend: async () => true,
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, sent }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
})

describe('the fixed words', () => {
  it('hold the user\'s browser and the sign-in commands in any language around them', () => {
    expect(gatedByWords(BROWSER_ZH)?.steps).toEqual(['user_browser'])
    expect(gatedByWords('Finish the sign-in with `walnut browser fill-login` / `fill-code` in his Chrome.')?.steps).toEqual(expect.arrayContaining(['user_browser', 'user_account']))
    expect(gatedByWords('Open the page in the user\'s own browser.')?.steps).toEqual(['user_browser'])
    expect(gatedByWords('Rewrite the card: the recommendation first, then the two buttons.')).toBeNull()
    expect(gatedByWords(COMMENT_ZH)).toBeNull()
  })
})

describe('the model layer', () => {
  it('reads the text in any language, and holds it when the call fails or its answer cannot be read', async () => {
    const asked: string[] = []
    const says = (raw: string) => async (system: string, user: string) => { expect(system).toBe(GATE_SYSTEM); asked.push(user); return raw }
    expect((await gateText(COMMENT_ZH, says('{"steps":["user_browser","in_his_name"],"why":"edits his comment"}'))).steps).toEqual(['user_browser', 'in_his_name'])
    expect(asked[0]).toContain(COMMENT_ZH)
    expect((await gateText('Rewrite the card.', says('{"steps":[],"why":"a card edit"}'))).steps).toEqual([])
    // No verdict is never a step it does not hold: the caller sends nothing now and checks again later.
    for (const g of [await gateText('Rewrite the card.', says('no json here')), await gateText('Rewrite the card.', async () => { throw new Error('throttled') })]) {
      expect(g.by).toBe('failed')
      expect(g.steps).toEqual([])
    }
    expect(readGateAnswer('{"steps":["something_else"]}')).toBeNull()
  })

  it('never calls the model for a text the fixed words hold, or an empty one', async () => {
    let calls = 0
    const m = async () => { calls++; return '{"steps":[]}' }
    expect((await gateText(BROWSER_ZH, m)).by).toBe('words')
    expect((await gateText('  ', m)).steps).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('a correction that tells a session to use his browser', () => {
  it('is never sent as written: the session gets the note to ask, the record says so, and its lesson is not written', async () => {
    const { d, sent } = deps()
    const r = await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(r.findings[0].entry?.corrected).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).not.toContain('walnut browser')
    expect(sent[0].text).not.toContain(BROWSER_ZH)
    expect(sent[0].text).toContain('ask the person your rules name')
    expect(sent[0].title).not.toContain('walnut browser')
    const e = (await readDayEntries(vp.id, localDate(NOW)))![0]
    expect(e.gated?.steps).toContain('user_browser')
    expect(e.rule.kind).toBe('none')
    expect(e.rule.text).toContain('the step check held it')
    expect(e.rule.text).not.toContain('walnut browser')
    const { nightlyLine } = await import('../../../src/core/org/reflection/nightly.js')
    expect(nightlyLine(e)).toContain('held back by the step check')
    expect(nightlyLine(e)).not.toContain(e.finding.what_went_wrong)
  })

  it('one the model layer holds (no tool name in it) goes the same way; one it passes goes as written', async () => {
    const check = (steps: string[]): StepCheck => async () => ({ steps: steps as never, why: 'x', by: 'model' })
    const held = deps({ answerText: answer({ correct_action: COMMENT_ZH, correction: COMMENT_ZH, guidance: 'Fix the comment.' }), checkStep: check(['in_his_name']) })
    await reflectForNode(vp, 'Marina VP', [vp], held.d)
    expect(held.sent[0].text).not.toContain(COMMENT_ZH)
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
    const ok = deps({ answerText: answer({ correct_action: 'Rewrite the card.', correction: 'Rewrite the card: recommendation first.', guidance: 'Put the recommendation first.' }), checkStep: check([]) })
    await reflectForNode(vp, 'Marina VP', [vp], ok.d)
    expect(ok.sent[0].text).toContain('Rewrite the card: recommendation first.')
  })

  it('held for a later send, keeps only the note, never the instruction', async () => {
    await updateReflectionState(vp.id, (s) => { s.lastChatSendAt = iso(5) }, NOW)
    const { d, sent } = deps()
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toEqual([])
    const h = (await readReflectionState(vp.id, NOW)).held!
    expect(h).toHaveLength(1)
    expect(h[0].text).not.toContain('walnut browser')
    expect(h[0].checked).toBe(true)
  })
})

describe('a check that cannot judge', () => {
  it('sends nothing of the correction and writes no lesson; the next pass with a working check sends it', async () => {
    const ok = answer({ correct_action: 'Rewrite the card.', correction: 'Rewrite the card: recommendation first.', guidance: 'Put the recommendation first.' })
    const down = deps({ answerText: ok, checkStep: async () => ({ steps: [], why: 'throttled', by: 'failed' }) })
    await reflectForNode(vp, 'Marina VP', [vp], down.d)
    expect(down.sent).toEqual([])
    const e = (await readDayEntries(vp.id, localDate(NOW)))![0]
    expect(e.held).toBe('check_failed')
    expect(e.rule.text).toContain('step_check_failed')
    expect((await readReflectionState(vp.id, NOW)).held![0].checked).toBeUndefined()
    const up = deps({ answerText: ok, checkStep: async () => ({ steps: [], why: '', by: 'model' }) })
    await reflectForNode(vp, 'Marina VP', [vp], { ...up.d, nowMs: () => NOW + 10 * 60_000 })
    expect(up.sent).toHaveLength(1)
    expect(up.sent[0].text).toContain('Rewrite the card: recommendation first.')
  })

  it('asks about the same text once: a kept verdict needs no call', async () => {
    let calls = 0
    const check: StepCheck = async () => { calls++; return { steps: [], why: '', by: 'model' } }
    const { checkCached } = await import('../../../src/core/org/reflection/step-gate.js')
    await checkCached(vp.id, 'Rewrite the card.', check, NOW)
    await checkCached(vp.id, 'Rewrite  the card.', check, NOW)
    expect(calls).toBe(1)
  })
})

describe('a skill on a listed line', () => {
  it('is checked even when its guidance line is listed already', async () => {
    const skill = { name: 'sign-in-steps', description: 'Sign in for him', text: '1. Open walnut browser and fill-login.' }
    const { d } = deps({ answerText: answer({ correct_action: 'Rewrite the card.', correction: 'Rewrite the card.', guidance: '', same_as: 1, skill }), checkStep: async () => ({ steps: [], why: '', by: 'model' }) })
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', [{ text: 'Rewrite cards so they read alone.', from: 'x', date: '2026-11-20' }]))
    await reflectForNode(vp, 'Marina VP', [vp], d)
    const e = (await readDayEntries(vp.id, localDate(NOW)))![0]
    expect(e.rule.kind).toBe('none')
    expect(e.rule.text).toContain('the step check held it')
  })
})

describe('lines already in the guidance', () => {
  it('that the check holds are named to the node once, never deleted', async () => {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', [{ text: 'Sign in for him with walnut browser.', from: 'x', date: '2026-11-20' }, { text: 'Rewrite cards so they read alone.', from: 'x', date: '2026-11-20' }]))
    const sent: string[] = []
    const d = { send: async (_t: Task, text: string) => { sent.push(text); return true }, checkStep: async () => ({ steps: [], why: '', by: 'model' as const }) }
    expect(await tellHeldLines(vp, 'Marina VP', d, NOW)).toBe(true)
    expect(sent[0]).toContain('line 1')
    expect(sent[0]).not.toContain('line 2')
    expect(sent[0]).toContain('do not report it to the user')
    expect(await tellHeldLines(vp, 'Marina VP', d, NOW)).toBe(false)
    expect((await readGuidance(vp.id))).toHaveLength(2)
  })
})

describe('held corrections kept before the check existed', () => {
  it('pass it at their send', async () => {
    await updateReflectionState(vp.id, (s) => { s.held = [{ taskId: worker.id, at: iso(30), date: localDate(NOW), entryAt: iso(30), text: `Do it yourself: ${BROWSER_ZH}` }] }, NOW)
    const { d, sent } = deps()
    await sendHeld(vp, 'Marina VP', [vp, worker], new Set(), d, NOW)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).not.toContain('walnut browser')
    expect(sent[0].text).toContain('ask the person your rules name')
  })

  it('the ones the session took up since are dropped, said in the record; a check that cannot be read sends them all', async () => {
    const items = [1, 2].map((i) => ({ taskId: worker.id, at: iso(60), date: localDate(NOW), entryAt: iso(60), text: `Point ${i}.`, checked: true as const }))
    const later = async () => [{ role: 'assistant', text: 'Answered point 1 in full.', timestamp: iso(10) }] as never
    const r = await stillNeeded(items, 'sess-1', { readTranscript: later, callModel: async () => '{"done":[1]}' }, vp.id)
    expect(r.keep.map((h) => h.text)).toEqual(['Point 2.'])
    expect((await stillNeeded(items, 'sess-1', { readTranscript: later, callModel: async () => 'x' }, vp.id)).keep).toHaveLength(2)
    expect((await stillNeeded(items, 'sess-1', { readTranscript: async () => [] as never, callModel: async () => '{"done":[1,2]}' }, vp.id)).keep).toHaveLength(2)
  })
})

describe('the same card', () => {
  const card = (msgs: ReflectionThread['messages']): ReflectionThread[] => [{ id: 'th-card01', title: 'Send the reply', state: 'needs', closed: false, replyAt: iso(40), replySid: 'sess-vp', reply: 'Send it?', options: [], messages: msgs } as never]
  it('is corrected again only after a while, unless he wrote about it since', async () => {
    const first = deps({ readThreads: async (id) => (id === vp.id ? card([]) : []) })
    await reflectForNode(vp, 'Marina VP', [vp], { ...first.d, checkStep: async () => ({ steps: [], why: '', by: 'model' }), callModel: async () => answer({ correct_action: 'Add the draft.', correction: 'Add the draft to the card.', guidance: '', user_quote: '', session_quote: 'Send it?' }) })
    expect(first.sent).toHaveLength(1)
    const again = { replyAt: new Date(NOW + 2 * 3600_000).toISOString() }
    const second = deps({ readThreads: async (id) => (id === vp.id ? [{ ...card([])[0], ...again, reply: 'Send it? (rewritten)' }] : []) })
    await reflectForNode(vp, 'Marina VP', [vp], { ...second.d, nowMs: () => NOW + 3 * 3600_000, checkStep: async () => ({ steps: [], why: '', by: 'model' }), callModel: async () => answer({ correct_action: 'Add the draft.', correction: 'Add the draft to the card.', guidance: '', user_quote: '', session_quote: 'Send it?' }) })
    expect(second.sent).toEqual([])
    expect((await readDayEntries(vp.id, localDate(NOW)))!.some((e) => e.notSent === 'card_corrected')).toBe(true)
    // He wrote about it since: corrected again (past the chat's hour).
    const his = [{ id: 'tm-card10', at: new Date(NOW + 3.2 * 3600_000).toISOString(), text: 'where is the draft' }]
    const third = deps({ readThreads: async (id) => (id === vp.id ? [{ ...card(his)[0], replyAt: new Date(NOW + 3.3 * 3600_000).toISOString(), reply: 'Send it? (again)' }] : []) })
    await reflectForNode(vp, 'Marina VP', [vp], { ...third.d, nowMs: () => NOW + 4 * 3600_000, checkStep: async () => ({ steps: [], why: '', by: 'model' }), callModel: async () => answer({ correct_action: 'Add the draft.', correction: 'Add the draft to the card.', guidance: '', user_quote: '', session_quote: 'Send it?' }) })
    expect(third.sent).toHaveLength(1)
  })
})

describe('the lesson backlog', () => {
  it('keeps a lesson with his own words past the backfill window, his first; a lesson the check holds is never written', async () => {
    const day = (daysAgo: number) => localDate(NOW - daysAgo * 24 * 3600_000)
    const entry = (text: string, quote: string) => ({ at: iso(0), signal: 'frustration', task: { id: worker.id, title: worker.title }, corrected: 'sent',
      finding: { ...JSON.parse(answer()).finding, guidance: text, user_quote: quote }, rule: { kind: 'none', text: `not added (day_full): ${text}` } })
    const write = async (date: string, entries: unknown[]) => {
      const f = reflectionDayJsonOf(vp.id, date)
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify({ schemaVersion: 1, nodeId: vp.id, nodeName: 'Marina VP', date, entries }))
    }
    await write(day(BACKFILL_DAYS + 3), [entry('Make the ack button blue.', 'Ack button should be blue'), entry('An old lesson of nobody.', '')])
    await write(day(1), [entry('Open his account yourself with walnut browser.', 'do it'), entry('A new lesson.', '')])
    const all = await droppedLessons(vp.id, NOW)
    expect(all.map((l) => l.text)).toEqual(['Make the ack button blue.', 'Open his account yourself with walnut browser.', 'A new lesson.'])
    await backfillDropped(vp, 'Marina VP', { callModel: async () => '{}', replyLanguage: async () => null }, NOW)
    const { readGuidance } = await import('../../../src/core/org/reflection/records.js')
    const lines = (await readGuidance(vp.id)).map((l) => l.text)
    expect(lines).toContain('Make the ack button blue.')
    expect(lines.some((l) => l.includes('walnut browser'))).toBe(false)
  })
})

describe('waiting lessons said elsewhere already', () => {
  it('leave the queue once a day, by one call that reads the lines, his rules and the org skills; the tidy note says it is routine', async () => {
    const { settleCovered, tidyNote } = await import('../../../src/core/org/reflection/guidance-tidy.js')
    const asked: string[] = []
    const d = { send: async () => true, userRules: async () => 'Any choice put to him comes with your pick first.',
      orgSkills: async () => [{ name: 'self-explaining-ask-check', description: 'An ask card reads on its own.' }],
      callModel: async (_s: string, user: string) => { asked.push(user); return '{"covered":[1],"same":[3]}' } }
    const waiting = ['Put the recommendation first in a choice.', 'Dates in his own time zone.', 'Show dates in his time zone.']
    const out = await settleCovered(vp, waiting, ['A line.'], d as never, NOW)
    expect(out).toEqual(['Put the recommendation first in a choice.', 'Show dates in his time zone.'])
    expect(asked[0]).toContain('Any choice put to him comes with your pick first.')
    expect(asked[0]).toContain('self-explaining-ask-check')
    expect((await readReflectionState(vp.id, NOW)).covered).toHaveLength(2)
    expect(await settleCovered(vp, waiting, ['A line.'], d as never, NOW + 60_000)).toEqual([])
    expect(asked).toHaveLength(1)
    expect(tidyNote('/x/guidance.md', -10, ['A lesson.'])).toContain('do not report it to the user')
  })
})

describe('every way out of the reflection passes the step check (ratchet)', () => {
  it('the real dependencies wire the model layer', () => {
    expect(typeof defaultDeps().checkStep).toBe('function')
  })

  // Each file that sends to a session, and how what it sends is checked. A new send site fails here
  // until it says how its text passes the check.
  const SENDS: Record<string, string> = {
    'pipeline.ts': 'corrections: gateText on the instruction, the lesson gated too',
    'held-corrections.ts': 'held texts: checked when held, or at their send',
    'guidance-tidy.ts': 'the waiting lessons listed for the tidy: the fixed words drop held ones',
    'guidance-align.ts': 'names guidance lines that go against his rules: no instruction of its own',
    'nightly.ts': 'the day record to the node itself: findings are named, held instructions marked held back',
    'pains.ts': 'the pain registry summary: his complaints, no instruction',
  }
  it('names every file that calls send', () => {
    const dir = path.join(process.cwd(), 'src/core/org/reflection')
    const senders = readdirSync(dir).filter((f) => f.endsWith('.ts') && /\bdeps\.send\(|\bsend\(\s*(?:node|task|c\.task|task!)/.test(readFileSync(path.join(dir, f), 'utf-8')))
    expect(senders.filter((f) => !(f in SENDS))).toEqual([])
  })
})
