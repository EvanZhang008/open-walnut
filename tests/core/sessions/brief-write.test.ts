/**
 * The Brief is a document its node edits (src/core/sessions/brief-write.ts): exact-string edits,
 * each `old` once, all or none; every write is shaped against the live tasks and stored with the
 * marks it is judged fresh by.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import { applyBriefEdits, BriefWriteError, shapeBriefText } from '../../../src/core/sessions/brief-write.js'
import { briefFreshness } from '../../../src/core/sessions/brief-fresh.js'

const lead = { id: 'lead', title: 'Marina lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Marina' } as Task
const t = (id: string, s: NonNullable<Task['user_status']>, phase = 'WAITING'): Task => ({ id, title: `T ${id}`, phase, status: phase === 'COMPLETE' ? 'done' : 'in_progress', project: 'Marina', user_status: s }) as Task

describe('applyBriefEdits', () => {
  const text = 'a line\nb line\nb line'
  it('replaces each old once, in order', () => {
    expect(applyBriefEdits('one\ntwo', [{ old: 'one', new: '1' }, { old: 'two', new: '2' }])).toBe('1\n2')
  })
  it('refuses a missing or repeated old, and an empty list, changing nothing', () => {
    const code = (fn: () => unknown) => { try { fn(); return null } catch (e) { return (e as BriefWriteError).code } }
    expect(code(() => applyBriefEdits(text, [{ old: 'zzz', new: 'x' }]))).toBe('brief_edit_not_found')
    expect(code(() => applyBriefEdits(text, [{ old: 'b line', new: 'x' }]))).toBe('brief_edit_not_unique')
    expect(code(() => applyBriefEdits(text, []))).toBe('bad_request')
    expect(code(() => applyBriefEdits(text, [{ old: '', new: 'x' }]))).toBe('bad_request')
  })
})

describe('shapeBriefText', () => {
  const tasks = [
    lead,
    t('a', { state: 'needs', source: 'session', ask: 'Approve the layout' }, 'NEED_ACTION'),
    t('b', { state: 'working', now: 'building' }, 'IN_PROGRESS'),
    t('c', { state: 'done' }, 'COMPLETE'),
  ]
  it('keeps the three sections, moves a line to its live section, drops a finished one, adds a missing ask', () => {
    const { brief, issues } = shapeBriefText('### Waiting / snoozed\n- <task-ref id="b" label="B"/>: building.\n- <task-ref id="c" label="C"/>: sweeping.', lead, tasks, { nowIso: '2026-10-31T18:00:00.000Z' })
    expect(brief.text).toMatch(/^### Needs you\n- <task-ref id="a"[^\n]*Approve the layout/)
    expect(brief.text).toMatch(/### Working\n- <task-ref id="b" label="B"\/>: building\./)
    expect(brief.text).not.toContain('id="c"')
    expect(brief.at).toBe('2026-10-31T18:00:00.000Z')
    expect(issues).toEqual([])
    // Stored with the marks: fresh right after the write.
    expect(briefFreshness({ ...lead, brief }, tasks)!.stale).toBe(false)
  })
  it('answers a line that names no task as an issue', () => {
    const { issues } = shapeBriefText('### Needs you\n- Delete the six stacks?\n### Working\n- None\n### Waiting / snoozed\n- None', lead, tasks)
    expect(issues.map((i) => i.kind)).toContain('no_task')
  })
})
