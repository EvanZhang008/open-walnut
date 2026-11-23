/**
 * A lesson that finds the team guidance full is merged into the closest line instead of dropped
 * (src/core/org/reflection/guidance-merge.ts; 2026-11-21: on 11-20 a VP's reflection dropped 14
 * lessons as "not added (day_full)" and the same mistakes came back that day). The rewrite keeps the
 * old line's words and the lesson's, never touches the user's own line, keeps the old text as the
 * undo, the same lesson twice costs one call, and lessons dropped before are taken up again without
 * one bad lesson holding up the rest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-guidance-merge'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { addGuidance, appendDayEntry, guidanceFileOf, readDayEntries, readGuidance, reflectionDayFileOf, renderGuidance, GUIDANCE_LINES_MAX, GUIDANCE_NEW_PER_DAY_MAX, type DayEntry } from '../../../src/core/org/reflection/records.js'
import { backfillDropped, mergeGuidance, readMerge, BACKFILL_CALLS_PER_DAY_MAX, MERGE_CALLS_PER_DAY_MAX, MERGES_SPENT, ROOM_SPENT, type MergeDeps } from '../../../src/core/org/reflection/guidance-merge.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { guidanceRoomLeft, teamGuidanceText } from '../../../src/core/org/reflection/team-guidance-hint.js'
import { rememberDeletedGuidance } from '../../../src/core/org/reflection/pipeline.js'

const NOW = Date.parse('2026-11-19T20:00:00Z')
const DAY = localDate(NOW)
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const worker = { id: 'w-1', title: 'Upgrade the dock page', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1' } as Task
const BEFORE = 'Shipped the new card layout.'
const ASK = 'Before asking the user anything, check whether it is his to decide.'
const OTHER = 'Answer his question first, then the rest.'
const LESSON = 'A step that follows from what he already agreed to is yours: do it and tell him.'
const MERGED = `${ASK} A step that follows from what he already agreed to is yours: do it and tell him.`

/** Today's new lines already spent: the guidance holds two lines, both of today, and the cap is reached. */
async function fullDay(): Promise<void> {
  await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
  const texts = [ASK, OTHER, 'Show a picture over a block of text.', 'Name the file a report is in.', 'Say when a status was checked.', 'Keep a decision card to one ask.', 'Quote his words exactly.', 'Close what he acknowledged.']
  const lines = texts.slice(0, GUIDANCE_NEW_PER_DAY_MAX).map((text) => ({ text, from: 'x', date: DAY }))
  await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines))
}

const finding = (over: Record<string, unknown> = {}) => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'question_not_for_user', session_quote: BEFORE, user_quote: 'why ask me', rule_quote: '', what_went_wrong: 'It asked him a step he had agreed to.',
  correct_action: 'Do it and tell him.', already_fixed: false, correction: 'Do the step he agreed to.', guidance: LESSON, same_as: 0, skill: null, pain: null, ...over,
} })

function deps(answers: string[], messages = [{ id: 'u1', at: iso(100), text: 'why ask me again, just do it' }]) {
  const calls: Array<{ system: string; user: string }> = []
  const d: ReflectDeps = {
    readTranscript: async () => [
      { role: 'assistant', text: BEFORE, timestamp: iso(200) },
      ...messages.map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
    ] as never,
    readMessages: async (id) => (id === worker.id ? messages : []),
    readThreads: async () => [],
    callModel: async (system, user) => { calls.push({ system, user }); return answers.shift() ?? '{}' },
    send: async () => true,
    confirmSend: async () => true,
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
  }
  return { d, calls }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
})

describe('a lesson on a full day', () => {
  it('is merged into the closest line: the count stays, the old line\'s words stay, and the day record names it', async () => {
    await fullDay()
    const before = await readGuidance(vp.id)
    const { d, calls } = deps([finding(), JSON.stringify({ line: 1, text: MERGED })])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    const after = await readGuidance(vp.id)
    expect(after).toHaveLength(before.length)
    expect(after[0].text).toBe(MERGED)
    expect(after[0].text).toContain(ASK)
    expect(after.slice(1).map((l) => l.text)).toEqual(before.slice(1).map((l) => l.text))
    expect(calls[1].user).toContain(`1. ${ASK}`)
    expect(calls[1].user).toContain(LESSON)
    expect((await readDayEntries(vp.id, DAY))![0].rule).toMatchObject({ kind: 'guidance', text: MERGED, line: 1, was: ASK })
    // The old text is the undo, in the Markdown record too; the merged line keeps the old line's date.
    expect(await fs.readFile(reflectionDayFileOf(vp.id, DAY), 'utf-8')).toContain(`(merged; was: ${ASK})`)
    expect(after[0].date).toBe(before[0].date)
    // The merged line is the reflection's own: deleting it later is remembered.
    expect((await readReflectionState(vp.id, NOW)).written).toContain(MERGED.toLowerCase())
  })

  it('a rewrite that would lose what the line said is refused: nothing changes and the record says why', async () => {
    await fullDay()
    const { d } = deps([finding(), JSON.stringify({ line: 1, text: 'Do it.' })])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect((await readGuidance(vp.id))[0].text).toBe(ASK)
    expect((await readDayEntries(vp.id, DAY))![0].rule.text).toMatch(/not added \(day_full; not merged: the rewrite drops what the line said\)/)
  })

  it('a line that already says it is pointed at, with nothing written', async () => {
    await fullDay()
    const { d } = deps([finding(), JSON.stringify({ same: 1 })])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect((await readGuidance(vp.id))[0].text).toBe(ASK)
    expect((await readDayEntries(vp.id, DAY))![0].rule).toMatchObject({ kind: 'existing', line: 1 })
  })

  it('the same lesson written twice adds one line, and the second is known with no merge call', async () => {
    const r1 = await addGuidance(vp.id, 'Marina VP', { text: LESSON, from: 'x', date: DAY }, { removed: [], addedToday: 0 })
    const r2 = await addGuidance(vp.id, 'Marina VP', { text: `  ${LESSON.toUpperCase()} `, from: 'y', date: DAY }, { removed: [], addedToday: 3 })
    expect([r1, r2]).toEqual(['added', 'known'])
    expect(await readGuidance(vp.id)).toHaveLength(1)
  })
})

describe('the merge answer', () => {
  const lines = [{ text: ASK }, { text: OTHER }]
  it('is read only when it names a line and keeps what it said', () => {
    expect(readMerge('{"line": 1, "text": "' + MERGED + '"}', lines, LESSON)).toMatchObject({ kind: 'merged', line: 1, was: ASK })
    expect(readMerge('{"line": 9, "text": "x"}', lines, LESSON).kind).toBe('failed')
    expect(readMerge('no json', lines, LESSON).kind).toBe('failed')
    expect(readMerge(JSON.stringify({ line: 2, text: LESSON }), lines, LESSON)).toMatchObject({ kind: 'failed', why: 'the rewrite drops what the line said' })
    expect(readMerge('{"same": 2}', lines, LESSON)).toEqual({ kind: 'same', line: 2, text: OTHER })
  })
})

describe('lessons a full day dropped before', () => {
  it('are taken up again from the day records, each once', async () => {
    await fs.mkdir(path.dirname(reflectionDayFileOf(vp.id, DAY)), { recursive: true })
    const earlier = localDate(NOW - 24 * 3600_000)
    await fs.writeFile(reflectionDayFileOf(vp.id, earlier), [
      '## 10:00 A task (t-1)', `- Rule: none (not added (day_full): ${LESSON})`, '',
      '## 11:00 A task (t-2)', `- Rule: none (not added (file_full): ${OTHER})`, '',
      '## 12:00 A task (t-3)', `- Rule: guidance line 1: ${ASK}`, '',
    ].join('\n'))
    const md: MergeDeps = { callModel: async () => '{}', replyLanguage: async () => null }
    expect(await backfillDropped(vp, 'Marina VP', md, NOW)).toBe(2)
    expect((await readGuidance(vp.id)).map((l) => l.text)).toEqual([LESSON, OTHER])
    expect(await backfillDropped(vp, 'Marina VP', md, NOW)).toBe(0)
    expect(await readGuidance(vp.id)).toHaveLength(2)
  })

  it('on a full day are merged, and one the user deleted is never taken up', async () => {
    await fullDay()
    const earlier = localDate(NOW - 24 * 3600_000)
    await fs.mkdir(path.dirname(reflectionDayFileOf(vp.id, earlier)), { recursive: true })
    await fs.writeFile(reflectionDayFileOf(vp.id, earlier), `- Rule: none (not added (day_full): ${LESSON})\n- Rule: none (not added (day_full): Never ping a colleague in his name.)\n`)
    await updateReflectionState(vp.id, (s) => { s.removed.push('never ping a colleague in his name.') }, NOW)
    const md: MergeDeps = { callModel: async () => JSON.stringify({ line: 1, text: MERGED }), replyLanguage: async () => null }
    expect(await backfillDropped(vp, 'Marina VP', md, NOW)).toBe(1)
    expect((await readGuidance(vp.id))[0].text).toBe(MERGED)
  })
})

describe('a merge that would lose meaning is refused', () => {
  const lines = [{ text: ASK, from: 'x', date: DAY }, { text: OTHER, from: 'x', date: DAY }]
  it('the old line again, the old line plus a word, and a rewrite that keeps only the lesson', () => {
    expect(readMerge(JSON.stringify({ line: 1, text: ASK }), lines, LESSON)).toEqual({ kind: 'failed', why: 'the rewrite adds nothing to the line' })
    expect(readMerge(JSON.stringify({ line: 1, text: `${ASK} Always.` }), lines, LESSON)).toEqual({ kind: 'failed', why: 'the rewrite leaves out the lesson' })
    expect(readMerge(JSON.stringify({ line: 1, text: `Act on a step he agreed to: just do it and then tell him so.` }), lines, LESSON)).toEqual({ kind: 'failed', why: 'the rewrite drops what the line said' })
    expect(readMerge(JSON.stringify({ line: 1, text: `${MERGED} ${'x'.repeat(300)}` }), lines, LESSON).kind).toBe('failed')
  })

  it('reads CJK text by character pairs: a merge that keeps both passes, one that drops the old line does not', () => {
    // Test data: Chinese guidance lines (an old rule, a lesson and their merge), escaped.
    const oldZh = '\u5411\u7528\u6237\u5217\u5f85\u5b9a\u4e8b\u9879\u524d\uff0c\u5148\u67e5\u5b83\u7684\u5b9e\u65f6\u72b6\u6001\u3002'
    const lessonZh = '\u5df2\u7ecf\u95ee\u8fc7\u4e14\u6ca1\u6709\u53d8\u5316\u7684\uff0c\u4e0d\u8981\u91cd\u590d\u63d0\u3002'
    const zh = [{ text: oldZh, from: 'x', date: DAY }]
    expect(readMerge(JSON.stringify({ line: 1, text: oldZh + lessonZh }), zh, lessonZh).kind).toBe('merged')
    expect(readMerge(JSON.stringify({ line: 1, text: lessonZh + '\u8bb0\u4f4f\u3002' }), zh, lessonZh).kind).toBe('failed')
  })

  it('an answer with the line\'s straight quotes left unescaped is still read', () => {
    const quoted = [{ text: 'When he asks "how did you do it", answer for that example first.', from: 'x', date: DAY }]
    const raw = `{"line": 1, "text": "When he asks "how did you do it", answer for that example first. ${LESSON}"}`
    expect(readMerge(raw, quoted, LESSON)).toMatchObject({ kind: 'merged', line: 1 })
  })

  it('a lesson in another language than the line merges when the line grew by its translation', () => {
    // Test data: a Chinese line and its rewrite holding the English lesson translated, escaped.
    const oldZh = '\u63d0\u8bae\u7ed9\u67d0\u4eba\u53d1\u6d88\u606f\u4e4b\u524d\uff0c\u5148\u67e5\u5bf9\u65b9\u662f\u5426\u5df2\u7ecf\u770b\u5230\u3002'
    const added = '\u5ba1\u9605\u65f6\u6838\u5b9e\u51fa\u7684\u95ee\u9898\u76f4\u63a5\u53d1\u5728\u8be5\u6539\u52a8\u4e0a\uff0c\u4e8b\u540e\u544a\u77e5\u7528\u6237\u3002'
    const zh = [{ text: oldZh, from: 'x', date: DAY }]
    expect(readMerge(JSON.stringify({ line: 1, text: oldZh + added }), zh, LESSON).kind).toBe('merged')
    expect(readMerge(JSON.stringify({ line: 1, text: oldZh + '\u8bb0\u4f4f' }), zh, LESSON)).toEqual({ kind: 'failed', why: 'the rewrite leaves out the lesson' })
  })

  it('a line the user wrote himself is never rewritten: it may only be named the same', () => {
    expect(readMerge(JSON.stringify({ line: 1, text: MERGED }), lines, LESSON, new Set([2]))).toEqual({ kind: 'failed', why: 'line 1 is the user\'s own' })
    expect(readMerge(JSON.stringify({ same: 1 }), lines, LESSON, new Set([2])).kind).toBe('same')
  })

  it('through the pipeline the user\'s line is marked in the prompt and stays as he wrote it', async () => {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    // His own line has no "(from ...)" note; today's lines (the day's cap of them) are the reflection's.
    const own = renderGuidance('Marina VP', [{ text: ASK }, ...Array.from({ length: GUIDANCE_NEW_PER_DAY_MAX }, (_, i) => ({ text: `a${i + 1} rule here`, from: 'x', date: DAY }))])
    await fs.writeFile(guidanceFileOf(vp.id), own)
    const { d, calls } = deps([finding(), JSON.stringify({ line: 1, text: MERGED })])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(calls[1].user).toContain(`1. ${ASK} (the user's own)`)
    expect((await readGuidance(vp.id))[0].text).toBe(ASK)
    expect((await readDayEntries(vp.id, DAY))![0].rule.text).toContain('not merged: line 1 is the user\'s own')
  })
})

describe('merges and their budget', () => {
  const md = (answers: string[]) => {
    const calls: string[] = []
    return { calls, deps: { callModel: async (_s: string, user: string) => { calls.push(user); return answers.shift() ?? '{}' }, replyLanguage: async () => null } as MergeDeps }
  }
  const lesson = { text: LESSON, from: 'w', date: DAY }

  it('the same lesson twice on a full day: one call, one rewrite, the second is known', async () => {
    await fullDay()
    const m = md([JSON.stringify({ line: 1, text: MERGED }), JSON.stringify({ line: 1, text: `${MERGED} ${LESSON}` })])
    expect((await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)).kind).toBe('merged')
    expect(await mergeGuidance(vp, 'Marina VP', { ...lesson, text: ` ${LESSON.toLowerCase()}` }, m.deps, NOW)).toEqual({ kind: 'same', line: 1, text: MERGED })
    expect(m.calls).toHaveLength(1)
    expect((await readGuidance(vp.id))[0].text).toBe(MERGED)
  })

  it('a lesson merged into a line that is merged again later is still known', async () => {
    await fullDay()
    const LESSON2 = 'Show him the proof video path in the reply itself.'
    const m = md([JSON.stringify({ line: 1, text: MERGED }), JSON.stringify({ line: 1, text: `${MERGED} ${LESSON2}` })])
    await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)
    await mergeGuidance(vp, 'Marina VP', { ...lesson, text: LESSON2 }, m.deps, NOW)
    expect((await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)).kind).toBe('same')
    expect(m.calls).toHaveLength(2)
  })

  it('stops at the day\'s budget with no call, and the record says so', async () => {
    await fullDay()
    await updateReflectionState(vp.id, (s) => { s.merges = { date: DAY, count: MERGE_CALLS_PER_DAY_MAX } }, NOW)
    const { d, calls } = deps([finding()])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(calls).toHaveLength(1)
    expect((await readDayEntries(vp.id, DAY))![0].rule.text).toContain(`not merged: ${MERGES_SPENT}`)
  })

  it('a line the user edited during the call is left alone', async () => {
    await fullDay()
    const m = { callModel: async () => {
      await fs.writeFile(guidanceFileOf(vp.id), (await fs.readFile(guidanceFileOf(vp.id), 'utf-8')).replace(ASK, 'His own new words.'))
      return JSON.stringify({ line: 1, text: MERGED })
    }, replyLanguage: async () => null } as MergeDeps
    expect(await mergeGuidance(vp, 'Marina VP', lesson, m, NOW)).toEqual({ kind: 'failed', why: 'the line changed meanwhile' })
    expect((await readGuidance(vp.id))[0].text).toBe('His own new words.')
  })

  it('a full file merges through the pipeline, and the merged line keeps its old date', async () => {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    const lines = Array.from({ length: GUIDANCE_LINES_MAX }, (_, i) => ({ text: i === 0 ? ASK : `Rule number ${i} for the team`, from: 'x', date: '2026-11-01' }))
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines))
    const { d } = deps([finding(), JSON.stringify({ line: 1, text: MERGED })])
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    const after = await readGuidance(vp.id)
    expect(after).toHaveLength(GUIDANCE_LINES_MAX)
    expect(after[0]).toMatchObject({ text: MERGED, date: '2026-11-01' })
    expect((await readDayEntries(vp.id, DAY))![0].rule).toMatchObject({ kind: 'guidance', was: ASK })
  })
})

describe('the backfill never stalls on one lesson', () => {
  const BAD = 'A lesson whose merge always fails for its words.'
  async function dropped(lessons: string[]): Promise<void> {
    const earlier = localDate(NOW - 24 * 3600_000)
    await fs.mkdir(path.dirname(reflectionDayFileOf(vp.id, earlier)), { recursive: true })
    await fs.writeFile(reflectionDayFileOf(vp.id, earlier), lessons.map((l) => `- Rule: none (not added (day_full): ${l})`).join('\n') + '\n')
  }

  it('a lesson that cannot merge is tried twice in all and never holds up the one behind it', async () => {
    await fullDay()
    await dropped([BAD, LESSON])
    const calls: string[] = []
    const m: MergeDeps = { callModel: async (_s, user) => { calls.push(user.split('THE NEW LESSON:\n')[1]); return user.includes(BAD) ? 'not json' : JSON.stringify({ line: 1, text: MERGED }) }, replyLanguage: async () => null }
    expect(await backfillDropped(vp, 'Marina VP', m, NOW)).toBe(1)
    expect((await readGuidance(vp.id))[0].text).toBe(MERGED)
    for (let i = 0; i < 5; i++) await backfillDropped(vp, 'Marina VP', m, NOW + i * 300_000)
    expect(calls.filter((c) => c === BAD)).toHaveLength(2)
    expect(calls).toHaveLength(3)
    const s = await readReflectionState(vp.id, NOW)
    expect(s.backfilled).toEqual(expect.arrayContaining([BAD.toLowerCase(), LESSON.toLowerCase()]))
    expect(s.backfillTries).toEqual({})
  })

  it('takes only its share of the day\'s merges: fresh lessons keep the rest', async () => {
    await fullDay()
    await dropped([LESSON])
    await updateReflectionState(vp.id, (s) => { s.merges = { date: DAY, count: BACKFILL_CALLS_PER_DAY_MAX } }, NOW)
    const calls: string[] = []
    const m: MergeDeps = { callModel: async (_s, user) => { calls.push(user); return JSON.stringify({ line: 1, text: MERGED }) }, replyLanguage: async () => null }
    expect(await backfillDropped(vp, 'Marina VP', m, NOW)).toBe(0)
    expect(calls).toHaveLength(0)
    // Not given up: a later day takes it.
    expect((await readReflectionState(vp.id, NOW)).backfilled ?? []).toEqual([])
    expect((await mergeGuidance(vp, 'Marina VP', { text: LESSON, from: 'w', date: DAY }, m, NOW)).kind).toBe('merged')
  })

  it('reads the day\'s JSON, so a reason holding ")" still gives its lesson back', async () => {
    const earlier = localDate(NOW - 24 * 3600_000)
    const entry = {
      at: iso(24 * 60), signal: 'frustration', task: { id: 't-1', title: 'A task' }, corrected: 'off',
      finding: { kind: 'question_not_for_user', guidance: LESSON, what_went_wrong: 'x', correct_action: 'y' },
      rule: { kind: 'none', text: `not added (day_full; not merged: Error: boom (bad)): ${LESSON}` },
    } as unknown as DayEntry
    await appendDayEntry(vp.id, 'Marina VP', earlier, entry)
    const m: MergeDeps = { callModel: async () => '{}', replyLanguage: async () => null }
    expect(await backfillDropped(vp, 'Marina VP', m, NOW)).toBe(1)
    expect((await readGuidance(vp.id)).map((l) => l.text)).toEqual([LESSON])
  })
})

describe('what the sessions read', () => {
  const lesson = { text: LESSON, from: 'w', date: DAY }
  const md = (answer: string) => {
    const calls: string[] = []
    return { calls, deps: { callModel: async (_s: string, user: string) => { calls.push(user); return answer }, replyLanguage: async () => null } as MergeDeps }
  }
  async function write(lines: Array<{ text: string; from?: string; date?: string }>): Promise<void> {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines))
  }

  it('a rewrite that drops one of the old line\'s two conditions is refused', () => {
    const two = [{ text: 'Before handing him a choice, check his calendar and conflicts first, and put your pick first.', from: 'x', date: DAY }]
    const lost = 'Before handing him a choice, put your pick first and explain each term in one clause.'
    expect(readMerge(JSON.stringify({ line: 1, text: lost }), two, 'Explain each term in one clause.')).toEqual({ kind: 'failed', why: 'the rewrite drops what the line said' })
  })

  it('a merge never pushes a line out of the hint: every line still shows with the org skills named', async () => {
    // Lines that leave just under the merge's growth free.
    const filler = Array.from({ length: 8 }, (_, i) => ({ text: `Rule ${i}: ${'keep the words of this rule short and clear. '.repeat(3)}`.trim(), from: 'x', date: DAY }))
    await write([{ text: ASK, from: 'x', date: DAY }, ...filler])
    const left = guidanceRoomLeft('Marina VP', (await readGuidance(vp.id)).map((l) => l.text))
    expect(left).toBeGreaterThan(MERGED.length - ASK.length)
    const m = md(JSON.stringify({ line: 1, text: MERGED }))
    expect((await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)).kind).toBe('merged')
    expect(m.calls[0]).toContain('ROOM: the rewritten line may be at most')
    const text = teamGuidanceText({ lines: (await readGuidance(vp.id)).map((l) => l.text), node: 'Marina VP', file: '/g.md', skills: [{ name: 'a-skill', description: 'what it covers' }] })
    expect(text).not.toContain('more in /g.md')
  })

  it('when the lines fill the hint, no call is made and the record says so; a rewrite that would overflow is refused', async () => {
    const long = Array.from({ length: 26 }, (_, i) => ({ text: `Rule ${i}: ${'keep the words of this rule short and clear. '.repeat(3)}`.trim(), from: 'x', date: DAY }))
    await write([{ text: ASK, from: 'x', date: DAY }, ...long])
    expect(guidanceRoomLeft('Marina VP', (await readGuidance(vp.id)).map((l) => l.text))).toBeLessThanOrEqual(0)
    const m = md(JSON.stringify({ line: 1, text: MERGED }))
    expect(await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)).toEqual({ kind: 'failed', why: ROOM_SPENT })
    expect(m.calls).toHaveLength(0)
    // Just under full: the rewrite's growth is more than is left.
    const fit = Array.from({ length: 8 }, (_, i) => ({ text: `Rule ${i}: ${'keep the words of this rule short and clear. '.repeat(3)}`.trim(), from: 'x', date: DAY }))
    const pad = guidanceRoomLeft('Marina VP', [ASK, ...fit.map((l) => l.text)]) - 20
    await write([{ text: ASK, from: 'x', date: DAY }, ...fit, { text: 'p'.repeat(pad - 3), from: 'x', date: DAY }])
    expect((await mergeGuidance(vp, 'Marina VP', lesson, md(JSON.stringify({ line: 1, text: MERGED })).deps, NOW)).kind).toBe('failed')
    expect((await readGuidance(vp.id))[0].text).toBe(ASK)
  })

  it('guidance of only the user\'s own lines spends no call', async () => {
    await write([{ text: ASK }, { text: OTHER }])
    const m = md(JSON.stringify({ line: 1, text: MERGED }))
    expect(await mergeGuidance(vp, 'Marina VP', lesson, m.deps, NOW)).toEqual({ kind: 'failed', why: 'no line the reflection wrote' })
    expect(m.calls).toHaveLength(0)
  })

  it('a merged line the user deletes takes its lessons with it: none is written again', async () => {
    await fullDay()
    await updateReflectionState(vp.id, (s) => { s.written.push(ASK.toLowerCase()) }, NOW)
    await mergeGuidance(vp, 'Marina VP', lesson, md(JSON.stringify({ line: 1, text: MERGED })).deps, NOW)
    await fs.writeFile(guidanceFileOf(vp.id), (await fs.readFile(guidanceFileOf(vp.id), 'utf-8')).split('\n').filter((l) => !l.includes(LESSON)).join('\n'))
    await rememberDeletedGuidance(vp.id, NOW)
    const s = await readReflectionState(vp.id, NOW)
    expect(s.removed).toEqual(expect.arrayContaining([MERGED.toLowerCase(), LESSON.toLowerCase()]))
    expect(await addGuidance(vp.id, 'Marina VP', lesson, { removed: s.removed, addedToday: 0 })).toBe('removed')
  })
})
