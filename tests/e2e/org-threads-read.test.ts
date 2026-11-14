/**
 * Reading an Org node's Threads the way the phone does (routes src/web/routes/org-threads-v1.ts;
 * 2026-11-06, the user on his phone: "it clearly shows 4 threads, but when I tap in there are none").
 * The phone read every thread with every answer, 1.08 MB for one VP, past what the companion
 * carries back from the Mac, so the companion answered from its own copy, which holds no threads.
 *
 *   1. each thread says whether his view shows it (`shown`), judged over ALL the node's threads,
 *      and the reply carries the count the node's status counts by (`shown_count`): the list and
 *      the header's number come from one rule, whatever part of the list a read asks for;
 *   2. `open=1` and `closed=1` split the list, `limit` keeps the newest, `answer_max` cuts each
 *      answer he already reacted to (`clipped`) so a read stays small, while an answer his card
 *      shows stays whole; one thread reads whole on its own route;
 *   3. every replica (the companion, a host replica), which keeps no Threads, answers 503 `primary_only`, never an empty list.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-threads-read'))
// Which replica this server plays for one case: the companion, or a host replica (not cloud mode).
const role = vi.hoisted(() => ({ kind: null as null | 'companion' | 'host' }))
vi.mock('../../src/core/server-role.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/server-role.js')>()
  return {
    ...real,
    isCompanion: () => role.kind === 'companion',
    isFollower: () => role.kind !== null,
    followerName: () => real.followerNameOf(role.kind, { WALNUT_HOST_LABEL: 'Test Box' }),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { threadCounts } from '../../src/core/org/thread-view.js'
import { clipAnswerText } from '../../src/web/routes/org-threads-v1.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let base = ''
let leadId = ''

const HOUR = 3600_000
// One clock for the whole fixture: a shared answer is the same reply only at the same instant.
const T0 = Date.now()
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString()
const LONG = 'word '.repeat(800).trim()
const LONG_UNSEEN = 'unseen '.repeat(600).trim()

function thread(id: string, state: OrgThread['state'], over: Partial<OrgThread> = {}): OrgThread {
  return {
    id, title: `Thread ${id}`, titled: true, state,
    messages: [{ id: `tm-${id.slice(3)}01`, at: iso(5 * HOUR), text: `ask ${id}`, via: 'chat' } as OrgThread['messages'][number]],
    createdAt: iso(6 * HOUR), updatedAt: iso(HOUR), ...over,
  } as OrgThread
}

/** Every kind his view judges: shown (needs, answered, pinned), hidden (pending, snoozed, working
 *  with nothing new, working with only the node's chat answer), closed; one answer shared with a
 *  closed thread. */
function fixture(): OrgThread[] {
  const answered = (id: string, text: string, at = iso(2 * HOUR)) => ({
    messages: [{ id: `tm-${id.slice(3)}01`, at: iso(5 * HOUR), text: `ask ${id}`, via: 'chat', answer: { text, at } }],
  }) as Partial<OrgThread>
  const open = [
    thread('th-a00001', 'needs'),
    // He reacted to this answer already (known): a cut read may cut it.
    thread('th-a00002', 'answered', { ...answered('th-a00002', LONG), known: { through: 'tm-a0000201' } } as Partial<OrgThread>),
    // Not reacted to yet: the card shows it, so it stays whole however long.
    thread('th-a00003', 'answered', answered('th-a00003', LONG_UNSEEN)),
    thread('th-a00004', 'working', { pinned: { at: iso(HOUR), by: 'human' } } as Partial<OrgThread>),
    thread('th-a00005', 'pending', answered('th-a00005', 'handed on')),
    thread('th-a00006', 'answered', { snoozed: { until: new Date(T0 + 5 * HOUR).toISOString(), at: iso(HOUR / 2) } } as Partial<OrgThread>),
    // His message a few minutes ago, nothing yet: the node's move, not overdue.
    thread('th-a00007', 'working', { messages: [{ id: 'tm-a0000701', at: iso(5 * 60_000), text: 'ask th-a00007', via: 'chat' }], updatedAt: iso(5 * 60_000) } as Partial<OrgThread>),
    // The node's chat answer on a working thread (only who took it): out of his view (2026-11-07).
    thread('th-a00009', 'working', { messages: [{ id: 'tm-a0000901', at: iso(2 * 60_000), text: 'ask th-a00009', via: 'chat', answer: { text: 'Handed to the phone team.', at: iso(60_000) } }], updatedAt: iso(90_000), by: 'task:lead' } as Partial<OrgThread>),
    // Its answer is the same reply as the closed th-c00002's: a shared answer, judged over both.
    thread('th-a00008', 'working', answered('th-a00008', 'one reply for two threads', iso(3 * HOUR))),
  ]
  const closed = [1, 2, 3].map((n) => thread(`th-c0000${n}`, 'answered', {
    ...(n === 2 ? answered(`th-c0000${n}`, 'one reply for two threads', iso(3 * HOUR)) : {}),
    closed: { how: 'acked', at: iso(n * HOUR), by: 'human' },
  } as Partial<OrgThread>))
  return [...open, ...closed]
}

async function read(query = ''): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${leadId}/threads${query}`)
}

type Reply = { threads: Array<OrgThread & { shown: boolean; messages: Array<{ answer?: { text: string; clipped?: true } }> }>; closed_count: number; shown_count: number }

beforeAll(async () => {
  leadId = (await ensureProjectLead('Orchard')).id
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${leadId}.json`), JSON.stringify({ version: 1, taskId: leadId, threads: fixture() }))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => { await stopServer() })

describe('reading Threads as the phone does', () => {
  it('says per thread whether his view shows it, by the count the node status uses', async () => {
    const all = (await (await read()).json()) as Reply
    const expected = threadCounts(fixture()).shown
    // needs, two answered, pinned; not pending, snoozed, working (with or without a chat answer), or the shared answer.
    expect(expected).toBe(4)
    expect(all.shown_count).toBe(expected)
    expect(all.threads.filter((t) => t.shown).length).toBe(expected)
    // The open part alone carries the same judgement: a list built from it agrees with the header.
    const open = (await (await read('?open=1')).json()) as Reply
    expect(open.threads.every((t) => !t.closed)).toBe(true)
    expect(open.threads.filter((t) => t.shown).length).toBe(expected)
    expect(open.shown_count).toBe(expected)
    expect(open.threads.find((t) => t.id === 'th-a00005')?.shown).toBe(false)
    expect(open.threads.find((t) => t.id === 'th-a00006')?.shown).toBe(false)
    expect(open.threads.find((t) => t.id === 'th-a00009')?.shown).toBe(false)
  })

  it('splits open and closed, keeps the newest closed, and cuts long answers', async () => {
    const closed = (await (await read('?closed=1&limit=2')).json()) as Reply
    expect(closed.threads.map((t) => t.id)).toEqual(['th-c00001', 'th-c00002'])
    expect(closed.closed_count).toBe(3)
    const cut = (await (await read('?open=1&answer_max=100')).json()) as Reply
    const answer = cut.threads.find((t) => t.id === 'th-a00002')!.messages[0].answer!
    expect(answer.clipped).toBe(true)
    expect(answer.text.length).toBeLessThanOrEqual(101)
    const onCard = cut.threads.find((t) => t.id === 'th-a00003')!.messages[0].answer!
    expect(onCard.clipped).toBeUndefined()
    expect(onCard.text).toBe(LONG_UNSEEN)
    // Cutting never changes what his view shows.
    expect(cut.threads.filter((t) => t.shown).length).toBe(threadCounts(fixture()).shown)
  })

  it('marks an answer shared with another thread, whatever part of the list a read asks for', async () => {
    const open = (await (await read('?open=1&answer_max=5')).json()) as Reply
    const msg = open.threads.find((t) => t.id === 'th-a00008')!.messages[0] as { shared?: true }
    expect(msg.shared).toBe(true)
    const solo = open.threads.find((t) => t.id === 'th-a00001')!.messages[0] as { shared?: true }
    expect(solo.shared).toBeUndefined()
  })

  it('cuts by code point, never inside an emoji, a tag or a code fence', () => {
    // A test of text data: "\u{1F600}" is an emoji (two UTF-16 units).
    const emoji = 'ab' + '\u{1F600}'.repeat(10)
    for (let max = 1; max < 12; max++) {
      const cut = clipAnswerText(emoji, max)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), `max ${max}`).toBe(false)
      expect(JSON.parse(JSON.stringify(cut))).toBe(cut)
    }
    expect(clipAnswerText('one two <walnut-task id="abc" label="x"/> more', 20)).toBe('one two\u2026')
    expect(clipAnswerText('see:\n```\ncode line one\ncode two', 22)).toBe('see:\u2026')
    expect(clipAnswerText('short', 20)).toBe('short')
  })

  it('gives one thread whole, for a Conversation opened after a cut read', async () => {
    const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads/th-a00002`)
    expect(res.status).toBe(200)
    const { thread } = (await res.json()) as { thread: Reply['threads'][number] }
    expect(thread.messages[0].answer?.text).toBe(LONG)
    expect(thread.shown).toBe(true)
    expect((await fetch(`${base}/api/v1/tasks/${leadId}/threads/th-ffffff`)).status).toBe(404)
  })

  // Every replica keeps no Threads, the companion and a host replica alike (2026-11-10, the user:
  // "cloud companion is just walnut replica server with some special capability").
  it.each([
    ['the companion', 'companion', 'The cloud companion could not get the threads from your Mac just now.'],
    ['a host replica (not cloud mode)', 'host', 'The Walnut server on Test Box could not get the threads from your Mac just now.'],
  ] as const)('%s, which keeps no Threads, refuses instead of answering an empty list, and says who could not reach the Mac', async (_name, kind, sentence) => {
    role.kind = kind
    try {
      const res = await read('?open=1')
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('primary_only')
      expect(body.error?.message).toBe(sentence)
      expect((await fetch(`${base}/api/v1/tasks/${leadId}/threads/th-a00001`)).status).toBe(503)
    } finally {
      role.kind = null
    }
  })
})
