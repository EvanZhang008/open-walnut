/**
 * A plain Threads list draws a card from a task below that is listed only while his reply to it is
 * on its way with the ones in progress, never among the cards for him (thread-view.ts forHimInList;
 * 2026-11-23, the user, of such a card at the top of a task's Threads: "why this is working but
 * still show in the up there"). The groups already drew it in Working (thread-groups.ts).
 */
import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { forHimInList, listedForHim, type ViewThread } from '../../../src/core/org/thread-view.js'

const NOW = Date.parse('2026-11-23T19:30:00.000Z')
const owner = { task_id: 't-child', title: 'Oven review' }
type T = ViewThread & { id: string; state: string; updatedAt: string; title: string }
const base = { createdAt: '2026-11-23T19:00:00.000Z', updatedAt: '2026-11-23T19:20:00.000Z' }
/** A thread of the task below: he answered its question, and his reply has not reached that task yet. */
const onItsWay: T = { ...base, id: 'th-000000000001', title: 'Sign in again on the dev box', state: 'working', owner, messages: [{ id: 'tm-000000000001', at: '2026-11-23T19:20:00.000Z', text: 'Signed in, go on', delivery: { state: 'pending', at: '2026-11-23T19:20:00.000Z' } }] } as unknown as T
/** One of the task below that waits on him. */
const needs: T = { ...base, id: 'th-000000000002', title: 'Pick the oven vendor', state: 'needs', owner, reply: 'Pick one of the two vendors.', replyAt: base.updatedAt, messages: [], opener: { text: 'Which vendor?', at: base.createdAt, from: 'node' } } as unknown as T

describe('a card from below whose reply is on its way', () => {
  it('is listed (its words do not vanish) but drawn with the ones in progress, never for him', () => {
    const listed = listedForHim([onItsWay, needs], NOW)
    expect(listed.map((t) => t.id)).toEqual([onItsWay.id, needs.id])
    expect(forHimInList(listed, NOW).map((t) => t.id)).toEqual([needs.id])
  })

  it('the plain list draws its cards for him from forHimInList, and counts its chips by them', () => {
    const src = fs.readFileSync(`${process.cwd()}/web/src/components/org/OrgThreads.tsx`, 'utf8')
    expect(src).toContain('const forHim = forHimInList(listed, at);')
    expect(src).toContain('open: orderedForHim(forHim, { needsFirst }),')
    expect(src).toContain('const shownSet = new Set(forHim);')
    expect(src).toContain('useThreadOrigin(foldNode, all, forHimIds)')
  })
})
