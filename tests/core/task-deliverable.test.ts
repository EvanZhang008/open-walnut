/**
 * The lines a sender reads to decide by meaning whether new work is a task's own
 * (src/core/task-deliverable.ts): its deliverable, the words it was created with, its latest report.
 * Shown at the top of task_get, on search's task rows and task_list's by_meaning rows, so a lead
 * reads what an existing task was made to produce before it hands that task new work.
 *
 * Neutral rewrites of the dispatch audit of 2026-11-16: a code review's task in the same file as an
 * outage fix (same file, different deliverable), and a task whose description and User Request
 * drifted apart (a club form's task that had taken in the club's boat repairs).
 */
import { describe, expect, it } from 'vitest'
import { DELIVERABLE_MAX, LATEST_MAX, deliverableLine, firstRequestLine, latestLine, routingView } from '../../src/core/task-deliverable.js'
import { getOp } from '../../src/ops/registry.js'
import { withTaskRouting } from '../../src/ops/task-routing-rows.js'
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js'
import { DEFAULT_ORG_INSTRUCTIONS } from '../../src/core/org/core-instructions.js'

describe('deliverableLine', () => {
  it('reads the note\'s User Request first, as one line without markdown', () => {
    const note = '## Executive Summary\nMerged, rolling out.\n\n## User Request\nFrom the watch leader:\n- **CR 1** adds only `s3:ListBucket`.\n- CR 2 adds alarm dimensions.\n- (Former) the outage fix: moved to another task.\n\n## Progress\n- [DONE] CR 1'
    expect(deliverableLine({ title: 'CR: poller', note })).toBe('From the watch leader: CR 1 adds only s3:ListBucket. CR 2 adds alarm dimensions.')
  })

  it('an old note\'s "## Goal" counts as its User Request', () => {
    expect(deliverableLine({ title: 'x', note: '## Goal\nShip the export button.' })).toBe('Ship the export button.')
  })

  it('falls back to the description\'s first paragraph, then the title', () => {
    expect(deliverableLine({ title: 'T', description: 'Fix the login loop.\n\nBackground: long.' })).toBe('Fix the login loop.')
    expect(deliverableLine({ title: 'Repaint the garden fence', note: 'free-form note' })).toBe('Repaint the garden fence')
    expect(deliverableLine({})).toBe('')
  })

  it('clips a long request at a word', () => {
    const line = deliverableLine({ note: `## User Request\n${'word '.repeat(200)}` })
    expect(line.length).toBeLessThanOrEqual(DELIVERABLE_MAX + 1)
    expect(line.endsWith('word…')).toBe(true)
  })
})

const DRIFTED = {
  title: 'Club membership form for the year \u00b7 Boat Repairs',
  description: 'File the yearly rowing club membership form with the secretary (confirm by Oct 20).\n\nBackground: long.',
  note: '## User Request\nFile the yearly club form; also get the club boat repaired and answer the coach.',
  status_report: { state: 'working', at: '2026-11-14T05:53:00.000Z', now: 'Waiting on the boatyard quote.' },
  result_report: { at: '2026-10-20T10:00:00.000Z', result: 'Club form filed.' },
}

describe('firstRequestLine and latestLine', () => {
  it('shows the words a task was created with when its User Request says something else', () => {
    expect(firstRequestLine(DRIFTED)).toBe('File the yearly rowing club membership form with the secretary (confirm by Oct 20).')
    // With no User Request the description IS the deliverable line: nothing to add.
    expect(firstRequestLine({ description: 'Fix the login loop.' })).toBe('')
    expect(firstRequestLine({ description: 'Fix it.', note: '## User Request\nFix it.' })).toBe('')
  })

  it('reads the newest report, led by when and what kind', () => {
    expect(latestLine(DRIFTED)).toBe('2026-11-14 05:53 UTC working: Waiting on the boatyard quote.')
    expect(latestLine({ result_report: { at: '2026-11-17T00:06:51.930Z', result: 'Live: 2b41353d0.' }, status_report: { at: '2026-11-16T23:54:29.046Z', now: 'Waiting for prod.' } }))
      .toBe('2026-11-17 00:06 UTC result: Live: 2b41353d0.')
    expect(latestLine({ status_report: { at: 'not a time', now: 'x' } })).toBe('')
    expect(latestLine({}).length).toBe(0)
    const long = latestLine({ status_report: { at: '2026-11-16T00:00:00.000Z', now: 'word '.repeat(100) } })
    expect(long.length).toBeLessThanOrEqual('2026-11-16 00:00 UTC status: '.length + LATEST_MAX)
  })

  it('routingView holds only the lines that have words', () => {
    expect(routingView(DRIFTED)).toEqual({
      deliverable: 'File the yearly club form; also get the club boat repaired and answer the coach.',
      first_request: 'File the yearly rowing club membership form with the secretary (confirm by Oct 20).',
      latest: '2026-11-14 05:53 UTC working: Waiting on the boatyard quote.',
    })
    expect(routingView({})).toEqual({})
  })
})

describe('task_get', () => {
  it('puts the deliverable, first request and latest report beside the title at the top of its answer', async () => {
    await import('../../src/ops/index.js')
    const map = getOp('task_get')!.mapResult!
    const out = map({
      body: { task: { id: 'mabc0001-aaaa', phase: 'IN_PROGRESS', ...DRIFTED } },
      args: { id: 'mabc0001' },
    }) as Record<string, unknown>
    expect(Object.keys(out).slice(0, 6)).toEqual(['id', 'title', 'phase', 'deliverable', 'first_request', 'latest'])
    expect(out.first_request).toContain('rowing club membership form')
  })
})

describe('search\'s task rows carry what a sender reads', () => {
  // Same file, different deliverable: a code review's task and an outage fix in the same poller.
  const REVIEW = { id: 'mrev0001-aaaa', title: 'Code review: poller bucket-list permission', phase: 'IN_PROGRESS',
    note: '## User Request\nReview 1 adds only the bucket-list permission; review 2 adds alarm dimensions.' }
  const OUTAGE = { id: 'mout0001-aaaa', title: 'Region outage: poller did not fail over', phase: 'COMPLETE',
    description: 'Fix the poller so one zone going down does not stop it.',
    result_report: { at: '2026-11-16T19:37:51.000Z', result: 'Spread the pollers across zones; alarm fires early.' } }

  it('each task row gets its phase and lines; memory and session rows stay as they were', async () => {
    const paths: string[] = []
    const call = async (_m: string, p: string) => { paths.push(p); return { tasks: [REVIEW, OUTAGE] } }
    const out = await withTaskRouting({ results: [
      { type: 'task', taskId: REVIEW.id, title: REVIEW.title, score: 0.9 },
      { type: 'memory', title: 'poller notes' },
      { type: 'session', sessionId: 's1', taskId: OUTAGE.id },
      { type: 'task', taskId: OUTAGE.id, title: OUTAGE.title },
    ] }, call) as { results: Array<Record<string, unknown>> }
    expect(out.results[0]).toMatchObject({ phase: 'IN_PROGRESS', deliverable: 'Review 1 adds only the bucket-list permission; review 2 adds alarm dimensions.', score: 0.9 })
    expect(out.results[1]).toEqual({ type: 'memory', title: 'poller notes' })
    expect(out.results[2]).toEqual({ type: 'session', sessionId: 's1', taskId: OUTAGE.id })
    expect(out.results[3]).toMatchObject({ phase: 'COMPLETE', deliverable: 'Fix the poller so one zone going down does not stop it.', latest: '2026-11-16 19:37 UTC result: Spread the pollers across zones; alarm fires early.' })
    expect(paths).toHaveLength(1)
  })

  it('a failing read leaves search\'s answer as it was', async () => {
    const body = { results: [{ type: 'task', taskId: REVIEW.id }] }
    expect(await withTaskRouting(body, async () => { throw new Error('down') })).toBe(body)
    expect(await withTaskRouting({ results: [] }, async () => ({}))).toEqual({ results: [] })
  })

  it('the search op waits for the meaning lane and decorates its rows', async () => {
    await import('../../src/ops/index.js')
    const paths: string[] = []
    const call = async (_m: string, p: string) => {
      paths.push(p)
      return p.startsWith('/search') ? { results: [{ type: 'task', taskId: REVIEW.id }] } : { tasks: [REVIEW] }
    }
    const out = await getOp('search')!.handler!({ q: '\u8f6e\u8be2 poller', types: 'task', limit: 5 }, call) as { results: Array<Record<string, unknown>> }
    expect(paths[0]).toBe('/search?q=%E8%BD%AE%E8%AF%A2+poller&types=task&limit=5&semanticWaitMs=2500')
    expect(out.results[0]!.deliverable).toContain('bucket-list permission')
  })
})

describe('the routing process every session and every dispatcher reads', () => {
  it('names the three steps and no format of a message', () => {
    for (const line of [
      'Search two or three ways (the asker\'s words with their names or ids, a restatement, the other language)',
      'search matches meaning in open and finished tasks',
      'deliverable, first_request and latest',
      'task_history {limit:6, compact:true} if unclear',
      'Decide by meaning: the same issue\'s next step, a revision, a check, or a regression of what it delivered goes to it; otherwise task_create.',
      'One issue (an incident, a ticket, one cause) is one task',
      'its investigation, fixes, second change, comments and replies are its steps, never new tasks; it runs parallel parts with its own subagents or subtasks',
    ]) expect(TASK_ROUTING_CONTRACT).toContain(line)
    for (const role of ['main', 'lead'] as const) {
      expect(DEFAULT_ORG_INSTRUCTIONS[role]).toContain('Finding the owner is your main job')
      expect(DEFAULT_ORG_INSTRUCTIONS[role]).toContain('decide by meaning')
      expect(DEFAULT_ORG_INSTRUCTIONS[role]).toContain('One issue is one task')
      expect(DEFAULT_ORG_INSTRUCTIONS[role]).toContain('never a sibling task per step')
      expect(DEFAULT_ORG_INSTRUCTIONS[role]).toContain('that led the last round of a recurring duty')
    }
    expect(`${TASK_ROUTING_CONTRACT}\n${DEFAULT_ORG_INSTRUCTIONS.main}\n${DEFAULT_ORG_INSTRUCTIONS.lead}`).not.toMatch(/scope_mismatch|same_deliverable|CR's fix|ticket's/)
  })
})
