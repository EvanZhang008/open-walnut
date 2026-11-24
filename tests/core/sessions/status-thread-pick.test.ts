/**
 * Guard: the status question lists the threads that need a line, not only the ones changed last
 * (2026-11-24, the threads inspection: on his VP 25 of 91 open threads needed a line, his words
 * after the summary or an overdue reply, and 1 of them was among the 12 the question listed; each
 * line moved the same 12 first again). Every kind of need (needRank) is ranked before the plain
 * rest, newest first within a kind, and the 12 the question names are the neediest.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-pick'))

import { byNeed, needRank, noteListed, lastListed, resetListed } from '../../../src/core/sessions/status-thread-pick.js'
import { listForQuestion, THREAD_LIST_MAX, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import type { OrgThread, ThreadsFile } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-24T10:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
afterEach(() => { setThreadsKept(false); resetListed() })

/** A thread the node keeps pending, its summary written `min` minutes ago. */
const quiet = (n: number, min: number): OrgThread => ({
  id: `th-${String(n).padStart(6, '0')}`, title: `Quiet subject ${n}`, titled: true, state: 'pending', reply: `Handed on, step ${n} done.`,
  replyAt: ago(min), messages: [], createdAt: ago(min + 5), updatedAt: ago(min), by: 'task:lead-1',
}) as OrgThread

describe('the question lists the threads that need a line', () => {
  it('each need ranks before the plain rest', () => {
    const behind = { ...quiet(1, 600), messages: [{ id: 'tm-00000001', at: ago(300), text: 'and the gate too', via: 'chat' }] } as OrgThread
    const overdue = { ...quiet(2, 600), state: 'working', updatedAt: ago(120), replyAt: ago(120) } as OrgThread
    expect(needRank({ ...quiet(3, 1), asked: true }, NOW)).toBe(0)
    expect(needRank({ ...quiet(3, 1), joined: {} }, NOW)).toBe(1)
    expect(needRank(behind, NOW)).toBe(2)
    expect(needRank(overdue, NOW)).toBe(3)
    // An answer after its summary: another summary owed.
    const owed = { ...quiet(4, 60), messages: [{ id: 'tm-00000004', at: ago(90), text: 'the fence?', via: 'chat', answer: { text: 'Two metres.', at: ago(30) } }] } as OrgThread
    expect(needRank(owed, NOW)).toBe(4)
    // A card an older build stored asking him from outside needs ("waiting for your approval").
    expect(needRank({ ...quiet(3, 1), state: 'answered', reply: 'Built; waiting for your approval to ship.' }, NOW)).toBe(0)
    expect(needRank({ ...quiet(3, 1), untitled: true }, NOW)).toBe(5)
    expect(needRank({ ...quiet(3, 1), wrote: true }, NOW)).toBe(6)
    expect(needRank(quiet(3, 1), NOW)).toBe(7)
  })

  it('a thread leaves its need once it got its line', () => {
    const behind = { ...quiet(1, 600), messages: [{ id: 'tm-00000001', at: ago(300), text: 'and the gate too', via: 'chat' }] } as OrgThread
    expect(needRank(behind, NOW)).toBe(2)
    const lined = { ...behind, reply: 'The gate is on order too.', replyAt: ago(1), updatedAt: ago(1) } as OrgThread
    expect(needRank(lined, NOW)).toBe(7)
  })

  it('a held title brings the thread it reads like right after it (review: their merge was never asked)', () => {
    const like = quiet(1, 3000)
    const held = { ...quiet(2, 1), held: { like: like.id } } as OrgThread
    const needy = Array.from({ length: 14 }, (_, i) => ({ ...quiet(10 + i, 600), messages: [{ id: `tm-0000${10 + i}`, at: ago(300), text: 'more', via: 'chat' }] }) as OrgThread)
    const picked = byNeed([held, ...needy, like], NOW)
    expect(picked.slice(0, 2).map((t) => t.id)).toEqual([held.id, like.id])
  })

  it('below the needs the places go round: listed longest ago first, never listed first of all (review: the same 10 of 89 each turn)', () => {
    const rest = Array.from({ length: 20 }, (_, i) => quiet(30 + i, i + 1))
    const first = byNeed(rest, NOW, lastListed('lead-1')).slice(0, THREAD_LIST_MAX)
    expect(first.map((t) => t.id)).toEqual(rest.slice(0, THREAD_LIST_MAX).map((t) => t.id))
    noteListed('lead-1', first.map((t) => t.id), NOW)
    const second = byNeed(rest, NOW + 60_000, lastListed('lead-1')).slice(0, THREAD_LIST_MAX)
    // The 8 never listed come first, then the oldest-listed of the first round.
    expect(second.slice(0, 8).map((t) => t.id)).toEqual(rest.slice(THREAD_LIST_MAX).map((t) => t.id))
    noteListed('lead-1', second.map((t) => t.id), NOW + 60_000)
    const third = byNeed(rest, NOW + 120_000, lastListed('lead-1')).slice(0, THREAD_LIST_MAX)
    expect(new Set([...first, ...second, ...third].map((t) => t.id)).size).toBe(20)
  })

  it('fifteen quiet threads changed last and two old ones that need a line: both are among the 12 the question names', () => {
    setThreadsKept(true)
    const fresh = Array.from({ length: 15 }, (_, i) => quiet(10 + i, i + 1))
    const behind = { ...quiet(1, 2000), messages: [{ id: 'tm-00000001', at: ago(900), text: 'and the gate too', via: 'chat' }] } as OrgThread
    const overdue = { ...quiet(2, 2000), state: 'working', updatedAt: ago(1500), replyAt: ago(1500) } as OrgThread
    const file: ThreadsFile = { version: 1, taskId: 'lead-1', threads: [...fresh, behind, overdue] }
    const { listed } = listForQuestion(file, file.threads)
    // Newest first, the old ones fall past the cut.
    expect(listed.slice(0, THREAD_LIST_MAX).map((t) => t.id)).not.toContain(behind.id)
    const picked = byNeed(listed, NOW)
    expect(picked.slice(0, 2).map((t) => t.id)).toEqual([behind.id, overdue.id])
    // Newest first within the rest.
    expect(picked.slice(2, 5).map((t) => t.id)).toEqual(fresh.slice(0, 3).map((t) => t.id))
    const { refs } = threadQuestionBlock(picked, undefined, { org: true })
    expect([...refs.values()].map((r) => r.id)).toEqual(expect.arrayContaining([behind.id, overdue.id]))
    expect(refs.size).toBe(THREAD_LIST_MAX)
  })
})
