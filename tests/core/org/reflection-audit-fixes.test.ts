/**
 * What the first independent audit of the reflection found (2026-11-23, Reflection VP) and how each
 * is held: a correction not sent says why, and one whose task moved to a new session reaches that
 * session; the day's judge budget carries its leftovers for later passes and the day's record says
 * so; a node starts with more judge calls and eases down; his words are recorded as written (a
 * question stays a question) and the judge is told a question is no instruction; a full guidance
 * is the node's to tidy, told once a day which lessons wait; the hint has room for a full guidance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-audit-fixes'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { appendDayEntry, guidanceFileOf, readDayEntries, reflectionDayFileOf, renderGuidance } from '../../../src/core/org/reflection/records.js'
import { DAILY_CALLS_EASE_DAYS, DAILY_CALLS_MAX, DAILY_CALLS_START, dailyCallsMax, localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { JUDGE_SYSTEM, quoteAsWritten, verifyFinding } from '../../../src/core/org/reflection/judge.js'
import { askTidy } from '../../../src/core/org/reflection/guidance-tidy.js'
import { guidanceRoomLeft } from '../../../src/core/org/reflection/team-guidance-hint.js'

const NOW = Date.parse('2026-11-23T20:00:00Z')
const DAY = 24 * 3600_000
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const worker = { id: 'w-1', title: 'Upgrade the dock page', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1' } as Task
const BEFORE = 'Shipped the new card layout.'

const answer = () => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'regression', session_quote: BEFORE, user_quote: 'used to show', rule_quote: '', what_went_wrong: 'The card lost its reply.',
  correct_action: 'Bring the reply back.', already_fixed: false, correction: 'Bring the reply back under the card.',
  guidance: '', same_as: 0, skill: null,
} })

function deps(over: Partial<ReflectDeps> & { messages?: Array<{ id: string; at: string; text: string }> } = {}) {
  const sent: Array<{ task: string; text: string; title: string }> = []
  const d: ReflectDeps = {
    readTranscript: async () => [
      { role: 'assistant', text: BEFORE, timestamp: iso(200) },
      ...(over.messages ?? []).map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
    ] as never,
    readMessages: async (id) => (id === worker.id ? over.messages ?? [] : []),
    readThreads: async () => [],
    callModel: async () => answer(),
    send: async (task, text, title) => { sent.push({ task: task.id, text, title }); return true },
    confirmSend: async () => 'ok',
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, sent }
}
const broke = [{ id: 'm1', at: iso(30), text: 'the reply used to show under the card' }]

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(3 * 24 * 60) }, NOW)
})

describe('a correction', () => {
  it('whose task moved to another session reaches that session, told it is about an earlier one', async () => {
    const { d, sent } = deps({ messages: broke, confirmSend: async () => 'session_changed' })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('a turn of an earlier session of this task')
    const [e] = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(e).toMatchObject({ corrected: 'sent', earlierSession: true })
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('sent to the task\'s current session (the turn was in an earlier one)')
  })

  it('not sent says why, in the JSON and the Markdown', async () => {
    const { d, sent } = deps({ messages: broke, confirmSend: async () => 'task_done' })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(sent).toHaveLength(0)
    const [e] = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(e).toMatchObject({ corrected: 'off', notSent: 'task_done' })
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('not sent (the task is complete)')
  })
})

describe('the judge budget', () => {
  it('starts high and eases down to the settled cap', () => {
    const from = new Date(NOW).toISOString()
    expect(dailyCallsMax(undefined, NOW)).toBe(DAILY_CALLS_START)
    expect(dailyCallsMax(from, NOW)).toBe(DAILY_CALLS_START)
    expect(dailyCallsMax(from, NOW + (DAILY_CALLS_EASE_DAYS / 2) * DAY)).toBe((DAILY_CALLS_START + DAILY_CALLS_MAX) / 2)
    expect(dailyCallsMax(from, NOW + DAILY_CALLS_EASE_DAYS * DAY)).toBe(DAILY_CALLS_MAX)
    expect(DAILY_CALLS_START).toBeGreaterThan(DAILY_CALLS_MAX)
  })

  it('a node\'s first pass starts its high days; a spent day is said once in the record, and yesterday\'s moments wait', async () => {
    const { d } = deps({ messages: [{ id: 'y', at: iso(26 * 60), text: 'the tab used to show' }, ...broke] })
    await updateReflectionState(vp.id, (s) => { s.day = { date: localDate(NOW), calls: DAILY_CALLS_START } }, NOW)
    const r = await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(r.judged).toBe(0)
    const s = await readReflectionState(vp.id, NOW)
    expect(s.callsFrom).toBe(new Date(NOW).toISOString())
    // Yesterday's moment is not dropped: it waits for a later pass.
    expect(s.seen['msg:w-1:y']).toBeUndefined()
    expect(s.day.budgetDropped).toBeUndefined()
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    const md = await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')
    expect(md.match(/> Note: The day's \d+ judge calls are spent/g)).toHaveLength(1)
    expect(md).toContain('2 moments wait for a later pass')
  })
})

describe('his words', () => {
  // "everything has to be round?" in Chinese, with the sentence-final particle and a full-width question mark.
  const said = '\u4ec0\u4e48\u9b3c\u4e1c\u897f\u90fd\u8981\u662f\u5706\u5f62\u7684\u5440\uff1f\u6240\u6709\u4e1c\u897f\u90fd\u5e94\u8be5\u7edf\u4e00\u554a'

  it('are recorded as he wrote them: a question keeps its mark', () => {
    expect(quoteAsWritten('\u90fd\u8981\u662f\u5706\u5f62\u7684', said)).toBe('\u90fd\u8981\u662f\u5706\u5f62\u7684\u5440\uff1f')
    expect(quoteAsWritten('did it SHOW', 'Why did it show twice? Fix it')).toBe('did it show')
    expect(quoteAsWritten('it show twice', 'Why did it show twice? Fix it')).toBe('it show twice?')
    expect(quoteAsWritten('not in there at all', said)).toBe('not in there at all')
  })

  it('a finding quotes them as written, and the judge is told a question is no instruction', () => {
    const raw = JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
      kind: 'built_different', session_quote: BEFORE, user_quote: '\u4ec0\u4e48\u9b3c\u4e1c\u897f\u90fd\u8981\u662f\u5706\u5f62\u7684', rule_quote: '', what_went_wrong: 'w', correct_action: 'c',
      already_fixed: false, correction: 'c', guidance: '', same_as: 0, skill: null,
    } })
    const v = verifyFinding(raw, { signal: 'built_different', sessionText: BEFORE, userText: said, rulesText: '', guidance: [] })
    expect(v.verdict === 'bad_decision' && v.finding.user_quote).toBe('\u4ec0\u4e48\u9b3c\u4e1c\u897f\u90fd\u8981\u662f\u5706\u5f62\u7684\u5440\uff1f')
    expect(JUDGE_SYSTEM).toContain('a question or a complaint')
    expect(JUDGE_SYSTEM).toContain('is not an instruction')
  })
})

describe('a full guidance', () => {
  const long = (i: number) => `Rule number ${i}: ${'keep every point of the old line and its condition '.repeat(4)}`.slice(0, 240)

  it('has room in the hint for a dozen lines of a usual length', () => {
    expect(guidanceRoomLeft('Marina VP', Array.from({ length: 12 }, (_, i) => long(i).slice(0, 150)))).toBeGreaterThan(0)
  })

  it('is the node\'s to tidy: told once a day which lessons wait, never when there is room or nothing waits', async () => {
    await fs.mkdir(guidanceFileOf(vp.id).replace(/\/[^/]+$/, ''), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', Array.from({ length: 16 }, (_, i) => ({ text: long(i), from: 'a task', date: '2026-11-20' }))))
    const sent: string[] = []
    const send = async (_t: Task, text: string) => { sent.push(text); return true }
    expect(await askTidy(vp, 'Marina VP', { send }, NOW)).toBe(false)
    const waiting = 'Name the thread a card asks him to answer in.'
    await appendDayEntry(vp.id, 'Marina VP', localDate(NOW), {
      at: iso(10), signal: 'frustration', task: { id: worker.id, title: worker.title },
      finding: { kind: 'unclear_ask', session_quote: 'q', user_quote: 'u', rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: '', guidance: waiting, same_as: 0, skill: null },
      corrected: 'already_fixed', rule: { kind: 'none', text: `not added (day_full; not merged: x): ${waiting}` },
    })
    expect(await askTidy(vp, 'Marina VP', { send }, NOW)).toBe(true)
    expect(sent[0]).toContain(`- ${waiting}`)
    expect(sent[0]).toContain(guidanceFileOf(vp.id))
    expect(await askTidy(vp, 'Marina VP', { send }, NOW + 60_000)).toBe(false)
    expect(sent).toHaveLength(1)
  })
})
