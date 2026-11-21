/**
 * The first thread above a chat is the first of the ones that wait on him (experiment top_thread;
 * web/src/components/org/top-thread-model.ts, src/core/org/thread-groups.ts threadsForHim;
 * 2026-11-20, the user: "Only one type, is just called thread ... right now thread has 16, but top
 * only has 1, not right ... top only show one but will show how many left ... top can be hide").
 *
 *  - its N is the header's and the Threads tab's count (threadCounts.shown), with threads of tasks
 *    below (one whose reply is on its way included), snoozed, pinned, quiet and closed ones in the mix;
 *  - its order: the pinned first, then the ones that need him, then the ones to read, each newest
 *    change first; the Threads view orders the same way under the flag, and as before without it;
 *  - a thread that leaves the list gives its place to the next one;
 *  - an Action needed item that is not a thread still shows; a letter that became a thread does not;
 *  - Hide is kept in the view memory (a reload reads it back).
 * The browser flow is tests/e2e/browser/top-thread.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { listedForHim, orderedForHim } from '../../src/core/org/thread-view.js'
import { threadCounts } from '../../src/core/org/thread-groups.js'
import type { ActionItem } from '../../src/core/action-needed.js'
import type { OrgThread } from '../../web/src/api/org-threads'
import { TOP_HIDDEN_VIEW, actionsNotThreads, hiddenLine, topIndex, topThreads } from '../../web/src/components/org/top-thread-model'
import { isBoolean, shownText, storedView, viewKey, writeView } from '../../web/src/utils/view-memory'

const NOW = Date.parse('2026-11-20T08:00:00.000Z')
const at = (min: number) => new Date(NOW - (120 - min) * 60_000).toISOString()

let seq = 0
function thread(state: OrgThread['state'], updated: number, extra: Partial<OrgThread> = {}): OrgThread {
  const id = `th-${++seq}`
  const msgAt = at(updated - 1)
  return {
    id, title: `Thread ${id}`, state, createdAt: at(0), updatedAt: at(updated),
    messages: [{
      id: `${id}-m`, at: msgAt, text: 'Is the seed order in?', via: 'chat',
      // An answered thread with an answer he has not reacted to: something to read.
      ...(state === 'answered' ? { answer: { text: 'Yes, it ships Monday.', at: at(updated) } } : {}),
    }],
    ...extra,
  } as OrgThread
}

/** A node like the user's VP: several that need him, many to read, plus every kind his view leaves out. */
function realNode(): OrgThread[] {
  seq = 0
  return [
    thread('answered', 90), thread('needs', 30), thread('answered', 100), thread('needs', 80),
    ...Array.from({ length: 12 }, (_, i) => thread('answered', 40 + i)),
    thread('answered', 110, { pinned: { at: at(60), by: 'human' } }),
    // Out of his sight: working, pending, closed, snoozed.
    thread('working', 115), thread('pending', 116),
    thread('answered', 117, { closed: { how: 'acked', at: at(117), by: 'human' } }),
    thread('needs', 118, { snoozed: { until: new Date(NOW + 3600_000).toISOString(), at: at(118), by: 'human' } }),
    // A task below: one that waits on him, one whose wait is over.
    thread('needs', 70, { owner: { task_id: 'task-below', title: 'Order the trays' } }),
    thread('working', 119, { owner: { task_id: 'task-below', title: 'Order the trays' } }),
  ]
}

describe('the top steps through the Threads view\'s own list', () => {
  it('its N is the count the header and the Threads tab show', () => {
    const all = realNode()
    const list = topThreads(all, NOW)
    expect(list.length).toBe(threadCounts(all, NOW).shown)
    expect(list.length).toBe(listedForHim(all, NOW).length)
    // 2 needs + 1 pinned + 14 to read + 1 below = 18; none of the hidden ones.
    expect(list.length).toBe(18)
    const states = new Set(list.map((t) => t.state))
    expect(states).toEqual(new Set(['needs', 'answered']))
    expect(list.some((t) => t.closed || t.snoozed)).toBe(false)
  })

  // 2026-11-21, the user, on a VP whose row read "1 thread" while its Threads showed no such card:
  // "It show 1 but there isn't any". His reply on it makes it the task's move (Working), not his.
  it('a thread below whose reply is on its way is listed in Working, never counted nor on top', () => {
    const all = realNode()
    const before = threadCounts(all, NOW).shown
    const below = all[all.length - 1]!
    below.messages[0] = { ...below.messages[0]!, delivery: { state: 'pending', at: at(119) } }
    expect(listedForHim(all, NOW).map((t) => t.id)).toContain(below.id)
    expect(topThreads(all, NOW).map((t) => t.id)).not.toContain(below.id)
    expect(threadCounts(all, NOW).shown).toBe(before)
    expect(topThreads(all, NOW).length).toBe(threadCounts(all, NOW).shown)
  })

  it('orders the pinned first, then the ones that need him, then the ones to read, each newest first', () => {
    const list = topThreads(realNode(), NOW)
    expect(list[0]!.pinned).toBeTruthy()
    const rest = list.slice(1)
    const firstRead = rest.findIndex((t) => t.state !== 'needs')
    expect(rest.slice(0, firstRead).every((t) => t.state === 'needs')).toBe(true)
    expect(rest.slice(firstRead).every((t) => t.state !== 'needs')).toBe(true)
    for (const group of [rest.slice(0, firstRead), rest.slice(firstRead)]) {
      const times = group.map((t) => t.updatedAt)
      expect(times).toEqual([...times].sort().reverse())
    }
    // The thread of a task below that waits on him counts with the ones that need him.
    expect(rest.slice(0, firstRead).some((t) => t.owner)).toBe(true)
  })

  it('the Threads view orders the same way under the flag, and newest change first without it', () => {
    const listed = listedForHim(realNode(), NOW)
    expect(orderedForHim(listed, { needsFirst: true }).map((t) => t.id)).toEqual(topThreads(realNode(), NOW).map((t) => t.id))
    const today = orderedForHim(listed)
    expect(today[0]!.pinned).toBeTruthy()
    const times = today.slice(1).map((t) => t.updatedAt)
    expect(times).toEqual([...times].sort().reverse())
  })

  it('a thread that leaves the list gives its place to the next one', () => {
    const list = topThreads(realNode(), NOW)
    expect(topIndex(list, null, 0)).toBe(0)
    expect(topIndex(list, list[3]!.id, 0)).toBe(3)
    // He replied to the 4th: it is working now and out of the list; the 4th place shows the next.
    const after = list.filter((_, i) => i !== 3)
    expect(after[topIndex(after, list[3]!.id, 3)]!.id).toBe(list[4]!.id)
    // The last one left: the new last one.
    expect(topIndex(after.slice(0, 2), list[3]!.id, 3)).toBe(1)
    expect(topIndex([], null, 2)).toBe(-1)
  })

  it('the hidden line counts them and the ones that need him', () => {
    const list = topThreads(realNode(), NOW)
    expect(hiddenLine(list)).toBe('18 threads (3 need you)')
    expect(hiddenLine(list.filter((t) => t.state !== 'needs' || t.owner))).toBe('16 threads (1 needs you)')
    expect(hiddenLine(list.filter((t) => t.state !== 'needs'))).toBe('15 threads')
    expect(hiddenLine(list.slice(-1))).toBe('1 thread')
  })
})

describe('Action needed items above the top thread', () => {
  const item = (kind: ActionItem['kind'], id: string): ActionItem => ({ kind, id, summary: `${kind} ${id}` })
  it('keeps every item that is not a thread the top shows, and drops a letter a listed thread was opened from', () => {
    const items = [item('permission', 'req-1'), item('approval', 'apr-1'), item('letter', 'lt-a'), item('letter', 'lt-b'), item('letter', 'lt-c'), item('ask', 'ask-1')]
    seq = 100
    const opener = (ref: string, min = 49) => ({ opener: { text: 'Ship the Mac app?', at: at(min), from: 'letter', ref, by: 'node' } })
    const threads = [
      thread('needs', 50, opener('lt-a')),
      // A closed thread is no longer where he answers it: its letter shows again.
      thread('needs', 50, { ...opener('lt-b'), closed: { how: 'acked', at: at(51), by: 'human' } }),
      // Out of the list (the node's move after his reply): its letter shows, so it never vanishes from both.
      thread('working', 119, opener('lt-c', 118)),
    ]
    expect(actionsNotThreads(items, topThreads(threads, NOW)).map((i) => i.id)).toEqual(['req-1', 'apr-1', 'lt-b', 'lt-c', 'ask-1'])
    expect(actionsNotThreads(items, [])).toEqual(items)
  })
})

describe('Hide is kept', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    }
  })
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

  it('in the view memory under an open-walnut- key, so a reload and another device read it back', () => {
    const key = viewKey(TOP_HIDDEN_VIEW.page, TOP_HIDDEN_VIEW.name)
    expect(key.startsWith('open-walnut-')).toBe(true)
    expect(storedView(shownText(key), null, isBoolean)).toBeUndefined()
    writeView(key, null, true)
    // A fresh load reads it from storage.
    expect(storedView(store.get(key) ?? null, null, isBoolean)).toBe(true)
    writeView(key, null, false)
    expect(storedView(store.get(key) ?? null, null, isBoolean)).toBe(false)
  })

  it('the component keeps it with usePageView, never in component state', () => {
    const src = fs.readFileSync('web/src/components/org/TopThread.tsx', 'utf8')
    expect(src).toMatch(/usePageView\(TOP_HIDDEN_VIEW\.page, TOP_HIDDEN_VIEW\.name, false, isBoolean\)/)
  })
})
