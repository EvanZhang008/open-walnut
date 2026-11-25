/**
 * Related threads beside a new one (experiment threads_related, src/core/org/thread-related.ts and
 * src/core/search/short-text-vectors.ts): the words lane, the meaning lane through a fake embedder,
 * the cap of five, closed within a week, what is never offered, the deadline, the hint text and its
 * byte bound, and the vector cache. Invented garden data; Chinese test data in \u escapes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrgThread } from '../../../src/core/org/threads-model.js'
import type { TreeThreads } from '../../../src/core/org/thread-same-subject.js'

const tree = vi.hoisted(() => ({ value: [] as unknown[], delayMs: 0 }))
vi.mock('../../../src/core/org/thread-same-subject.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/org/thread-same-subject.js')>()
  return {
    ...real,
    treeOpenThreads: async () => {
      if (tree.delayMs) await new Promise((r) => setTimeout(r, tree.delayMs))
      return tree.value
    },
  }
})

import {
  MEANING_DEADLINE_MS, RELATED_DEADLINE_MS, RELATED_HINT_MAX_BYTES, RELATED_MAX, lookupsSettled, meaningCosines, offerable, rankRelated,
  relatedForNewThread, relatedTextOf, relatedThreadsText, type RelatedThread,
} from '../../../src/core/org/thread-related.js'
import {
  SHORT_VECTOR_CACHE_MAX, passageVectors, setShortTextEmbedderForTests, shortVectorsCached, type ShortTextEmbedder,
} from '../../../src/core/search/short-text-vectors.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'

const NOW = Date.parse('2026-11-25T08:00:00Z')
const DAY = 24 * 3600_000
const NEW = 'th-0000new00001'
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const thread = (id: string, title: string, extra: Partial<OrgThread> = {}): OrgThread => ({
  id, title, state: 'working', messages: [], createdAt: iso(DAY), updatedAt: iso(DAY), ...extra,
} as OrgThread)
const closedAgo = (ms: number): Partial<OrgThread> => ({ closed: { how: 'acked', at: iso(ms), by: 'human' } as OrgThread['closed'] })

const OWN = { id: 'lead-1', title: 'Garden lead' }
const BELOW = { id: 'task-2', title: 'Orchard upkeep' }

let models = 0
/** A fake model: a text's vector is its topic's direction. Each fake is its own model, so a late batch of one never fills another's cache. */
function fakeEmbedder(opts: { queryMs?: number; passageMs?: number; fail?: boolean; running?: { query: boolean; passage: boolean } } = {}): ShortTextEmbedder & { passageCalls: number; queryCalls: number; batches: string[][]; up: { query: boolean; passage: boolean } } {
  const topic = (t: string): number[] => (/deer|fence|post/i.test(t) ? [100, 0, 0, 0] : /seed|sow/i.test(t) ? [0, 100, 0, 0] : [0, 0, 100, 0])
  const wait = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
  const e = {
    model: `fake-model-${++models}`, passageCalls: 0, queryCalls: 0, batches: [] as string[][],
    up: opts.running ?? { query: true, passage: true },
    running: () => e.up,
    async query(text: string) { e.queryCalls++; await wait(opts.queryMs); if (opts.fail) throw new Error('model gone'); return Int8Array.from(topic(text)) },
    async passages(texts: string[]) { e.passageCalls++; e.batches.push(texts); await wait(opts.passageMs); if (opts.fail) throw new Error('model gone'); return texts.map((t) => Int8Array.from(topic(t))) },
  }
  return e
}

afterEach(() => {
  setShortTextEmbedderForTests(undefined)
  tree.value = []
  tree.delayMs = 0
})

describe('which threads are offered', () => {
  it('open ones and ones closed within a week; never the new thread or a moved-away pointer', () => {
    expect(offerable(thread('th-a', 'Fence'), NOW, NEW)).toBe(true)
    expect(offerable(thread('th-b', 'Fence', closedAgo(6 * DAY)), NOW, NEW)).toBe(true)
    expect(offerable(thread('th-c', 'Fence', closedAgo(8 * DAY)), NOW, NEW)).toBe(false)
    expect(offerable(thread(NEW, 'Fence'), NOW, NEW)).toBe(false)
    expect(offerable(thread('th-d', 'Fence', { ...closedAgo(DAY), movedTo: { task: 'task-9', title: 'Elsewhere', at: iso(DAY) } } as Partial<OrgThread>), NOW, NEW)).toBe(false)
  })

  it('compares by title, ask and the first sentence of the summary', () => {
    expect(relatedTextOf({ title: 'Orchard fence', ask: 'How tall?', reply: 'Two metres keeps the deer out. The posts are set.' }))
      .toBe('Orchard fence. How tall?. Two metres keeps the deer out.')
  })
})

describe('the words lane', () => {
  it('finds his subject told in the words of a thread on the node and on a task below, and names whose it is', () => {
    const t: TreeThreads[] = [
      { task: OWN, threads: [thread('th-own1', 'Orchard fence posts'), thread('th-own2', 'Spring seed order')] },
      { task: BELOW, threads: [thread('th-low1', 'Deer under the orchard fence', { state: 'needs' })] },
    ]
    const { related } = rankRelated({ text: 'The orchard fence posts lean again after the rain', tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW })
    expect(related.map((r) => r.id)).toEqual(['th-own1', 'th-low1'])
    expect(related[0]).toMatchObject({ lanes: ['words'] })
    expect(related[0].task).toBeUndefined()
    expect(related[1].task).toEqual(BELOW)
  })

  it('one shared word is not enough', () => {
    const t: TreeThreads[] = [{ task: OWN, threads: [thread('th-own1', 'Orchard watering plan')] }]
    expect(rankRelated({ text: 'Paint the orchard shed green', tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW }).related).toEqual([])
  })

  it('two pairs of CJK characters in one place are one word, not two', () => {
    // Two pairs in one run ("fence wall ..."): one word, not enough. One pair in each of two runs ("orchard", "fence"): two places.
    const t: TreeThreads[] = [{ task: OWN, threads: [thread('th-cjk', '\u679c\u56ed \u7bf1\u7b06\u5899')] }]
    const one = rankRelated({ text: '\u7bf1\u7b06\u5899\u6f06\u6210\u767d\u8272', tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW })
    expect(one.related).toEqual([])
    const two = rankRelated({ text: '\u679c\u56ed\u91cc \u7bf1\u7b06\u574f\u4e86', tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW })
    expect(two.related.map((r) => r.id)).toEqual(['th-cjk'])
  })

  it('shows at most five, the best first', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa']
    const threads = Array.from({ length: 8 }, (_, i) => thread(`th-cap${i}`, `${words[2 * i]} ${words[2 * i + 1]}`, { updatedAt: iso(i * 1000) }))
    const { related } = rankRelated({ text: words.join(' '), tree: [{ task: OWN, threads }], selfTaskId: OWN.id, newThreadId: NEW, now: NOW })
    expect(related).toHaveLength(RELATED_MAX)
    // Equal scores: the newest first.
    expect(related.map((r) => r.id)).toEqual(['th-cap0', 'th-cap1', 'th-cap2', 'th-cap3', 'th-cap4'])
  })

  it('offers a thread closed this week as closed, not one closed last month, and never the new one or a pointer', () => {
    const t: TreeThreads[] = [{ task: OWN, threads: [
      thread('th-week', 'Orchard fence posts', closedAgo(3 * DAY)),
      thread('th-month', 'Orchard fence posts repaired', closedAgo(30 * DAY)),
      thread(NEW, 'Orchard fence posts lean'),
      thread('th-moved', 'Orchard fence posts', { ...closedAgo(DAY), movedTo: { task: BELOW.id, title: BELOW.title, at: iso(DAY) } } as Partial<OrgThread>),
    ] }]
    const { related } = rankRelated({ text: 'The orchard fence posts lean again', tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW })
    expect(related.map((r) => r.id)).toEqual(['th-week'])
    expect(related[0].closed).toBe(true)
  })
})

describe('the meaning lane', () => {
  it('puts a thread that shares no word on the list by its cosine, and ranks both lanes first', async () => {
    const t: TreeThreads[] = [{ task: OWN, threads: [
      thread('th-deer', 'Keep the deer out'),
      thread('th-fence', 'Fence posts lean'),
      thread('th-seed', 'Spring sowing'),
    ] }]
    const text = 'The fence posts lean after the storm'
    const rows = t[0].threads.map((x) => ({ id: x.id, text: relatedTextOf(x) }))
    const lane = await meaningCosines(fakeEmbedder(), text, rows, MEANING_DEADLINE_MS)
    expect(lane.semantic).toBe('on')
    const { related } = rankRelated({ text, tree: t, selfTaskId: OWN.id, newThreadId: NEW, now: NOW, cosines: lane.cosines })
    expect(related.map((r) => [r.id, r.lanes])).toEqual([['th-fence', ['words', 'meaning']], ['th-deer', ['meaning']]])
  })

  it('past its deadline the list is the words lane alone', async () => {
    const rows = [{ id: 'th-deer', text: 'Keep the deer out' }]
    const started = Date.now()
    const lane = await meaningCosines(fakeEmbedder({ queryMs: 5_000 }), 'fence', rows, 50)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(lane).toEqual({ cosines: new Map(), semantic: 'timeout' })
    expect((await meaningCosines(fakeEmbedder({ fail: true }), 'fence', rows, 50)).cosines.size).toBe(0)
  })
})

describe('the whole lookup', () => {
  it('a slow embedder, a failing one and a slow tree read never hold it past its deadline', async () => {
    tree.value = [{ task: OWN, threads: [thread('th-own1', 'Orchard fence posts'), thread('th-deer', 'Keep the deer out')] }]
    const text = 'The orchard fence posts lean again'
    for (const embedder of [fakeEmbedder({ queryMs: 5_000, passageMs: 5_000 }), fakeEmbedder({ fail: true }), null]) {
      const started = Date.now()
      const related = await relatedForNewThread({ taskId: OWN.id, text, newThreadId: NEW, now: NOW, embedder })
      expect(Date.now() - started).toBeLessThan(RELATED_DEADLINE_MS + 300)
      expect(related.map((r) => r.id)).toEqual(['th-own1'])
    }
    tree.delayMs = 5_000
    const started = Date.now()
    expect(await relatedForNewThread({ taskId: OWN.id, text, newThreadId: NEW, now: NOW, embedder: null })).toEqual([])
    expect(Date.now() - started).toBeLessThan(RELATED_DEADLINE_MS + 300)
  })

  it('with a working embedder, the meaning lane adds what words miss', async () => {
    tree.value = [{ task: OWN, threads: [thread('th-own1', 'Orchard fence posts'), thread('th-deer', 'Keep the deer out')] }]
    const related = await relatedForNewThread({ taskId: OWN.id, text: 'The orchard fence posts lean again', newThreadId: NEW, now: NOW, embedder: fakeEmbedder() })
    expect(related.map((r) => r.id)).toEqual(['th-own1', 'th-deer'])
  })
})

describe('only running workers', () => {
  const t = (): TreeThreads[] => [{ task: OWN, threads: [thread('th-own1', 'Orchard fence posts'), thread('th-deer', 'Keep the deer out')] }]
  const text = 'The orchard fence posts lean again'

  it('no worker running: nothing is asked of the model, the list is the words lane\'s', async () => {
    tree.value = t()
    const e = fakeEmbedder({ running: { query: false, passage: false } })
    const related = await relatedForNewThread({ taskId: OWN.id, text, newThreadId: NEW, now: NOW, embedder: e })
    expect(related.map((r) => r.id)).toEqual(['th-own1'])
    expect([e.queryCalls, e.passageCalls]).toEqual([0, 0])
    const rows = t()[0].threads.map((x) => ({ id: x.id, text: relatedTextOf(x) }))
    expect((await meaningCosines(e, text, rows, MEANING_DEADLINE_MS)).semantic).toBe('no-worker')
  })

  it('a query worker but no passage worker: only cached passages count, none is embedded', async () => {
    const e = fakeEmbedder({ running: { query: true, passage: false } })
    const rows = [{ id: 'th-deer', text: 'Keep the deer out' }]
    const lane = await meaningCosines(e, 'fence', rows, MEANING_DEADLINE_MS)
    expect(lane).toEqual({ cosines: new Map(), semantic: 'partial' })
    expect(e.passageCalls).toBe(0)
    e.up = { query: true, passage: true }
    expect((await meaningCosines(e, 'fence', rows, MEANING_DEADLINE_MS)).semantic).toBe('on')
    e.up = { query: true, passage: false }
    expect((await meaningCosines(e, 'fence', rows, MEANING_DEADLINE_MS)).cosines.get('th-deer')).toBe(1)
    expect(e.passageCalls).toBe(1)
  })

  it('passage batches go one after another, and stop when the worker goes away', async () => {
    const e = fakeEmbedder({ passageMs: 30 })
    const texts = Array.from({ length: 40 }, (_, i) => `rose bed ${i}`)
    const first = passageVectors(e, texts, 5_000)
    await new Promise((r) => setTimeout(r, 10))
    // One batch in flight, not all three at once.
    expect(e.passageCalls).toBe(1)
    e.up = { query: true, passage: false }
    expect((await first).size).toBe(16)
    expect(e.batches.map((b) => b.length)).toEqual([16])
  })
})

describe('his next message waits for the lookup before it', () => {
  it('lookupsSettled holds until the running lookup ends, and no longer than its deadline', async () => {
    tree.value = [{ task: OWN, threads: [thread('th-own1', 'Orchard fence posts')] }]
    tree.delayMs = 150
    const lookup = relatedForNewThread({ taskId: OWN.id, text: 'orchard fence posts', newThreadId: NEW, now: NOW, embedder: null })
    let started = Date.now()
    await lookupsSettled(OWN.id)
    expect(Date.now() - started).toBeGreaterThanOrEqual(120)
    await lookup
    started = Date.now()
    await lookupsSettled(OWN.id)
    expect(Date.now() - started).toBeLessThan(20)
  })

  it('a tree read past the deadline compares the node\'s own threads', async () => {
    tree.value = []
    tree.delayMs = 5_000
    const own = [thread('th-own1', 'Orchard fence posts')]
    const related = await relatedForNewThread({ taskId: OWN.id, text: 'The orchard fence posts lean again', newThreadId: NEW, now: NOW, embedder: null, own })
    expect(related.map((r) => r.id)).toEqual(['th-own1'])
  })
})

describe('the vector cache', () => {
  it('embeds a thread\'s text once, and a batch past the deadline fills it for the next call', async () => {
    const e = fakeEmbedder({ passageMs: 200 })
    setShortTextEmbedderForTests(e)
    const first = await passageVectors(e, ['Water the roses', 'Prune the pears'], 20)
    expect(first.size).toBe(0)
    expect(e.passageCalls).toBe(1)
    // Asked again while it still runs: it waits for the same batch, no second one.
    const second = await passageVectors(e, ['Water the roses', 'Prune the pears'], 1_000)
    expect(second.size).toBe(2)
    expect(e.passageCalls).toBe(1)
    const third = await passageVectors(e, ['Water the roses'], 0)
    expect(third.size).toBe(1)
    expect(e.passageCalls).toBe(1)
  })

  it('holds at most its cap, and forgets on a model switch', async () => {
    const e = fakeEmbedder()
    setShortTextEmbedderForTests(e)
    const texts = Array.from({ length: SHORT_VECTOR_CACHE_MAX + 10 }, (_, i) => `fence ${i}`)
    await passageVectors(e, texts, 5_000)
    expect(shortVectorsCached()).toBe(SHORT_VECTOR_CACHE_MAX)
    const other = fakeEmbedder()
    expect((await passageVectors(other, ['fence 20'], 1_000)).size).toBe(1)
    expect(shortVectorsCached()).toBe(SHORT_VECTOR_CACHE_MAX)
    expect(other.passageCalls).toBe(1)
  })
})

describe('what the agent reads', () => {
  const base: ThreadHintState = { threadId: NEW, title: 'the posts lean', created: true, followUp: false, duplicate: false, open: [{ id: 'th-own1', title: 'Orchard fence posts', state: 'working' }], closed: [] }
  const related: RelatedThread[] = [
    { id: 'th-own1', title: 'Orchard fence posts', state: 'working', lanes: ['words'] },
    { id: 'th-week', title: 'Fence posts', state: 'answered', closed: true, lanes: ['meaning'] },
    { id: 'th-low1', title: 'Deer under the orchard fence', state: 'needs', task: BELOW, lanes: ['words', 'meaning'] },
  ]

  it('one addition to the new thread\'s line, naming each thread and whose it is', () => {
    const text = threadHintText({ ...base, related })
    expect(text.startsWith(threadHintText(base))).toBe(true)
    expect(text.slice(threadHintText(base).length)).toBe(
      ` Related threads (its subject is one of yours: thread_update {"id":"${NEW}","merge_into":"<id>"}; another task's: that task keeps it, task_send it): `
      + 'th-own1 (yours); th-low1 "Deer under the orchard fence" (needs, on "Orchard upkeep" task-2).'
      + ' Related, closed this week (no merge: a new ask about it stays its own thread; read it, and say on the new card that it continues it): th-week "Fence posts" (yours).',
    )
  })

  it('stays within its byte bound however long the titles are', () => {
    const long = '\u679c\u56ed\u7684\u7bf1\u7b06'.repeat(40)
    const worst: RelatedThread[] = Array.from({ length: RELATED_MAX }, (_, i) => ({
      id: `th-${String(i).repeat(12)}`, title: long, state: 'answered', task: { id: '00000000-0000-4000-8000-00000000000' + i, title: long }, lanes: ['words'],
    }))
    const text = relatedThreadsText(worst, NEW)
    expect(text).toContain('th-000000000000')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RELATED_HINT_MAX_BYTES)
    expect(relatedThreadsText([], NEW)).toBe('')
  })

  it('a cut title never splits a character', () => {
    const text = relatedThreadsText([{ id: 'th-emoji', title: 'x'.repeat(58) + '\u{1F333}\u{1F333}\u{1F333}', state: 'working', lanes: ['words'] }], NEW)
    expect(text).toContain('x'.repeat(58) + '\u{1F333}\u2026')
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('no related threads: the line is today\'s, byte for byte', () => {
    expect(threadHintText({ ...base, related: [] })).toBe(threadHintText(base))
  })
})
