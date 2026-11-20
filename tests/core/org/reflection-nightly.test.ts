/**
 * The nightly hand-off of the reflection duty (src/core/org/reflection/nightly.ts): after 19:45
 * local, a node whose reflection wrote a record today gets one note naming the file and each
 * finding; never before, never twice a night, and nothing on a day with no finding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-nightly'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { nightlyNote, nightlyText } from '../../../src/core/org/reflection/nightly.js'
import { appendDayEntry, readDayEntries, reflectionDayFileOf, reflectionDayJsonOf } from '../../../src/core/org/reflection/records.js'
import { localDate } from '../../../src/core/org/reflection/state.js'

const vp = { id: 'vp-marina', title: 'Marina VP', org_role: 'lead', phase: 'IN_PROGRESS' } as Task
const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).getTime()
const RECORD = '# Session reflection: Marina VP, x\n\n## 14:02 Upgrade the autoscaler (w-1)\n- Why looked: x\n- What went wrong: It kept 1.8.1 inside 1.4.\n- The right way: y\n\n## 15:10 Send on the real account (w-2)\n- What went wrong: It tried four times on the real account.\n'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the nightly record', () => {
  it('goes to the node once after 19:45, naming the file and each finding', async () => {
    const file = reflectionDayFileOf(vp.id, localDate(at(20, 0)))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, RECORD, 'utf-8')
    const sent: string[] = []
    const send = async (_n: Task, text: string) => { sent.push(text); return true }
    expect(await nightlyNote(vp, 'Marina VP', at(19, 30), send)).toBe('early')
    expect(await nightlyNote(vp, 'Marina VP', at(19, 50), send)).toBe('sent')
    expect(await nightlyNote(vp, 'Marina VP', at(22, 0), send)).toBe('done')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(file)
    expect(sent[0]).toContain('- 14:02 Upgrade the autoscaler (w-1): It kept 1.8.1 inside 1.4.')
    expect(sent[0]).toContain('found 2 decisions')
  })

  it('sends nothing on a day with no finding', async () => {
    const sent: string[] = []
    expect(await nightlyNote(vp, 'Marina VP', at(21, 0), async (_n, t) => { sent.push(t); return true })).toBe('none')
    expect(sent).toEqual([])
  })

  it('keeps the note short whatever the record holds', () => {
    const many = Array.from({ length: 60 }, (_, i) => `## 10:${String(i).padStart(2, '0')} Task ${i} (t-${i})\n- What went wrong: ${'a long sentence about the work '.repeat(3)}\n`).join('\n')
    const text = nightlyText('Marina VP', '/x/2026-11-19.md', many)
    expect(text.length).toBeLessThan(3800)
    // The ones left out are counted, with the file that holds them all.
    const listed = text.split('\n').filter((l) => l.startsWith('- 10:')).length
    expect(text).toContain(`- ... and ${60 - listed} more, not listed here: all 60 are in /x/2026-11-19.md`)
  })

  it('lists every finding of a usual day, each on one short line', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `## 09:${String(i).padStart(2, '0')} Lagoon task ${i} (t-${i})\n- What went wrong: ${'it skipped the check on the pier '.repeat(12)}\n`).join('\n')
    const text = nightlyText('Lagoon VP', '/x/2026-11-19.md', ten)
    const listed = text.split('\n').filter((l) => l.startsWith('- 09:'))
    expect(listed).toHaveLength(10)
    expect(listed.every((l) => l.length <= 240)).toBe(true)
    expect(text).not.toContain('not listed here')
  })

  it('lists each finding from the day\'s JSON with its kind, rule and task', async () => {
    const date = localDate(at(20, 0))
    const finding = { kind: 'regression', session_quote: 's', user_quote: 'u', rule_quote: '', what_went_wrong: 'The card lost its reply.', correct_action: 'c', already_fixed: false, correction: 'x', guidance: 'g', same_as: 0, skill: null } as const
    await appendDayEntry(vp.id, 'Marina VP', date, {
      at: '2026-11-19T14:02:00.000Z', signal: 'regression', task: { id: 'vp-marina', title: 'Marina VP' }, finding, corrected: 'sent',
      rule: { kind: 'guidance', text: 'Keep a reply under its card.', line: 3 }, handedTo: { taskId: 'vp-marina', title: 'Marina VP' },
    })
    const sent: string[] = []
    expect(await nightlyNote(vp, 'Marina VP', at(20, 0), async (_n, t) => { sent.push(t); return true })).toBe('sent')
    expect(sent[0]).toContain('regression in Marina VP: The card lost its reply. Rule: guidance line 3: Keep a reply under its card.. Handed to: Marina VP (vp-marina).')
    const md = await fs.readFile(reflectionDayFileOf(vp.id, date), 'utf-8')
    expect(md).toContain('- Rule: guidance line 3: Keep a reply under its card.')
    expect(md).toContain('- Handed to: Marina VP (vp-marina)')
  })

  it('reads an entry written without the rule and task fields, and a day with only its Markdown', async () => {
    const date = localDate(at(20, 0))
    const json = reflectionDayJsonOf(vp.id, date)
    await fs.mkdir(path.dirname(json), { recursive: true })
    await fs.writeFile(json, JSON.stringify({ schemaVersion: 1, entries: [{ at: '2026-11-19T10:00:00.000Z', signal: 'frustration', task: { id: 'w-1', title: 'Old' }, finding: { kind: 'other', what_went_wrong: 'Old shape.' }, corrected: 'sent', guidance: 'added: x' }] }), 'utf-8')
    const entries = await readDayEntries(vp.id, date)
    expect(entries?.[0].rule).toEqual({ kind: 'none', text: '' })
    expect(entries?.[0].handedTo).toBeUndefined()
    const sent: string[] = []
    await nightlyNote(vp, 'Marina VP', at(20, 0), async (_n, t) => { sent.push(t); return true })
    expect(sent[0]).toContain('Old shape. Rule: none. Handed to: none.')
    expect(await readDayEntries(vp.id, '2001-01-01')).toBeNull()
  })

  it('lists on the upgrade day the entries only the Markdown holds, then the JSON\'s', async () => {
    const date = localDate(at(20, 0))
    const file = reflectionDayFileOf(vp.id, date)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Written before the JSON began: Markdown only.
    await fs.writeFile(file, '# Session reflection: Marina VP, x\n\n## 09:00 Early task (w-0)\n- What went wrong: Before the upgrade.\n\n', 'utf-8')
    const finding = { kind: 'regression', session_quote: 's', user_quote: 'u', rule_quote: '', what_went_wrong: 'After the upgrade.', correct_action: 'c', already_fixed: false, correction: 'x', guidance: 'g', same_as: 0, skill: null } as const
    await appendDayEntry(vp.id, 'Marina VP', date, { at: '2026-11-19T15:00:00.000Z', signal: 'regression', task: { id: 'w-1', title: 'Later task' }, finding, corrected: 'held', held: 'own_cap', rule: { kind: 'none', text: '' } })
    const sent: string[] = []
    await nightlyNote(vp, 'Marina VP', at(20, 0), async (_n, t) => { sent.push(t); return true })
    expect(sent[0]).toContain('found 2 decisions')
    expect(sent[0]).toContain('- 09:00 Early task (w-0): Before the upgrade.')
    expect(sent[0]).toContain('After the upgrade. Rule: none. Handed to: none (own_cap).')
  })

  it('keeps a day whose JSON no longer parses: the bad file set aside, its entries read from the Markdown', async () => {
    const date = localDate(at(20, 0))
    const file = reflectionDayFileOf(vp.id, date)
    const json = reflectionDayJsonOf(vp.id, date)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# Session reflection: Marina VP, x\n\n## 09:00 Early task (w-0)\n- What went wrong: Kept in the Markdown.\n\n', 'utf-8')
    await fs.writeFile(json, '{"schemaVersion":1,"entries":[{"at":', 'utf-8')
    const finding = { kind: 'regression', session_quote: 's', user_quote: 'u', rule_quote: '', what_went_wrong: 'Written after.', correct_action: 'c', already_fixed: false, correction: 'x', guidance: 'g', same_as: 0, skill: null } as const
    await appendDayEntry(vp.id, 'Marina VP', date, { at: '2026-11-19T15:00:00.000Z', signal: 'regression', task: { id: 'w-1', title: 'Later task' }, finding, corrected: 'sent', rule: { kind: 'none', text: '' } })
    expect(await fs.readFile(`${json}.bad`, 'utf-8')).toContain('"entries":[{"at":')
    expect((await readDayEntries(vp.id, date))?.map((e) => e.task.id)).toEqual(['w-1'])
    const sent: string[] = []
    await nightlyNote(vp, 'Marina VP', at(20, 0), async (_n, t) => { sent.push(t); return true })
    expect(sent[0]).toContain('found 2 decisions')
    expect(sent[0]).toContain('Kept in the Markdown.')
  })
})

