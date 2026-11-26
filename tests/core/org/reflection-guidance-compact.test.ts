/**
 * A full team guidance makes its own room (src/core/org/reflection/guidance-compact.ts). 2026-11-26, Walnut
 * VP: with the hint's room spent, 58 and 42 lessons waited and two VPs compacted their files by hand, one for
 * the third time. The reflection merges two of its own lines into one shorter line that keeps both, a few a
 * day, never a line the user wrote, and only then asks the node (and not on a day it made room itself).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-compact'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { COMPACT_CALLS_PER_DAY_MAX, COMPACT_CHECK_SYSTEM, COMPACT_SYSTEM, compactGuidance, readCompact, readCompactCheck } from '../../../src/core/org/reflection/guidance-compact.js'
import { guidanceFileOf, readGuidance, renderGuidance, reflectionDayFileOf, reflectionDayJsonOf } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { guidanceRoomLeft } from '../../../src/core/org/reflection/team-guidance-hint.js'
import { askTidy } from '../../../src/core/org/reflection/guidance-tidy.js'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const A = 'Before you list what waits on the user, check its live state and say when you checked it.'
const B = 'Before you list open items for the user, check each one live and drop what is already done.'
const MERGED = 'Before you list what waits on the user, check each item live, drop what is done, and say when you checked.'
const OWN = 'My own rule: never ping my manager.'
// Lines long enough that the hint has no room left: the shape of the 11-26 files.
const filler = (i: number) => `Rule ${i}: keep every card short, put the recommendation first, link the plan page, and give buttons that say what a click does, so he answers in one click.`

async function writeLines(lines: Array<{ text: string; from?: string }>) {
  await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
  await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines.map((l) => ({ text: l.text, ...(l.from ? { from: l.from, date: '2026-11-20' } : {}) }))))
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the answer is checked before two lines become one', () => {
  const lines = [{ text: A, from: 'x', date: '2026-11-20' }, { text: B, from: 'x', date: '2026-11-20' }, { text: OWN }]
  const both = new Set([1, 2])
  const one = (l: number[], text: string) => JSON.stringify({ edits: [{ lines: l, text }] })
  it('a line that keeps both and is shorter is taken (the single-pair answer too)', () => {
    expect(readCompact(one([1, 2], MERGED), lines, both)).toEqual({ kind: 'read', edits: [{ lines: [1, 2], text: MERGED }], refused: [] })
    expect(readCompact(JSON.stringify({ lines: [1, 2], text: MERGED }), lines, both)).toEqual({ kind: 'read', edits: [{ lines: [1, 2], text: MERGED }], refused: [] })
  })
  it('one that names a line of the user, frees no room, drops a line\'s words, or is no JSON is refused with its reason', () => {
    const why = (raw: string) => { const r = readCompact(raw, lines, both); return r.kind === 'read' ? (r.edits.length ? '' : r.refused[0]?.why) : r.why }
    expect(why(one([1, 3], MERGED))).toContain('the user wrote')
    expect(why(one([1, 2], `${A} ${B}`))).toContain('frees no room')
    expect(why(one([1, 2], 'Check things before listing them.'))).toContain('drops what line')
    expect(why('no json')).toContain('not JSON')
    expect(why(one([2, 2], MERGED))).toContain('not one or two lines')
    // One long line said in fewer words is an edit too; one that frees nothing is not.
    const long = `${A} Do it every time, without exception, each and every time.`
    expect(why(one([1], A))).toContain('frees no room')
    expect(readCompact(one([1], A), [{ text: long, from: 'x' }], new Set([1])).kind === 'read').toBe(true)
    expect(why(one([3], OWN.slice(0, 10)))).toContain('the user wrote')
  })
  it('several edits of one answer are each checked, and a line is in one edit only', () => {
    const four = [...lines.slice(0, 2), { text: A.replace('the user', 'him'), from: 'x' }, { text: B.replace('the user', 'him'), from: 'x' }]
    const r = readCompact(JSON.stringify({ edits: [{ lines: [1, 2], text: MERGED }, { lines: [2, 3], text: MERGED }, { lines: [3, 4], text: MERGED.replace('the user', 'him') }] }), four, new Set([1, 2, 3, 4]))
    expect(r.kind === 'read' && r.edits.map((m) => m.lines)).toEqual([[1, 2], [3, 4]])
    expect(r.kind === 'read' && r.refused[0]?.why).toContain('another edit')
  })
})

describe('a full guidance with lessons waiting', () => {
  it('merges two of its own lines into one, keeps the user\'s line, and says it in the day record (the undo)', async () => {
    const all = [{ text: A, from: 'x' }, ...Array.from({ length: 22 }, (_, i) => ({ text: filler(i), from: 'x' })), { text: B, from: 'x' }, { text: OWN }]
    await writeLines(all)
    expect(guidanceRoomLeft('Marina VP', all.map((l) => l.text))).toBeLessThan(200)
    const asked: string[] = []
    const checked: string[] = []
    const callModel = async (system: string, user: string) => {
      if (system === COMPACT_CHECK_SYSTEM) { checked.push(user); return '{"lost":[]}' }
      expect(system).toBe(COMPACT_SYSTEM)
      asked.push(user)
      const n = (t: string) => user.split('\n').findIndex((l) => l.endsWith(t)) - 2 // the line's number in the prompt
      return JSON.stringify({ edits: [{ lines: [n(A), n(B)], text: MERGED }] })
    }
    const freed = await compactGuidance(vp, 'Marina VP', 5, { callModel }, NOW)
    expect(freed).toBeGreaterThanOrEqual(1)
    expect(asked[0]).toContain(`${OWN} (the user's own)`)
    expect(asked[0]).toMatch(/NEEDED: at least \d+ characters fewer/)
    expect(checked[0]).toContain(`OLD: ${A}`)
    expect(checked[0]).toContain(`NEW: ${MERGED}`)
    const texts = (await readGuidance(vp.id)).map((l) => l.text)
    expect(texts).toContain(MERGED)
    expect(texts).not.toContain(A)
    expect(texts).not.toContain(B)
    expect(texts).toContain(OWN)
    const s = await readReflectionState(vp.id, NOW)
    expect(s.compacts?.freed).toBeGreaterThanOrEqual(1)
    const md = await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')
    expect(md).toContain('two lines merged')
    expect(md).toContain(A)
  })

  it(`spends at most ${COMPACT_CALLS_PER_DAY_MAX} calls a day, and none with no lesson waiting or room left`, async () => {
    const all = Array.from({ length: 24 }, (_, i) => ({ text: filler(i), from: 'x' }))
    await writeLines(all)
    let calls = 0
    const bad = async () => { calls++; return 'no json' }
    expect(await compactGuidance(vp, 'Marina VP', 0, { callModel: bad }, NOW)).toBe(0)
    expect(calls).toBe(0)
    await compactGuidance(vp, 'Marina VP', 3, { callModel: bad }, NOW)
    await compactGuidance(vp, 'Marina VP', 3, { callModel: bad }, NOW)
    expect(calls).toBe(COMPACT_CALLS_PER_DAY_MAX)
  })

  it('a pair the check refused is named, with its reason, in the next call', async () => {
    await writeLines([{ text: A, from: 'x' }, ...Array.from({ length: 22 }, (_, i) => ({ text: filler(i), from: 'x' })), { text: B, from: 'x' }])
    const asked: string[] = []
    const callModel = async (_s: string, user: string) => {
      asked.push(user)
      const n = (t: string) => user.split('\n').findIndex((l) => l.endsWith(t)) - 2
      return JSON.stringify({ edits: [{ lines: [n(A), n(B)], text: 'Check things.' }] })
    }
    await compactGuidance(vp, 'Marina VP', 2, { callModel }, NOW)
    expect(asked).toHaveLength(COMPACT_CALLS_PER_DAY_MAX)
    expect(asked[0]).not.toContain('REFUSED BEFORE')
    expect(asked[1]).toContain('REFUSED BEFORE:')
    expect(asked[1]).toContain(A.slice(0, 40))
    expect(asked[1]).toContain('drops what line')
  })

  it('an edit the check call says loses a point is not made, and is named next time; an unreadable check makes none', async () => {
    const all = [{ text: A, from: 'x' }, ...Array.from({ length: 22 }, (_, i) => ({ text: filler(i), from: 'x' })), { text: B, from: 'x' }]
    for (const check of ['{"lost":[1],"why":{"1":"the when-you-checked part"}}', 'not json']) {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      await writeLines(all)
      const asked: string[] = []
      const callModel = async (system: string, user: string) => {
        if (system === COMPACT_CHECK_SYSTEM) return check
        asked.push(user)
        const n = (t: string) => user.split('\n').findIndex((l) => l.endsWith(t)) - 2
        return JSON.stringify({ edits: [{ lines: [n(A), n(B)], text: MERGED }] })
      }
      expect(await compactGuidance(vp, 'Marina VP', 2, { callModel }, NOW)).toBe(0)
      expect((await readGuidance(vp.id)).map((l) => l.text)).toContain(A)
      if (check !== 'not json') expect(asked[1]).toContain('it loses the when-you-checked part')
    }
    expect(readCompactCheck('{"lost":[2,9]}', 3)).toEqual(new Map([[2, 'it loses a point of a line']]))
  })

  it('a node is not asked to tidy on a day the reflection made room itself', async () => {
    await writeLines(Array.from({ length: 24 }, (_, i) => ({ text: filler(i), from: 'x' })))
    const day = localDate(NOW)
    const f = reflectionDayJsonOf(vp.id, day)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, JSON.stringify({ schemaVersion: 1, nodeId: vp.id, nodeName: 'Marina VP', date: day, entries: [{
      at: new Date(NOW - 3600_000).toISOString(), signal: 'frustration', task: { id: 'w-1', title: 'x' }, corrected: 'sent', rule: { kind: 'none', text: 'not added (day_full): Name the plan page in every card.' },
      finding: { kind: 'other', session_quote: 's', user_quote: 'where is the plan', rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: 'c', guidance: 'Name the plan page in every card.', same_as: 0, skill: null },
    }] }))
    let sent = 0
    const d = { send: async () => { sent++; return true } }
    // The control: with no room made today, the node is asked.
    expect(await askTidy(vp, 'Marina VP', d, NOW)).toBe(true)
    await updateReflectionState(vp.id, (s) => { delete s.tidyAsked; s.compacts = { date: day, count: 1, freed: 1 } }, NOW)
    expect(await askTidy(vp, 'Marina VP', d, NOW)).toBe(false)
    expect(sent).toBe(1)
  })
})
