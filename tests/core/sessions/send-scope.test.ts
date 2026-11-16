/**
 * task_send's scope check (src/core/sessions/send-scope.ts): a session's message that names work
 * its open target does not hold is refused with 409 scope_mismatch; a follow-up of the target's
 * own deliverable goes through.
 *
 * The headline case is the real one of 2026-11-16, rewritten with neutral names and numbers: a
 * lead handed a regional outage's half-done fix, written by another task, to an open task whose
 * deliverable was an earlier code review in the same package and file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _injectScopeDepsForTesting, checkSendScope, extractScopeRefs, holdsRef, SCOPE_MISMATCH_CODE,
} from '../../../src/core/sessions/send-scope.js'
import type { Task } from '../../../src/core/types.js'
import { NOT_REF_SAMPLES, REF_SAMPLES, SAMPLE_TASK_ID } from '../../helpers/scope-ref-samples.js'

const LEAD = 'mlead001-aaaa'
const REVIEW_TASK = 'aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const INVESTIGATOR = SAMPLE_TASK_ID
const REVIEW_CHILD = 'dddd3333-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PEER = 'eeee4444-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MAIN = 'mmain001-aaaa'

const task = (t: Partial<Task> & { id: string; title: string }): Task => ({ phase: 'IN_PROGRESS', ...t } as Task)

let tasks: Map<string, Task>
let priorAsks: string[]
let up: boolean

beforeEach(() => {
  tasks = new Map([
    [LEAD, task({ id: LEAD, title: 'Router VP', org_role: 'lead', note: '## Executive Summary\nCR-555000111 and CR-555000222 and INC-9001 are all on the board.' })],
    [MAIN, task({ id: MAIN, title: 'Main', org_role: 'main' })],
    // The target: an open task that owns ONE code review in the router package.
    [REVIEW_TASK, task({
      id: REVIEW_TASK, parent_task_id: 'mwatch01-bbbb',
      title: 'CR: acme-router poller ListBucket + alarm dimensions',
      tags: ['cr:https://reviews.example.test/CR-555000111'],
      note: '## User Request\nFrom the lead: CR 1 adds only read access on the cache bucket (CR-555000111). '
        + 'CR 2, when the leader says so: dimensions on two alarms.\n\n## Work Log\n- CR-555000111 merged; prod mid-rollout.',
    })],
    // Another task investigated the outage and left a half-done fix in its own directory.
    [INVESTIGATOR, task({ id: INVESTIGATOR, title: 'Region outage: poller did not fail over' })],
    [REVIEW_CHILD, task({ id: REVIEW_CHILD, parent_task_id: REVIEW_TASK, title: 'Reviewer for CR-555000111' })],
    [PEER, task({ id: PEER, title: 'acme-router alarm wording', note: '## User Request\nFix the alarm text. My change is CR-555000333.' })],
  ])
  priorAsks = []
  up = false
  _injectScopeDepsForTesting({
    getTask: async (id) => tasks.get(id) ?? [...tasks.values()].find((t) => t.id.startsWith(id)),
    priorAsks: async () => priorAsks,
    goesUp: async () => up,
  })
})
afterEach(() => _injectScopeDepsForTesting(null))

/** The lead's message of the real case, with neutral names, a fake path and numbers. */
const handoff = (extra = '') => [
  'Today\'s outage in one region exposed two faults in the router poller, the same code you are fixing, so it is yours. '
  + 'Another task wrote half of it; no new task for it.',
  `Facts (found by task ${INVESTIGATOR.slice(0, 8)}, notes at /home/u/.local/state/open-walnut/tasks/${INVESTIGATOR}/outage-notes.md):`,
  '- both pollers sat in one zone; the subtraction at lib/service_stacks.ts:156 leaves one task.',
  `Half-done: patches at /home/u/.local/state/open-walnut/tasks/${INVESTIGATOR}/router.patch. ${extra}`,
].join('\n')

describe('the real case of 2026-11-16, rewritten', () => {
  it('refuses the lead\'s handoff of another task\'s half-done outage fix to the code-review task', async () => {
    const v = await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: handoff('Open it as CR-555000444.') })
    expect(v.kind).toBe('refuse')
    if (v.kind !== 'refuse') return
    expect(v.status).toBe(409)
    expect(v.code).toBe(SCOPE_MISMATCH_CODE)
    expect(v.detail.refs).toEqual([
      { kind: 'review', ref: 'CR-555000444' },
      { kind: 'task_files', ref: INVESTIGATOR, title: 'Region outage: poller did not fail over' },
    ])
    // The target's deliverable is quoted, and both ways on are named.
    expect(v.message).toContain('Its deliverable: "From the lead: CR 1 adds only read access on the cache bucket')
    expect(v.message).toContain('The same package, component or file is not the same deliverable')
    expect(v.message).toContain('task_create')
    expect(v.message).toContain('same_deliverable:"<why>"')
  })

  it('refuses it even with no CR number at all: the other task\'s files are its work', async () => {
    const v = await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: handoff() })
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.detail.refs).toEqual([{ kind: 'task_files', ref: INVESTIGATOR, title: 'Region outage: poller did not fail over' }])
  })

  it('a lead\'s own note holding every team\'s numbers does not make them the target\'s', async () => {
    const v = await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'Also take INC-9001 and CR-555000222.' })
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect((v.detail.refs as Array<{ ref: string }>).map((r) => r.ref)).toEqual(['CR-555000222', 'INC-9001'])
  })
})

describe('normal follow-ups of the same deliverable are never refused', () => {
  it('a number the target holds (title, tags, note), however written', async () => {
    for (const text of [
      'CR-555000111 has a new revision: please rebase it.',
      'cr 555000111 failed its build again',
      'See https://reviews.example.test/CR-555000111 for the reviewer comment.',
      'Start CR 2 now (the dimensions), as your request says.',
    ]) {
      expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text })).kind, text).toBe('pass')
    }
  })

  it('a revision the target made itself, once its report holds it', async () => {
    tasks.get(REVIEW_TASK)!.status_report = { state: 'working', now: 'Draft CR-555000666 is up for the dimensions.' } as never
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'CR-555000666 looks right, publish it.' })).kind).toBe('pass')
  })

  it('a number the target was already sent in an earlier request', async () => {
    priorAsks = ['Pick up TKT-4242 as part of CR 2 (same alarms).']
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'Where is TKT-4242 at?' })).kind).toBe('pass')
  })

  it('files of the target\'s own subtask, and of the sender itself', async () => {
    const own = `Review notes at /x/tasks/${REVIEW_CHILD}/review.md`
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: own })).kind).toBe('pass')
    const mine = `My evidence: /x/tasks/${PEER}/alarm.png`
    expect((await checkSendScope({ callerTaskId: PEER, targetTaskId: REVIEW_TASK, text: mine })).kind).toBe('pass')
  })

  it('a worker telling another owner about its own change (a dependency between two CRs)', async () => {
    const v = await checkSendScope({ callerTaskId: PEER, targetTaskId: REVIEW_TASK, text: 'CR-555000333 merged: your CR 2 can go after it.' })
    expect(v.kind).toBe('pass')
  })

  it('a note up the org, a COMPLETE target, an org node, a message with no refs', async () => {
    up = true
    expect((await checkSendScope({ callerTaskId: REVIEW_TASK, targetTaskId: LEAD, text: 'CR-555000999 is mine now' })).kind).toBe('pass')
    up = false
    tasks.get(PEER)!.phase = 'COMPLETE'
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: PEER, text: 'CR-555000999' })).kind).toBe('pass')
    expect((await checkSendScope({ callerTaskId: PEER, targetTaskId: MAIN, text: 'CR-555000999' })).kind).toBe('pass')
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'How is the rollout going?' })).kind).toBe('pass')
  })
})

describe('what the review of 2026-11-16 found refused wrongly', () => {
  it('a follow-up of a ref that passed before (with same_deliverable) is not refused again', async () => {
    const first = await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'Answer the comment on CR-555000444',
      sameDeliverable: 'It is the CR 2 of your own request, opened by the reviewer' })
    expect(first.kind).toBe('lead')
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'CR-555000444: one more comment' })).kind).toBe('pass')
  })

  it('a number the target reported in its own answer, before its note holds it', async () => {
    let seen: readonly string[] = []
    _injectScopeDepsForTesting({
      getTask: async (id) => tasks.get(id),
      priorAsks: async (_id, sessions) => { seen = sessions; return ['{"result":"Draft CR-555000777 is up"}'] },
      goesUp: async () => false,
    })
    tasks.get(REVIEW_TASK)!.session_id = 'sess-review'
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'CR-555000777 looks right' })).kind).toBe('pass')
    expect(seen).toContain('sess-review')
  })

  it('a leader pointing one of its subtasks at another subtask\'s files (a reviewer reading the brief)', async () => {
    const IMPL = 'ffff5555-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const REVIEWER = 'abab6666-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    tasks.set(IMPL, task({ id: IMPL, parent_task_id: PEER, title: 'Implement the alarm wording' }))
    tasks.set(REVIEWER, task({ id: REVIEWER, parent_task_id: PEER, title: 'Review the alarm wording' }))
    // Handed by someone who leads neither, they are another task's work.
    expect((await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEWER, text: `Read /x/tasks/${IMPL}/brief.md` })).kind).toBe('refuse')
    const v = await checkSendScope({ callerTaskId: PEER, targetTaskId: REVIEWER, text: `Read /x/tasks/${IMPL}/brief.md and review it.` })
    expect(v.kind).toBe('pass')
  })
})

describe('same_deliverable', () => {
  it('needs a reason, then leads the delivered text with one line naming the refs', async () => {
    const short = await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'Take CR-555000444', sameDeliverable: 'yes' })
    expect(short).toMatchObject({ kind: 'refuse', status: 400, code: 'bad_request' })
    const ok = await checkSendScope({
      callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'Take CR-555000444',
      sameDeliverable: 'It is the CR 2 of your own request, opened by the reviewer',
    })
    expect(ok.kind).toBe('lead')
    if (ok.kind === 'lead') {
      expect(ok.line).toContain('The sender says this is your own deliverable ("It is the CR 2 of your own request, opened by the reviewer")')
      expect(ok.line).toContain('CR-555000444')
    }
  })
})

describe('what counts as a ref', () => {
  it('reads code reviews, pull requests, issue keys, tickets and incidents (English and Chinese), and task files', () => {
    expect(extractScopeRefs(REF_SAMPLES.join('\n')).map((r) => r.ref)).toEqual([
      'CR-123456', 'PR-4321', 'MR-9999', 'PR-77', 'ABC-42', 'CVE-2026-12345', '31415926', '27182818', '16180339', '16180340', '14142135', '17320508',
      INVESTIGATOR, 'mabcdef1-zz99',
    ])
  })

  it('leaves out what only looks like one: standards, hashes, models, request ids, dates, places, paths of no task', () => {
    expect(extractScopeRefs(NOT_REF_SAMPLES.join('\n'))).toEqual([])
  })

  it('matches a held number as a whole number only', () => {
    const ref = extractScopeRefs('CR-555000111')[0]
    expect(holdsRef('see CR-555000111.', ref)).toBe(true)
    expect(holdsRef('reviews/555000111', ref)).toBe(true)
    expect(holdsRef('CR-5550001119', ref)).toBe(false)
    expect(holdsRef('nothing here', ref)).toBe(false)
  })
})

describe('it never blocks a send it cannot judge', () => {
  it('fails open on an error', async () => {
    _injectScopeDepsForTesting({
      getTask: async () => { throw new Error('store down') },
      priorAsks: async () => [],
      goesUp: async () => false,
    })
    expect(await checkSendScope({ callerTaskId: LEAD, targetTaskId: REVIEW_TASK, text: 'CR-555000444' })).toEqual({ kind: 'pass', skipped: 'error' })
  })
})
