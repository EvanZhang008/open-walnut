/**
 * Watching a thread (src/core/org/threads-model.ts `watch`, src/core/org/thread-view.ts watchedNow /
 * watchingOf; a pin from 2026-11-03, made a watch on 2026-11-23, the user, translated: "turn it into
 * a watch ... its own category ... of course it is still in working or whatever, but at the same
 * time it is in Watching ... the same idea as our tasks"): a watched thread is on his Watching list
 * while it is open AND stays where its state puts it; a watch moves no clock and nothing in his
 * view, counts or tab dot; he orders Watching (`watch_at`); the node may watch and unwatch too, but
 * never ends a watch of his.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, liftLegacyWatch, mergeThreads, normalizeThreads, setAnswers, sortedThreads, ThreadError, updateThread, type OrgThread, type ThreadsFile, type ThreadWriter } from '../../../src/core/org/threads-model.js'
import { listedForHim, newsAt, shownToHim, snoozedNow, watchedNow, watchingOf } from '../../../src/core/org/thread-view.js'
import { groupThreads, threadCounts } from '../../../src/core/org/thread-groups.js'
import { ackKnown } from '../../../src/core/org/thread-ack.js'
import { settleHeldThread } from '../../../src/core/org/held-thread-model.js'

const T0 = Date.UTC(2026, 10, 23, 18, 0)
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

const watch = (f: ThreadsFile, id: string, on: boolean, by: ThreadWriter = 'human', when = at(10)) => updateThread(f, id, { watch: on }, by, when).file
const byId = (f: ThreadsFile, id: string) => f.threads.find((t) => t.id === id)!
const order = (f: ThreadsFile) => sortedThreads(f.threads).map((t) => t.title)
const watching = (f: ThreadsFile) => watchingOf(f.threads).map((t) => t.title)

describe('a watched thread', () => {
  it('is on his Watching list AND stays where its state puts it; a watch moves no clock, and unwatched it is as before', () => {
    const { f, b, c } = three()
    const w = watch(f, b, true)
    const t = byId(w, b)
    expect(t.watched).toEqual({ at: at(10), by: 'human' })
    expect(t.updatedAt).toBe(byId(f, b).updatedAt)
    expect(t.by).toBe(byId(f, b).by)
    expect(watchedNow(t)).toBe(true)
    expect(watching(w)).toEqual(['Watch list'])
    // Its own group: still Working, out of his list, in the same place (the whole order unchanged).
    expect(shownToHim(t, undefined, ms(10))).toBe(false)
    expect(groupThreads(w.threads, ms(10)).working.map((x) => x.title)).toEqual(['Watch list'])
    expect(order(w)).toEqual(order(f))
    // A second watch lands at the bottom of Watching.
    const both = watch(w, c, true, 'human', at(11))
    expect(watching(both)).toEqual(['Watch list', 'Docs'])
    const off = watch(watch(both, c, false), b, false)
    expect(watching(off)).toEqual([])
    expect(byId(off, b)).toEqual(byId(f, b))
  })

  it('changes nothing he is counted or dotted for: the counts name it only among the threads he is shown', () => {
    const { f, a, b } = three()
    const before = threadCounts(f.threads, ms(10))
    expect(before).toEqual({ shown: 1, needs: 0, title: 'Routing', id: a })
    const w = watch(f, b, true, 'human', at(30))
    expect(threadCounts(w.threads, ms(31))).toEqual(before)
    expect(newsAt(w.threads, undefined, ms(31))).toBe(newsAt(f.threads, undefined, ms(31)))
    expect(listedForHim(w.threads, ms(31)).map((t) => t.id)).toEqual(listedForHim(f.threads, ms(31)).map((t) => t.id))
    // Watching the shown one: counted as watched, and it names the row when nothing waits on him.
    const wa = watch(f, a, true)
    expect(threadCounts(wa.threads, ms(10))).toEqual({ shown: 1, needs: 0, watched: 1, title: 'Routing', id: a, titleWatched: true })
  })

  it('is ordered by where he places it (watch_at), oldest first; a place needs a watch', () => {
    const { f, a, b, c } = three()
    let w = watch(watch(watch(f, a, true, 'human', at(10)), b, true, 'human', at(11)), c, true, 'human', at(12))
    expect(watching(w)).toEqual(['Routing', 'Watch list', 'Docs'])
    w = updateThread(w, c, { watch_at: at(9) }, 'human', at(13)).file
    expect(watching(w)).toEqual(['Docs', 'Routing', 'Watch list'])
    // A place moves no clock and keeps who watches it.
    expect(byId(w, c).updatedAt).toBe(byId(f, c).updatedAt)
    expect(byId(w, c).watched).toEqual({ at: at(9), by: 'human' })
    expect(() => updateThread(f, a, { watch_at: at(9) }, 'human', at(13))).toThrow(/not watched/)
    expect(() => updateThread(w, a, { watch: false, watch_at: at(9) }, 'human', at(13))).toThrow(/cannot go with watch false/)
    expect(() => updateThread(w, a, { watch_at: 'soon' }, 'human', at(13))).toThrow(/ISO datetime/)
  })

  it('goes on with a snooze: snoozed, it is in Snoozed and still on Watching', () => {
    const { f, a } = three()
    const w = watch(f, a, true)
    const s = updateThread(w, a, { snooze: at(120) }, 'human', at(11)).file
    expect(snoozedNow(byId(s, a), ms(12))).toBe(true)
    expect(watching(s)).toEqual(['Routing'])
    expect(groupThreads(s.threads, ms(12)).waiting.map((x) => x.title)).toContain('Routing')
    // Watching a snoozed one keeps its snooze too.
    const s2 = watch(updateThread(f, a, { snooze: at(120) }, 'human', at(8)).file, a, true)
    expect(byId(s2, a).snoozed).toBeTruthy()
  })

  it('stays through his Acknowledge and his message; leaves Watching when closed and comes back when reopened', () => {
    const { f, a, b } = three()
    const w = watch(f, b, true)
    expect(byId(ackKnown(w, b, at(12)).file, b).watched).toEqual({ at: at(10), by: 'human' })
    const r = fileMessage(w, { threadId: b, text: 'and the phone too', via: 'follow-up', at: at(13) })
    expect(r.thread.watched).toEqual({ at: at(10), by: 'human' })
    const closed = updateThread(watch(f, a, true), a, { close: 'acked' }, 'human', at(20)).file
    expect(watchedNow(byId(closed, a))).toBe(false)
    expect(watching(closed)).toEqual([])
    expect(() => watch(closed, a, true)).toThrow(/reopen/)
    const back = updateThread(closed, a, { reopen: true }, 'human', at(22)).file
    expect(watching(back)).toEqual(['Routing'])
    expect(() => updateThread(f, a, { watch: true, close: 'acked' }, 'human', at(9))).toThrow(/cannot go together/)
  })

  it('a held item nobody needs any more leaves a thread he watches open as answered; one he did not watch closes', () => {
    const { f, a } = three()
    const held = updateThread(f, a, { state: 'needs', user_kind: 'user_own', user_kind_why: 'He asked to decide the routing himself.' }, 'human', at(9)).file
    const withLetter = { ...held, threads: held.threads.map((t) => (t.id === a ? { ...t, letter: {} } as OrgThread : t)) }
    const plain = settleHeldThread(withLetter, a, 'letter', { kind: 'moot', words: 'Settled elsewhere.' }, at(20))!
    expect(plain.thread.closed?.how).toBe('dropped')
    const kept = settleHeldThread(watch(withLetter, a, true), a, 'letter', { kind: 'moot', words: 'Settled elsewhere.' }, at(20))!
    expect(kept.thread.closed).toBeUndefined()
    expect(kept.thread.state).toBe('answered')
    expect(watching(kept.file)).toEqual(['Routing'])
    // His own answer, or his own moot, closes it as before.
    expect(settleHeldThread(watch(withLetter, a, true), a, 'letter', { kind: 'moot', words: 'x', byHim: true }, at(20))!.thread.closed?.how).toBe('dropped')
  })

  it('a node may watch and unwatch its own, and snooze his, but never unwatch or close one he watches', () => {
    const { f, a, b } = three()
    const own = watch(f, b, true, NODE)
    expect(byId(own, b).watched).toEqual({ at: at(10), by: NODE })
    expect(byId(watch(own, b, false, NODE), b).watched).toBeUndefined()
    // He watches the node's watch again: it becomes his, in the same place.
    expect(byId(watch(own, b, true, 'human', at(11)), b).watched).toEqual({ at: at(10), by: 'human' })
    const his = watch(f, a, true)
    for (const patch of [{ watch: false }, { close: 'acked' as const }]) {
      try {
        updateThread(his, a, patch, NODE, at(12))
        throw new Error('not refused')
      } catch (err) {
        expect(err).toBeInstanceOf(ThreadError)
        expect((err as ThreadError).code).toBe('watched_by_user')
        expect((err as ThreadError).status).toBe(409)
      }
    }
    expect(byId(updateThread(his, a, { snooze: '4h' }, NODE, at(12)).file, a).watched!.by).toBe('human')
    // A node watching his again keeps it his; its other writes go through and keep the watch.
    expect(byId(watch(his, a, true, NODE), a).watched!.by).toBe('human')
    expect(byId(updateThread(his, a, { reply: 'Shipped option 2.' }, NODE, at(13)).file, a).watched!.by).toBe('human')
  })

  it('goes with its messages in a merge, his watch first, and leaves the target\'s snooze alone', () => {
    const { f, a, b } = three()
    const both = watch(watch(f, b, true), a, true, NODE, at(11))
    const merged = mergeThreads(both, b, a, NODE, at(12)).file
    expect(merged.threads.find((t) => t.id === b)).toBeUndefined()
    expect(byId(merged, a).watched).toEqual({ at: at(10), by: 'human' })
    const snoozedTarget = updateThread(watch(f, b, true), a, { snooze: at(300) }, 'human', at(11)).file
    const m2 = mergeThreads(snoozedTarget, b, a, NODE, at(12)).file
    expect(byId(m2, a).snoozed).toBeTruthy()
    expect(byId(m2, a).watched!.by).toBe('human')
  })

  it('reads safely from disk: a pin of the build before is a watch, an odd one is dropped, a closed one holds none', () => {
    const { f, a } = three()
    const t = byId(f, a)
    const raw = { threads: [
      { ...t, pinned: { at: at(9), by: NODE } },
      { ...t, id: 'th-bbbbbb', pinned: { at: at(9) } },
      { ...t, id: 'th-cccccc', watched: 'yes' },
      { ...t, id: 'th-dddddd', pinned: { at: at(9), by: 'human' }, closed: { how: 'acked', at: at(9), by: 'human' } },
    ] }
    const n = normalizeThreads(raw, 'lead-1').threads
    expect(n.map((x) => x.watched)).toEqual([{ at: at(9), by: NODE }, { at: at(9), by: 'human' }, undefined, undefined])
    expect(n.every((x) => !('pinned' in x))).toBe(true)
    // The Threads database's rows are lifted the same way (threads-db.ts loadNode).
    const row = liftLegacyWatch({ ...t, pinned: { at: at(9), by: 'human' } } as OrgThread)
    expect(row.watched).toEqual({ at: at(9), by: 'human' })
    expect('pinned' in row).toBe(false)
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
    expect(fields).toEqual(expect.arrayContaining(['watch', 'watch_at', 'snooze', 'close', 'reopen', 'known']))
  })
  // Comments taken off first: a field named only in a doc comment is not passed on.
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('the route reads every field from the body', () => {
    const src = code('src/web/routes/org-threads-v1.ts')
    const listed = new Set([...(/for \(const k of \[([^\]]+)\] as const\)/.exec(src)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
    const missing = fields.filter((k) => !listed.has(k) && !new RegExp(`\\bb\\.${k}\\b|ids\\(b, '${k}'\\)`).test(src))
    expect(missing).toEqual([])
  })
  // Read from the registered op, not its source text: the input is a named const (UPDATE_INPUT) since 2026-11-21.
  it('the op offers every field', async () => {
    const { getOp } = await import('../../../src/ops/index.js')
    const input = getOp('thread_update')!.input as Record<string, unknown>
    const missing = fields.filter((k) => !Object.hasOwn(input, k))
    expect(missing).toEqual([])
  })
})
