/**
 * task_create's related-tasks check, second leg (src/core/sessions/related-by-meaning.ts): for a
 * lead's or Main's create, the tasks search finds BY MEANING are listed with their deliverable,
 * first request and latest report, open ones and ones finished lately, and the caller judges.
 *
 * The cases are the dispatch audit's of 2026-11-09..16, rewritten with neutral data:
 *   - a lead creates a task in Chinese for the garden's watering contract while the open owner is
 *     titled in English ("Irrigation Contract Renewal"): no shared word, so the first leg never listed it;
 *   - a lead creates "Restore the model alias on the desktop" while the task that set up the very
 *     guard that fired finished ten days ago: a finished owner whose delivered work came back;
 *   - a worker's own subtask is not looked up by meaning (its team's work, and it creates often).
 * Search itself is replaced: what is tested is which rows are shown and how, never a score.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-related-by-meaning'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, updateTaskRaw, listTasksByIds } from '../../../src/core/task-manager.js'
import {
  _injectRelatedLookupForTesting, _resetRelatedListsShownForTesting, relatedOpenTasksGate,
} from '../../../src/core/sessions/related-open-tasks.js'
import {
  _injectMeaningDepsForTesting, findByMeaning, findByMeaningInTime, listable, meaningQuery, DONE_WITHIN_DAYS,
} from '../../../src/core/sessions/related-by-meaning.js'
import type { CallerPlacement } from '../../../src/core/sessions/caller-placement.js'
import type { Task } from '../../../src/core/types.js'

// "Community garden: irrigation contract renewal and upkeep", as a lead typed it in Chinese.
const ZH_TITLE = '\u793e\u533a\u82b1\u56ed\uff1a\u704c\u6e89\u5408\u540c\u7eed\u7b7e\u4e0e\u7ef4\u62a4\u4e8b\u52a1'
const DAY = 86_400_000

let lead = ''
let worker = ''
let irrigation = ''
let aliasGuard = ''
let oldDone = ''
let otherVp = ''
let searched: string[] = []

const callerOf = (taskId: string, sid: string): CallerPlacement =>
  ({ kind: 'worker', task: { id: taskId, title: 'x', project: 'Home' }, session: { id: sid } } as never)

const gate = (caller: CallerPlacement, title: string, body: Record<string, unknown> = {}, description?: string) =>
  relatedOpenTasksGate({ caller, decision: { project: 'Home' } as never, title, body, ...(description ? { description } : {}) })

// The test configs turn the check off for every other test (vitest.config.ts env).
const checkWas = process.env.WALNUT_RELATED_CHECK

beforeAll(async () => {
  process.env.WALNUT_RELATED_CHECK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  lead = (await addTask({ title: 'Home VP', project: 'Home' } as never)).task.id
  await updateTaskRaw(lead, { org_role: 'lead' } as never, { source: 'test' })
  otherVp = (await addTask({ title: 'Ops VP', project: 'Ops' } as never)).task.id
  await updateTaskRaw(otherVp, { org_role: 'lead' } as never, { source: 'test' })
  worker = (await addTask({ title: 'Club membership form for the year', project: 'Home' } as never)).task.id
  irrigation = (await addTask({ title: 'Community garden \u00b7 Irrigation Contract Renewal', project: 'Home', description: 'Renew the irrigation service contract before it lapses.' } as never)).task.id
  await updateTaskRaw(irrigation, {
    note: '## User Request\nRenew the community garden irrigation contract with the same vendor and answer the volunteers.',
    status_report: { state: 'waiting', at: '2026-11-16T19:40:00.000Z', now: 'Quote received; waiting on the vendor to confirm the start date.' },
  } as never, { source: 'test' })
  aliasGuard = (await addTask({ title: 'Subagents asked for the large model run on the small one', project: 'Ops' } as never)).task.id
  await updateTaskRaw(aliasGuard, {
    phase: 'COMPLETE', status: 'done', completed_at: new Date(Date.now() - 10 * DAY).toISOString(),
    note: '## User Request\nFix the missing model alias on the desktop and add a cheap hourly guard that reports a missing alias to the lead.',
    result_report: { at: new Date(Date.now() - 10 * DAY).toISOString(), result: 'Alias restored; the hourly guard runs on both hosts.' },
  } as never, { source: 'test' })
  oldDone = (await addTask({ title: 'Garden irrigation 2024', project: 'Home' } as never)).task.id
  await updateTaskRaw(oldDone, { phase: 'COMPLETE', status: 'done', completed_at: new Date(Date.now() - (DONE_WITHIN_DAYS + 5) * DAY).toISOString() } as never, { source: 'test' })
}, 60_000)

beforeEach(() => {
  searched = []
  _resetRelatedListsShownForTesting()
  // The first leg (shared words) finds nothing in these cases: no word is shared.
  _injectRelatedLookupForTesting(async () => [])
  _injectMeaningDepsForTesting({
    search: async (q) => {
      searched.push(q)
      if (q.includes('\u704c\u6e89')) return [{ type: 'task', taskId: oldDone }, { type: 'task', taskId: otherVp }, { type: 'task', taskId: irrigation }, { type: 'memory' }]
      if (q.includes('alias')) return [{ type: 'task', taskId: aliasGuard }, { type: 'task', taskId: irrigation, isAutoExpanded: true }]
      return []
    },
  })
})

afterAll(() => {
  if (checkWas === undefined) delete process.env.WALNUT_RELATED_CHECK
  else process.env.WALNUT_RELATED_CHECK = checkWas
  _injectRelatedLookupForTesting(null)
  _injectMeaningDepsForTesting(null)
})

describe('a lead\'s create lists what search finds by meaning, for the lead to judge', () => {
  it('Chinese words find the English-titled open owner; shown with its deliverable, first request and latest report', async () => {
    const r = await gate(callerOf(lead, 'sid-lead-1'), ZH_TITLE, {}, 'The volunteers wrote about the dry beds.')
    expect(r.kind).toBe('refuse')
    if (r.kind !== 'refuse') return
    // Not the old finished one (past the window), not a VP.
    expect(r.candidates.map((c) => c.id)).toEqual([irrigation])
    const c = r.candidates[0]!
    expect(c.found_by).toBe('meaning')
    expect(c.deliverable).toBe('Renew the community garden irrigation contract with the same vendor and answer the volunteers.')
    expect(c.first_request).toBe('Renew the irrigation service contract before it lapses.')
    expect(c.latest).toBe('2026-11-16 19:40 UTC waiting: Quote received; waiting on the vendor to confirm the start date.')
    expect(r.message).toContain('deliverable: "Renew the community garden irrigation contract')
    expect(r.message).toContain('The same file, component, place or person is not the same deliverable.')
    expect(searched[0]).toBe(`${ZH_TITLE} The volunteers wrote about the dry beds.`)
  })

  it('a finished owner whose guard fired is listed as finished, with the hint to reopen it with force', async () => {
    const r = await gate(callerOf(otherVp, 'sid-ops-1'), 'Restore the model alias on the desktop')
    expect(r.kind).toBe('refuse')
    if (r.kind !== 'refuse') return
    // The auto-expanded child row is its parent's hit, not its own.
    expect(r.candidates.map((c) => c.id)).toEqual([aliasGuard])
    expect(r.candidates[0]!.reason).toMatch(/^search finds it by meaning; finished \d{4}-\d{2}-\d{2}$/)
    expect(r.candidates[0]!.latest).toContain('result: Alias restored; the hourly guard runs on both hosts.')
    expect(r.hint).toContain('a regression of what a finished one delivered')
    expect(r.hint).toContain('"force": true')
  })

  it('after the list was shown, confirm_new with a reason creates it', async () => {
    const caller = callerOf(lead, 'sid-lead-2')
    expect((await gate(caller, ZH_TITLE)).kind).toBe('refuse')
    const again = await gate(caller, ZH_TITLE, { confirm_new: true, new_reason: 'The volunteer schedule is its own deliverable.' })
    expect(again.kind).toBe('proceed')
  })

  it('a confirm_new answers the list of that title only, never the session\'s next create', async () => {
    const caller = callerOf(lead, 'sid-lead-4')
    expect((await gate(caller, ZH_TITLE)).kind).toBe('refuse')
    const other = await gate(caller, 'Restore the model alias on the desktop', { confirm_new: true, new_reason: 'Different work from the list I saw.' })
    expect(other.kind).toBe('refuse')
  })

  it('when the shared-words leg runs out of time, what search finds by meaning is still shown', async () => {
    let stopped: { stopped: boolean } | undefined
    _injectRelatedLookupForTesting((_input, stop) => { stopped = stop; return new Promise(() => {}) })
    process.env.WALNUT_RELATED_CHECK_DEADLINE_MS = '30'
    try {
      const r = await gate(callerOf(lead, 'sid-lead-5'), ZH_TITLE)
      expect(r.kind).toBe('refuse')
      if (r.kind === 'refuse') expect(r.candidates.map((c) => c.id)).toEqual([irrigation])
      // The ranking was told to stop at its own deadline.
      expect(stopped?.stopped).toBe(true)
    } finally {
      delete process.env.WALNUT_RELATED_CHECK_DEADLINE_MS
    }
  })

  it('a worker\'s create is not looked up by meaning', async () => {
    const r = await gate(callerOf(worker, 'sid-worker-1'), ZH_TITLE)
    expect(r.kind).toBe('proceed')
    expect(searched).toEqual([])
  })

  it('a failing or slow search lets the create go ahead on the first leg alone', async () => {
    _injectMeaningDepsForTesting({ search: async () => { throw new Error('index down') } })
    expect((await gate(callerOf(lead, 'sid-lead-3'), ZH_TITLE)).kind).toBe('proceed')
    _injectMeaningDepsForTesting({ search: () => new Promise(() => {}) })
    const t0 = Date.now()
    expect(await findByMeaningInTime({ title: ZH_TITLE, skip: new Set() }, 50)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('the rules a row passes', () => {
  it('the query is the title and the description\'s head', () => {
    expect(meaningQuery('  Title ', `line one\n\nline   two ${'x'.repeat(400)}`)).toBe(`Title line one line two ${'x'.repeat(300 - 'line one line two '.length)}`)
    expect(meaningQuery('', '')).toBe('')
  })

  it('a lead, a plugin row or a conversation is never listed; a finished task only inside the window', async () => {
    const now = Date.now()
    const base = { id: 'x', title: 't', phase: 'IN_PROGRESS' } as Task
    expect(listable(base, now)).toBe(true)
    expect(listable({ ...base, org_role: 'lead' } as Task, now)).toBe(false)
    expect(listable({ ...base, plugin_only: 'mail' } as Task, now)).toBe(false)
    expect(listable({ ...base, walnut_agent: true } as Task, now)).toBe(false)
    expect(listable({ ...base, phase: 'COMPLETE', completed_at: new Date(now - DAY).toISOString() } as Task, now)).toBe(true)
    expect(listable({ ...base, phase: 'COMPLETE', completed_at: new Date(now - (DONE_WITHIN_DAYS + 1) * DAY).toISOString() } as Task, now)).toBe(false)
  })

  it('the caller\'s own line and what the first leg listed are skipped; at most three rows', async () => {
    const ids = [irrigation, aliasGuard, worker, lead]
    _injectMeaningDepsForTesting({ search: async () => ids.map((taskId) => ({ type: 'task', taskId })), read: listTasksByIds })
    const found = await findByMeaning({ title: 'anything', skip: new Set([irrigation]) })
    expect(found.map((f) => f.task.id)).toEqual([aliasGuard, worker])
    expect(found[0]!.done).toBe(true)
  })
})
