/**
 * Walnut keeps the Threads (experiment threads_kept_by_walnut, src/core/org/threads-kept.ts;
 * 2026-11-22, the user, on a VP that wrote a thread before each reply: "every thread is being
 * updated, every question has to do this ... that's unbelievable, and very wasteful").
 *
 * On: Main and every lead are asked about their threads at the turn's end like any task that keeps
 * them; the answer's lines name an untitled thread and the answers he reacted to, and Walnut writes
 * them under its own checks (a known mark or a close he did not earn by writing after the answer is
 * refused, so a line can never mark what he never saw). Every prompt a thread keeper reads drops
 * the rules that ask for a write each turn, the `threads` hint stops asking for a title, and the
 * `threads-tidy` hint asks nothing. Off: everything as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-threads-kept'))

import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { asksThreads, placesAskOnThread, planThreadWrites, readThreadLines, threadQuestionBlock, wroteSinceAnswer } from '../../../src/core/sessions/status-threads.js'
import { readStatusReport } from '../../../src/core/session-hooks/builtins.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { orgRoleLine, THREADS_KEPT_LINE, THREADS_KEPT_OFF_LINE, TASK_THREADS_KEPT_LINE, TASK_THREADS_LINE } from '../../../src/core/sessions/session-context.js'
import { THREADS_KEPT_RULE, THREADS_KNOWN_RULE, THREADS_PENDING_RULE, THREADS_SUMMARY_RULE, PROOF_IN_PLACE_RULE, THREADS_OPEN_RULE } from '../../../src/core/org/thread-rules.js'
import { setBriefOff } from '../../../src/core/org/brief-off.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 22, 20, min)).toISOString()
afterEach(() => { setThreadsKept(false); setBriefOff(false) })

/** Run the planned writes the way threads-store.ts writeOwnThreads does: each in turn, a refused one left out. */
function apply(file: ThreadsFile, plan: ReturnType<typeof planThreadWrites>, when: string): ThreadsFile {
  for (const w of plan.writes) {
    for (const p of [w.patch, w.fallback]) {
      if (!p) continue
      try { file = updateThread(file, w.id, p, 'task:lead-1', when, undefined, { line: true }).file; break } catch (err) { if (!(err instanceof ThreadError)) throw err }
    }
  }
  return file
}

/** Two of his threads: "fence" answered at 1 and he wrote again at 5 (in another thread), "seeds" new and untitled. */
function twoThreads(): ThreadsFile {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'how tall should the orchard fence be?', via: 'chat', at: at(0) }).file
  const fence = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Two metres keeps the deer out.', at: at(1) }]])).file
  f = updateThread(f, fence, { title: 'Orchard fence', state: 'answered', reply: 'Two metres keeps the deer out.' }, 'task:lead-1', at(1)).file
  f = fileMessage(f, { text: 'ok, now order the seeds for spring', via: 'chat', at: at(5) }).file
  return f
}

describe('who is asked about its threads', () => {
  const main = { org_role: 'main' }, lead = { org_role: 'lead' }, router = { org_role: 'router' }, task = { threads_on: true }
  it('off: a task with Threads on only; on: Main and every lead too, never a router', () => {
    expect([main, lead, router, task].map((t) => asksThreads(t))).toEqual([false, false, false, true])
    setThreadsKept(true)
    expect([main, lead, router, task].map((t) => asksThreads(t))).toEqual([true, true, false, true])
  })
  it('an ask goes on a thread only for a task that is no Org node, on or off', () => {
    for (const on of [false, true]) {
      setThreadsKept(on)
      expect([main, lead, router, task].map((t) => placesAskOnThread(t))).toEqual([false, false, false, true])
    }
  })
})

describe('the question and its answer', () => {
  const open = [
    { id: 'th-aaaaaa01', title: 'Orchard fence', state: 'answered' as const, wrote: true },
    { id: 'th-aaaaaa02', title: 'ok, now order the seeds', state: 'new' as const, untitled: true },
    { id: 'th-aaaaaa03', title: 'Greenhouse vents', state: 'working' as const },
  ]
  it('off: the block is as before, with no marks and no title or reaction line', () => {
    const { block, refs } = threadQuestionBlock(open)
    expect(block).not.toMatch(/untitled|he wrote since|FOR_USER_THREAD_TITLE|FOR_USER_THREAD_SEEN/)
    expect([...refs.values()].some((r) => r.untitled || r.wrote)).toBe(false)
  })
  it('on: each thread says what it lacks, and only what is marked is asked', () => {
    setThreadsKept(true)
    const { block } = threadQuestionBlock(open, undefined, { org: true })
    expect(block).toContain('t1 "Orchard fence" (answered, he wrote since your answer)')
    expect(block).toContain('t2 "ok, now order the seeds" (new, untitled)')
    expect(block).toContain('t3 "Greenhouse vents" (working)')
    expect(block).toContain('FOR_USER_THREAD_TITLE: <ref> | <title>')
    expect(block).toContain('FOR_USER_THREAD_SEEN: <ref>, <ref>')
    // Main and a lead open no subject from a line, and ask him in needs.
    expect(block).not.toContain('FOR_USER_THREAD_NEW')
    expect(block).toContain('thread_update into needs')
    const plain = threadQuestionBlock([open[2]], undefined, { org: true }).block
    expect(plain).not.toMatch(/FOR_USER_THREAD_TITLE|FOR_USER_THREAD_SEEN/)
    // A task keeps its new-subject line and its FOR_USER_ASK rule; an Org node with no open thread is asked nothing.
    expect(threadQuestionBlock(open).block).toContain('FOR_USER_THREAD_NEW')
    expect(threadQuestionBlock([], undefined, { org: true }).block).toBe('')
  })
  it('reads a title only for an untitled thread and a reaction only where he wrote since, and ends no other field early', () => {
    setThreadsKept(true)
    const { refs } = threadQuestionBlock(open, undefined, { org: true })
    const answer = [
      'FOR_USER_STATE: working',
      'FOR_USER_NOW: The seeds are picked.',
      'FOR_USER_THREAD: t1 | done | Two metres, posts are set.',
      'FOR_USER_THREAD: t2 | working | Comparing two seed suppliers.',
      'FOR_USER_THREAD_TITLE: t2 | Spring seed order',
      'FOR_USER_THREAD_TITLE: t3 | Not untitled, dropped',
      '**FOR_USER_THREAD_SEEN:** t1, t3, t9',
      'FOR_USER_NEXT: I order once he picks.',
    ].join('\n')
    const lines = readThreadLines(answer, refs)
    expect(lines.thread_titles).toEqual([{ id: 'th-aaaaaa02', title: 'Spring seed order' }])
    expect(lines.threads_seen).toEqual(['th-aaaaaa01'])
    expect(lines.threads?.map((l) => l.state)).toEqual(['done', 'working'])
    const report = readStatusReport(answer)!
    expect(report.now).toBe('The seeds are picked.')
    expect(report.next).toBe('I order once he picks.')
  })
})

describe('the writes, under the model\'s own checks', () => {
  it('names the untitled thread, marks the answer he reacted to known, and closes the one that is done', () => {
    const f = twoThreads()
    const [fence, seeds] = f.threads
    expect(wroteSinceAnswer(f, fence)).toBe(true)
    expect(wroteSinceAnswer(f, seeds)).toBe(false)
    const lines = [
      { id: fence.id, title: fence.title, state: 'done' as const, progress: 'Two metres, posts are set.' },
      { id: seeds.id, title: seeds.title, state: 'working' as const, progress: 'Comparing two suppliers.' },
    ]
    const out = apply(f, planThreadWrites(f, lines, [], { titles: [{ id: seeds.id, title: 'Spring seed order' }], seen: [fence.id] }), at(6))
    const after = new Map(out.threads.map((t) => [t.id, t]))
    expect(after.get(fence.id)?.closed?.how).toBe('acked')
    expect(after.get(fence.id)?.known).toBeTruthy()
    expect(after.get(seeds.id)).toMatchObject({ title: 'Spring seed order', titled: true, state: 'working', reply: 'Comparing two suppliers.' })
  })

  it('a reaction he never wrote is refused: the answer stays in his sight, open, unmarked', () => {
    // Only the fence thread, answered at 1, and nothing from him since.
    let f = fileMessage(emptyThreads('lead-1'), { text: 'how tall should the orchard fence be?', via: 'chat', at: at(0) }).file
    const id = f.threads[0].id
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Two metres keeps the deer out.', at: at(1) }]])).file
    f = updateThread(f, id, { state: 'answered', reply: 'Two metres keeps the deer out.' }, 'task:lead-1', at(1)).file
    const out = apply(f, planThreadWrites(f, [{ id, title: 'x', state: 'done', progress: 'Two metres.' }], [], { seen: [id] }), at(2))
    const t = out.threads.find((x) => x.id === id)!
    expect(t.closed).toBeUndefined()
    expect(t.known).toBeUndefined()
    expect(t.state).toBe('answered')
  })

  it('a title never replaces one the node or he gave', () => {
    const f = twoThreads()
    const fence = f.threads[0]
    expect(planThreadWrites(f, [], [], { titles: [{ id: fence.id, title: 'Another name' }] }).writes).toEqual([])
  })
})

describe('what a thread keeper reads', () => {
  const lead = { id: 'lead-1', title: 'Garden VP', org_role: 'lead' as const }
  const task = { id: 't-1', title: 'Seed order', threads_on: true }
  const perTurn = [THREADS_SUMMARY_RULE, THREADS_PENDING_RULE, THREADS_KNOWN_RULE]

  it('on: every prompt variant carries the kept rule and none of the rules that ask for a write each turn', () => {
    setThreadsKept(true)
    const variants: Array<[string, string]> = []
    for (const off of [false, true]) {
      setBriefOff(off)
      variants.push([`lead, brief ${off ? 'off' : 'on'}`, orgRoleLine(lead as never)], [`main, brief ${off ? 'off' : 'on'}`, orgRoleLine({ ...lead, org_role: 'main' } as never)])
    }
    variants.push(['task', orgRoleLine(task as never)], ['THREADS_KEPT_LINE', THREADS_KEPT_LINE], ['THREADS_KEPT_OFF_LINE', THREADS_KEPT_OFF_LINE], ['TASK_THREADS_KEPT_LINE', TASK_THREADS_KEPT_LINE])
    for (const [name, text] of variants) {
      expect(text, name).toContain(THREADS_KEPT_RULE)
      expect(text, name).toContain(PROOF_IN_PLACE_RULE)
      expect(text, name).toContain(THREADS_OPEN_RULE)
      for (const rule of perTurn) expect(text, `${name} still asks for a write each turn`).not.toContain(rule)
    }
  })
  it('off: as before', () => {
    for (const text of [orgRoleLine(lead as never), orgRoleLine(task as never)]) {
      expect(text).not.toContain(THREADS_KEPT_RULE)
      for (const rule of perTurn) expect(text).toContain(rule)
    }
  })
  it('a running task hears the switch: its Threads block is another version', () => {
    expect(TASK_THREADS_KEPT_LINE.split('\n')[0]).not.toBe(TASK_THREADS_LINE.split('\n')[0])
    expect(TASK_THREADS_KEPT_LINE).toMatch(/^Threads, the user's setting for your task \(v[0-9a-f]{8}\): /)
  })
  it('the threads hint on a new thread asks no title; a merge stays the node\'s', () => {
    const s: ThreadHintState = { threadId: 'th-aaaaaa02', title: 'ok, now order', created: true, followUp: false, duplicate: false, open: [], closed: [] }
    const withOpen = { ...s, open: [{ id: 'th-aaaaaa01', title: 'Orchard fence', state: 'answered' as const }] }
    expect(threadHintText(s)).toContain('short title')
    setThreadsKept(true)
    expect(threadHintText(s)).toBe('filed as new thread th-aaaaaa02.')
    expect(threadHintText(withOpen)).toContain('merge_into')
    expect(threadHintText(withOpen)).not.toContain('title')
  })
})
