/**
 * His lists order threads by what he reads changing, never by every write (2026-11-24, the threads
 * inspection, item 11: a reworded title, a seen mark, a task link, a message split out or joined by
 * timing moved `updatedAt` and re-sorted the list under him; the order hold lasts only while the
 * pointer is over the list). thread-view.ts changedForHimAt, orderedForHim; thread-groups.ts.
 *
 * The guard at the end fails when a list of his in thread-view.ts, thread-groups.ts or the web's
 * org components sorts by `updatedAt` again.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { changedForHimAt, orderedForHim } from '../../../src/core/org/thread-view.js'
import { groupThreads } from '../../../src/core/org/thread-groups.js'
import { emptyThreads, fileMessage, SAME_CONVERSATION_MS, updateThread, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const T0 = Date.parse('2026-11-24T12:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

/** Two answered cards: the fence (summary at 10) above the seed order (summary at 5). */
function two(): ThreadsFile {
  let f = emptyThreads('lead-1')
  for (const [text, title, reply, min] of [['what seeds for spring?', 'Spring seeds', 'Forty trays of beans and peas.', 5], ['how tall is the fence?', 'Orchard fence', 'Two metres keeps the deer out.', 10]] as const) {
    const r = fileMessage(f, { text, via: 'chat', at: at(min - 1) })
    f = updateThread(r.file, r.thread.id, { title, state: 'answered', reply }, 'task:lead-1', at(min)).file
  }
  return f
}
const order = (f: ThreadsFile) => orderedForHim(f.threads).map((t) => t.title)
const seeds = (f: ThreadsFile) => f.threads.find((t) => t.title.startsWith('Spring'))!

describe('what moves a card in his list', () => {
  it('a write that changes nothing he reads leaves it in its place', () => {
    const f = two()
    expect(order(f)).toEqual(['Orchard fence', 'Spring seeds'])
    const id = seeds(f).id
    const writes: Array<[string, ThreadsFile]> = [
      ['a task link', updateThread(f, id, { add_tasks: ['t-seed'] } as never, 'task:lead-1', at(20)).file],
      ['a state with the same words', updateThread(f, id, { state: 'pending' }, 'task:lead-1', at(21)).file],
      ['his message joined by timing, not checked', fileMessage(f, { text: 'also the shed roof leaks', via: 'chat', at: at(11), joinRecent: SAME_CONVERSATION_MS }).file],
    ]
    for (const [what, w] of writes) {
      const t = w.threads.find((x) => x.id === id)!
      if (what !== 'his message joined by timing, not checked') expect(t.updatedAt, what).not.toBe(seeds(f).updatedAt)
      expect(order(w), what).toEqual(['Orchard fence', 'Spring seeds'])
    }
  })

  it('a new summary, a hand-over to him, his own message on it or an answer moves it up', () => {
    const f = two()
    const id = seeds(f).id
    const moves: Array<[string, (t: OrgThread) => OrgThread]> = [
      ['a new summary', (t) => ({ ...t, reply: 'Forty trays, and the peas went in today.', replyAt: at(30) })],
      ['handed to him', (t) => ({ ...t, state: 'needs', needsAt: at(30) })],
      ['his message on it', (t) => ({ ...t, messages: [...t.messages, { id: 'tm-seed0002', at: at(30), text: 'add carrots', via: 'chat' }] })],
      ['an answer', (t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, answer: { text: 'Carrots added.', at: at(30) } })) })],
    ]
    for (const [what, move] of moves) {
      const w = { ...f, threads: f.threads.map((t) => (t.id === id ? move(t) : t)) }
      expect(order(w)[0], what).toBe('Spring seeds')
    }
  })

  it('the groups order by it too, and a row of an older shape reads its updatedAt', () => {
    const f = two()
    const moved = { ...f, threads: f.threads.map((t) => (t.title.startsWith('Spring') ? { ...t, updatedAt: at(50) } : t)) }
    expect(groupThreads(moved.threads, T0 + 3600_000).read.map((t) => t.title)).toEqual(['Orchard fence', 'Spring seeds'])
    expect(changedForHimAt({ updatedAt: at(7) })).toBe(at(7))
  })
})

describe('guard: no list of his sorts by updatedAt', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const files = ['src/core/org/thread-view.ts', 'src/core/org/thread-groups.ts',
    ...fs.readdirSync(path.join(ROOT, 'web/src/components/org')).filter((f) => /\.tsx?$/.test(f)).map((f) => `web/src/components/org/${f}`)]
  it('sorts and newest-picks read changedForHimAt', () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(text, `${f} orders threads by updatedAt: use changedForHimAt (thread-view.ts)`).not.toMatch(/updatedAt\.localeCompare|\.updatedAt\s*[<>]\s*\w+\.updatedAt/)
    }
  })
})
