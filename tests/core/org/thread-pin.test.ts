/**
 * Pinning a thread (src/core/org/threads-model.ts `pin`, src/core/org/thread-view.ts pinnedNow /
 * pinnedFirst; 2026-11-03, the user: "have a pin thread feature, like this thread I need to make it
 * pinned"): a pinned thread leads his view whatever its state, until he unpins or acknowledges it;
 * the node may pin and unpin too, but never takes off a pin of his; a pin moves no clock, so an
 * unpinned thread goes back to its place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, mergeThreads, normalizeThreads, setAnswers, sortedThreads, ThreadError, updateThread, type ThreadsFile, type ThreadWriter } from '../../../src/core/org/threads-model.js'
import { newsAt, pinnedFirst, pinnedNow, shownToHim, snoozedNow, threadCounts } from '../../../src/core/org/thread-view.js'

const T0 = Date.UTC(2026, 10, 3, 18, 0)
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const ms = (min: number) => T0 + min * 60_000
const NODE: ThreadWriter = 'task:lead-1'

/** Three threads: A answered (shown), B working (hidden), C pending (hidden), changed in that order. */
function three(): { f: ThreadsFile; a: string; b: string; c: string } {
  let f = emptyThreads('lead-1')
  const ids: string[] = []
  for (const [i, text] of ['pick a routing design', 'fix the watch list', 'hand off the docs'].entries()) {
    const r = fileMessage(f, { text, via: 'chat', at: at(i) })
    f = r.file
    ids.push(r.thread.id)
  }
  const [a, b, c] = ids
  const first = f.threads[0].messages[0].id
  f = setAnswers(f, new Map([[first, { text: 'Option 2.', at: at(4) }]])).file
  f = updateThread(f, a, { title: 'Routing', state: 'answered', reply: 'Option 2.' }, NODE, at(5)).file
  f = updateThread(f, b, { title: 'Watch list', state: 'working' }, NODE, at(6)).file
  f = updateThread(f, c, { title: 'Docs', state: 'pending' }, NODE, at(7)).file
  return { f, a, b, c }
}

const pin = (f: ThreadsFile, id: string, on: boolean, by: ThreadWriter = 'human', when = at(10)) => updateThread(f, id, { pin: on }, by, when).file
const byId = (f: ThreadsFile, id: string) => f.threads.find((t) => t.id === id)!
const order = (f: ThreadsFile) => sortedThreads(f.threads).map((t) => t.title)

describe('a pinned thread', () => {
  it('shows whatever its state, leads the list, and goes back to its place when unpinned', () => {
    const { f, b, c } = three()
    expect(shownToHim(byId(f, b), undefined, ms(10))).toBe(false)
    expect(order(f)).toEqual(['Docs', 'Watch list', 'Routing'])
    const p = pin(f, b, true)
    const t = byId(p, b)
    expect(t.pinned).toEqual({ at: at(10), by: 'human' })
    // A pin moves no clock: the thread keeps its change time and who changed it last.
    expect(t.updatedAt).toBe(byId(f, b).updatedAt)
    expect(t.by).toBe(byId(f, b).by)
    expect(pinnedNow(t)).toBe(true)
    expect(shownToHim(t, undefined, ms(10))).toBe(true)
    expect(order(p)).toEqual(['Watch list', 'Docs', 'Routing'])
    // A pending one too; the newest pin leads.
    const both = pin(p, c, true, 'human', at(11))
    expect(shownToHim(byId(both, c), undefined, ms(11))).toBe(true)
    expect(order(both)).toEqual(['Docs', 'Watch list', 'Routing'])
    expect(pinnedFirst(both.threads).map((x) => x.title)).toEqual(['Docs', 'Watch list', 'Routing'])
    const off = pin(pin(both, c, false), b, false)
    expect(order(off)).toEqual(order(f))
    expect(shownToHim(byId(off, b), undefined, ms(12))).toBe(false)
    expect(byId(off, b)).toEqual(byId(f, b))
  })

  it('a pin is no change time: the tab dot reads the thread\'s own last change, never the pin\'s', () => {
    const { f, a, b } = three()
    expect(newsAt(f.threads, undefined, ms(10))).toBe(byId(f, a).updatedAt)
    const p = pin(f, b, true, 'human', at(30))
    // B (working) now shows for the pin alone: neither its change (at 6) nor the pin (at 30) is news.
    expect(newsAt(p.threads, undefined, ms(31))).toBe(byId(f, a).updatedAt)
    expect(newsAt(pin(p, b, false, 'human', at(32)).threads, undefined, ms(33))).toBe(byId(f, a).updatedAt)
  })

  it('counts in the Threads count, names the title when nothing waits on him, and needs still lead', () => {
    const { f, a, b } = three()
    expect(threadCounts(f.threads, ms(10))).toEqual({ shown: 1, needs: 0, title: 'Routing', id: a })
    const p = pin(f, b, true)
    expect(threadCounts(p.threads, ms(10))).toEqual({ shown: 2, needs: 0, pinned: 1, title: 'Watch list', id: b, titlePinned: true })
    const needs = updateThread(p, a, { state: 'needs', user_kind: 'user_own', user_kind_why: 'He asked to pick the design himself.' }, NODE, at(12)).file
    expect(threadCounts(needs.threads, ms(12))).toEqual({ shown: 2, needs: 1, pinned: 1, title: 'Routing', id: a })
  })

  it('takes a snooze off, and a snooze of his takes his pin off; a pinned thread is never in Snoozed', () => {
    const { f, a } = three()
    const snoozed = updateThread(f, a, { snooze: at(120) }, 'human', at(8)).file
    expect(snoozedNow(byId(snoozed, a), ms(9))).toBe(true)
    const pinned = pin(snoozed, a, true)
    expect(byId(pinned, a).snoozed).toBeUndefined()
    expect(shownToHim(byId(pinned, a), undefined, ms(11))).toBe(true)
    const again = updateThread(pinned, a, { snooze: at(200) }, 'human', at(12)).file
    expect(byId(again, a).pinned).toBeUndefined()
    expect(snoozedNow(byId(again, a), ms(13))).toBe(true)
    // A hand-edited file holding both: the pin wins, never shown twice.
    const both = normalizeThreads({ threads: [{ ...byId(again, a), pinned: { at: at(12), by: 'human' } }] }, 'lead-1')
    expect(snoozedNow(both.threads[0], ms(13))).toBe(false)
    expect(shownToHim(both.threads[0], undefined, ms(13))).toBe(true)
    expect(() => updateThread(f, a, { pin: true, snooze: '4h' }, 'human', at(9))).toThrow(/cannot go together/)
  })

  it('ends with Acknowledge, and a closed thread is pinned only once reopened', () => {
    const { f, a } = three()
    const closed = updateThread(pin(f, a, true), a, { close: 'acked' }, 'human', at(20)).file
    expect(byId(closed, a).pinned).toBeUndefined()
    expect(shownToHim(byId(closed, a), undefined, ms(21))).toBe(false)
    expect(() => pin(closed, a, true)).toThrow(/reopen/)
    const back = updateThread(closed, a, { reopen: true, pin: true }, 'human', at(22)).file
    expect(byId(back, a).pinned).toEqual({ at: at(22), by: 'human' })
    expect(() => updateThread(f, a, { pin: true, close: 'acked' }, 'human', at(9))).toThrow(/cannot go together/)
  })

  it('a node may pin and unpin its own, but never unpin, snooze or close one he pinned', () => {
    const { f, a, b } = three()
    const own = pin(f, b, true, NODE)
    expect(byId(own, b).pinned).toEqual({ at: at(10), by: NODE })
    expect(byId(pin(own, b, false, NODE), b).pinned).toBeUndefined()
    // He pins the node's pin again: it becomes his.
    expect(byId(pin(own, b, true, 'human', at(11)), b).pinned).toEqual({ at: at(11), by: 'human' })
    const his = pin(f, a, true)
    for (const patch of [{ pin: false }, { snooze: '4h' }, { close: 'acked' as const }]) {
      try {
        updateThread(his, a, patch, NODE, at(12))
        throw new Error('not refused')
      } catch (err) {
        expect(err).toBeInstanceOf(ThreadError)
        expect((err as ThreadError).code).toBe('pinned_by_user')
        expect((err as ThreadError).status).toBe(409)
      }
    }
    // A node pinning his again keeps it his; its other writes go through and keep the pin.
    expect(byId(pin(his, a, true, NODE), a).pinned!.by).toBe('human')
    const replied = updateThread(his, a, { reply: 'Shipped option 2.' }, NODE, at(13)).file
    expect(byId(replied, a).pinned!.by).toBe('human')
  })

  it('goes with its messages in a merge, his pin first, and ends a snooze the target had', () => {
    const { f, a, b } = three()
    const his = pin(pin(f, b, true), a, true, NODE, at(11))
    const merged = mergeThreads(his, b, a, NODE, at(12)).file
    expect(merged.threads.find((t) => t.id === b)).toBeUndefined()
    expect(byId(merged, a).pinned).toEqual({ at: at(10), by: 'human' })
    const snoozedTarget = updateThread(pin(f, b, true), a, { snooze: at(300) }, 'human', at(11)).file
    const m2 = mergeThreads(snoozedTarget, b, a, NODE, at(12)).file
    expect(byId(m2, a).snoozed).toBeUndefined()
    expect(byId(m2, a).pinned!.by).toBe('human')
  })

  it('in the node\'s hands, lights the tab dot only with an answer, never with a merge or a working write', () => {
    const { f, a, b } = three()
    const p = pin(f, b, true)
    const seen = newsAt(p.threads, undefined, ms(10))
    // The node says it works on it, and merges a new message of his under it: no news.
    let g = updateThread(p, b, { state: 'working', reply: 'On it.' }, NODE, at(20)).file
    expect(byId(g, b).state).toBe('working')
    const r = fileMessage(g, { text: 'also check the phone', via: 'chat', at: at(21) })
    g = mergeThreads(r.file, r.thread.id, b, NODE, at(22)).file
    expect(newsAt(g.threads, undefined, ms(23))).toBe(seen)
    expect(byId(g, a).updatedAt <= seen!).toBe(true)
    // Its answer is news.
    g = setAnswers(g, new Map([[r.message.id, { text: 'Checked the phone too.', at: at(30) }]])).file
    expect(newsAt(g.threads, undefined, ms(31))).toBe(at(30))
  })

  it('reads safely from disk: an odd pin is dropped, a closed thread holds none', () => {
    const { f, a } = three()
    const raw = { threads: [{ ...byId(f, a), pinned: 'yes' }, { ...byId(pin(f, a, true), a), id: 'th-aaaaaa', closed: { how: 'acked', at: at(9), by: 'human' } }] }
    const n = normalizeThreads(raw, 'lead-1')
    expect(n.threads[0].pinned).toBeUndefined()
    expect(n.threads[1].pinned).toBeUndefined()
  })
})

/**
 * Every field a thread write takes reaches it from the user's route and the node's op: a new
 * ThreadPatch field the route drops (or the op does not offer) fails here.
 */
describe('thread write fields', () => {
  const root = path.resolve(__dirname, '../../..')
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
  const model = read('src/core/org/threads-model.ts')
  const block = /export interface ThreadPatch \{([\s\S]*?)\n\}/.exec(model)![1]
  const fields = [...block.matchAll(/^\s{2}([a-z_]+)\?:/gm)].map((m) => m[1])
  it('lists the fields', () => {
    expect(fields).toEqual(expect.arrayContaining(['pin', 'snooze', 'close', 'reopen', 'known']))
  })
  // Comments taken off first: a field named only in a doc comment is not passed on.
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('the route reads every field from the body', () => {
    const src = code('src/web/routes/org-threads-v1.ts')
    const listed = new Set([...(/for \(const k of \[([^\]]+)\] as const\)/.exec(src)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
    const missing = fields.filter((k) => !listed.has(k) && !new RegExp(`\\bb\\.${k}\\b|ids\\(b, '${k}'\\)`).test(src))
    expect(missing).toEqual([])
  })
  it('the op offers every field', () => {
    const src = code('src/ops/org-threads.ts')
    const op = src.slice(src.indexOf("name: 'thread_update'"), src.indexOf("name: 'thread_create'"))
    const missing = fields.filter((k) => !new RegExp(`\\b${k}: z\\.`).test(op))
    expect(missing).toEqual([])
  })
})
