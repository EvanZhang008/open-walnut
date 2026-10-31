/**
 * The Brief's fixed shape (src/core/sessions/brief-structure.ts). 2026-10-30, the user, on a VP's
 * Brief that was one flat list with Walnut's footers under it: "what is being done, what does not
 * need me, what needs me ... we must put this whole structure in", and "brief 就是 AI 写的一个
 * brief. That's it". Every stored Brief has three sections, Needs you, Working, Waiting / snoozed,
 * each task's line under the section of its own live status; the Brief view shows that letter only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { BRIEF_SECTIONS, USER_STATES } from '../../../src/core/user-status.js'
import { briefSectionOf, emptySectionLine, headingSection, structureBrief } from '../../../src/core/sessions/brief-structure.js'
import { briefSectionLines } from '../../../src/core/sessions/brief.js'
import type { Task } from '../../../src/core/types.js'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const ref = (id: string, label = id) => `<task-ref id="${id}" label="${label}"/>`
const t = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: `T ${id}`, phase: 'IN_PROGRESS', project: 'Garden', parent_task_id: 'lead', ...over }) as Task
const lead = t('lead', { org_role: 'lead', parent_task_id: undefined })

describe('the three sections', () => {
  it('cover every open user status, so a new status cannot fall outside the Brief', () => {
    const covered = new Set(BRIEF_SECTIONS.map((s) => s.state))
    for (const state of USER_STATES) {
      if (state === 'done') continue
      expect(covered.has(state), `user status "${state}" has no Brief section`).toBe(true)
    }
    expect(BRIEF_SECTIONS.map((s) => s.heading)).toEqual(['Needs you', 'Working', 'Waiting / snoozed'])
  })

  it('put a task by its own live status; done has none', () => {
    expect(briefSectionOf(t('a', { user_status: { state: 'needs', ask: 'x' } }))).toBe('needs')
    expect(briefSectionOf(t('b', { user_status: { state: 'working' } }))).toBe('working')
    expect(briefSectionOf(t('c', { phase: 'WAITING', user_status: { state: 'waiting' } }))).toBe('waiting')
    expect(briefSectionOf(t('e', { phase: 'COMPLETE', status: 'done' }))).toBeNull()
    // No derived status yet: the phase, as an older Walnut meant it.
    expect(briefSectionOf(t('f', { phase: 'NEED_ACTION' }))).toBe('needs')
  })

  it('read a heading in other words, and only a heading', () => {
    expect(headingSection('### Needs you')).toBe('needs')
    expect(headingSection('**需要你：**')).toBe('needs')
    expect(headingSection('## In progress')).toBe('working')
    expect(headingSection('Waiting / snoozed:')).toBe('waiting')
    expect(headingSection('### Needs you (2)')).toBe('needs')
    expect(headingSection('- Needs you to pick a supplier')).toBeNull()
    expect(headingSection('**Needs you to pick a supplier**')).toBeNull()
    expect(headingSection(`### ${ref('a')}`)).toBeNull()
  })
})

describe('structureBrief', () => {
  // The Walnut VP's Brief of 2026-10-30, one flat list (neutral ids and words).
  const tasks = [
    lead,
    t('setup', { user_status: { state: 'needs', ask: 'Ten minutes on the Mac' } }),
    t('panel', { user_status: { state: 'working' } }),
    t('release', { phase: 'WAITING', user_status: { state: 'waiting', waitingOn: 'the release date' } }),
    t('review', { user_status: { state: 'waiting', waitingOn: 'the store review' } }),
    t('done', { phase: 'COMPLETE', status: 'done' }),
  ]
  const flat = [
    `- ${ref('panel')} 正在做你选的设计 1。`,
    `- ${ref('setup')} 等你有空花约 10 分钟。`,
    `- ${ref('release')} 0.6.22 预计 11-01 发布。`,
    `- ${ref('review')} 还在审核中。`,
  ].join('\n')

  it('gives a flat Brief its three sections, each line under its task\'s live status', () => {
    const out = structureBrief(flat, 'lead', tasks)
    expect(out.added).toEqual(['needs', 'working', 'waiting'])
    expect(out.text).toBe([
      '### Needs you', flat.split('\n')[1], '',
      '### Working', flat.split('\n')[0], '',
      '### Waiting / snoozed', flat.split('\n')[2], flat.split('\n')[3],
    ].join('\n'))
  })

  it('moves a line written under the wrong section, and is a no-op on a right Brief', () => {
    const wrong = `### Needs you\n- ${ref('review')}: in review.\n\n### Working\n- ${ref('setup')}: ten minutes.\n\n### Waiting / snoozed\n- None`
    const out = structureBrief(wrong, 'lead', tasks)
    expect(out.moved).toBe(2)
    expect(out.text).toBe(`### Needs you\n- ${ref('setup')}: ten minutes.\n\n### Working\n- None\n\n### Waiting / snoozed\n- ${ref('review')}: in review.`)
    const again = structureBrief(out.text, 'lead', tasks)
    expect(again).toEqual({ text: out.text, moved: 0, added: [] })
  })

  it('keeps the owner\'s own lines, finished work and lines with no task where they were written', () => {
    const text = `## 需要你\n- 没有\n## 进行中\n- ${ref('lead')}: I plan the week.\n- ${ref('done')}: shipped.\n- A note with no task.`
    const out = structureBrief(text, 'lead', tasks, { language: 'Simplified Chinese (简体中文)' })
    expect(out.text).toBe(`### Needs you\n- 没有\n\n### Working\n- ${ref('lead')}: I plan the week.\n- ${ref('done')}: shipped.\n- A note with no task.\n\n### Waiting / snoozed\n- 无`)
    expect(emptySectionLine('English')).toBe('- None')
  })

  it('reads a bold label at the head of a line as its section', () => {
    expect(structureBrief(`**Needs you:** nothing right now.\n**进行中：** ${ref('panel')}: building.`, 'lead', tasks).text)
      .toBe(`### Needs you\n- nothing right now.\n\n### Working\n- ${ref('panel')}: building.\n\n### Waiting / snoozed\n- 无`)
  })

  it('makes a task\'s bare line a list item', () => {
    expect(structureBrief(`${ref('panel')} building.\n${ref('setup')} ten minutes.`, 'lead', tasks).text)
      .toBe(`### Needs you\n- ${ref('setup')} ten minutes.\n\n### Working\n- ${ref('panel')} building.\n\n### Waiting / snoozed\n- None`)
  })

  it('never drops a line of the writer\'s, and a sub-item goes with its item', () => {
    const text = `### Working\n- ${ref('review')}: 等供应商报价\n  对方还没有回复邮件\n  - none of the reviewers answered yet\n- ${ref('panel')}: building.`
    expect(structureBrief(text, 'lead', tasks).text).toBe(
      `### Needs you\n- 无\n\n### Working\n- ${ref('panel')}: building.\n\n### Waiting / snoozed\n- ${ref('review')}: 等供应商报价\n  对方还没有回复邮件\n  - none of the reviewers answered yet`)
    // A bold word that is not a label (no colon) stays the writer's.
    expect(structureBrief(`- **Snoozed** until Monday: ${ref('review')}`, 'lead', tasks).text)
      .toContain(`- **Snoozed** until Monday: ${ref('review')}`)
    // A label alone on a bullet line opens its section.
    expect(structureBrief(`- **Needs you:**\n- ${ref('setup')}: ten minutes.`, 'lead', tasks).text)
      .toBe(`### Needs you\n- ${ref('setup')}: ten minutes.\n\n### Working\n- None\n\n### Waiting / snoozed\n- None`)
  })

  it('carries a wrapped line with its item', () => {
    const text = `- ${ref('setup')}: run the sign-in,\n  then say start.\n- ${ref('panel')}: building.`
    expect(structureBrief(text, 'lead', tasks).text)
      .toBe(`### Needs you\n- ${ref('setup')}: run the sign-in,\n  then say start.\n\n### Working\n- ${ref('panel')}: building.\n\n### Waiting / snoozed\n- None`)
  })
})

describe('the lists the ask hands the writer', () => {
  it('put the team\'s open work in its sections, with what each does, waits on or left undone', () => {
    const lists = briefSectionLines(lead, [
      lead,
      t('a', { user_status: { state: 'working', now: 'building the bed' }, result_report: { not_done: ['the gate'] } }),
      t('b', { phase: 'WAITING', user_status: { state: 'waiting' } }),
      t('s', { user_status: { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-02', snoozed: { until: '2026-11-02', ask: 'Pick a supplier' } } as never }),
      t('c', { phase: 'WAITING', user_status: { state: 'waiting', waitingOn: 'the supplier', until: '2026-10-30T16:00:00Z' } }),
    ], NOW)
    expect(lists.needs).toEqual([])
    expect(lists.working).toEqual([`- ${ref('a', 'T a')}: building the bed; Partial, not done: the gate`])
    expect(lists.waiting).toContain(`- ${ref('b', 'T b')}: waiting`)
    // Snoozed: under Waiting with its date, the ask it holds back there and never as a Needs you line.
    expect(lists.waiting).toContain(`- ${ref('s', 'T s')}: snoozed until 2026-11-02 (then asks: "Pick a supplier")`)
    expect(lists.waiting).toContain(`- ${ref('c', 'T c')}: waits on the supplier (wakes 2026-10-30T16:00:00Z)`)
  })
})

describe('the Brief view is the letter alone', () => {
  // Every element OrgBrief.tsx draws, by test id. A new one under the letter (a footer, a list of
  // what moved, cards) fails here: what needs the user lives in the Status view.
  it('draws only the letter, its written time and its empty state', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '../../../web/src/components/org/OrgBrief.tsx'), 'utf8')
    const ids = [...src.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]).sort()
    expect(ids).toEqual(['org-brief', 'org-brief', 'org-brief-body', 'org-brief-foot'])
    expect(src).not.toMatch(/<[A-Z]\w*(?<!Fragment)\s/)
  })
})
