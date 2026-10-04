/**
 * The phone's inbox on a cloud REPLICA while the primary (the Mac) is out of reach.
 *
 * 2026-10-03, measured on the user's companion: 29 inbox loads and 13 read
 * marks answered `503 bridge_offline` in one day, although the replica held a
 * complete git-synced copy of every letter. So whenever the Mac slept the inbox
 * stopped updating and every read the human made was taken back. This pins the
 * replacement:
 *
 *  - reads answer from the synced copy when the primary cannot be reached
 *    (`servedFrom: 'mirror'`), and from the primary whenever it answers;
 *  - read / pin / archive taken while unreachable are queued durably, shown at
 *    once, replayed with the moment the human made them (`since`) when the
 *    primary is back, and kept on top of the copy until the copy's own clock
 *    reaches the primary's stamp (the Mac can sleep inside its git tick);
 *  - the primary stays the authority whenever it answers: its refusals pass
 *    through, a superseded replay is dropped, a 404 on replay drops the change.
 *
 * Real express app, real router, real store reading a real copy on disk. The
 * ONLY mock is the bridge call (callPrimaryControl): this box has no primary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo, Server } from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-replica-offline', { CLOUD_MODE: true }))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }

/** The fake primary: how it behaves, and every call it got. */
const { primary } = vi.hoisted(() => ({
  primary: {
    mode: 'offline' as 'offline' | 'timeout' | 'old' | 'online',
    calls: [] as Array<{ action: string; params: Record<string, unknown> }>,
    /** Answers while online. */
    answer: null as null | ((action: string, params: Record<string, unknown>) => Reply),
  },
}))

vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...actual,
    callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown> = {}) => {
      primary.calls.push({ action, params })
      if (primary.mode === 'offline') {
        return { ok: false, failure: { kind: 'bridge_offline', message: 'Your primary box (Mac) is offline', notSent: true } }
      }
      if (primary.mode === 'timeout') {
        return { ok: false, failure: { kind: 'bridge_offline', message: 'bridge request timed out', notSent: false } }
      }
      if (primary.mode === 'old') {
        return { ok: false, failure: { kind: 'needs_upgrade', message: 'old primary' } }
      }
      if (!primary.answer) throw new Error('online with no answer scripted')
      return primary.answer(action, params)
    },
  }
})

import { HUMAN_INBOX_QUEUE_DIR } from '../../src/constants.js'
import { humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import { flushStateQueue, readStateEntries } from '../../src/core/human-inbox/replica-state.js'
import { humanInboxV1Router } from '../../src/web/routes/human-inbox-v1.js'
import type { LetterRecord, LetterSender } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-replica', host: 'workstation' }

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', humanInboxV1Router)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  fs.rmSync(HUMAN_INBOX_QUEUE_DIR, { recursive: true, force: true })
  primary.mode = 'offline'
  primary.calls.length = 0
  primary.answer = null
})

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

/** Two letters in the synced copy, as git-sync leaves them on the replica. */
async function seedCopy(): Promise<{ older: string; newer: string }> {
  const older = (await sendLetter({ subject: 'Weekly digest', type: 'review', markdown: '# Digest\nItems.', sender: SENDER })).id
  await new Promise(r => setTimeout(r, 3))
  const newer = (await sendLetter({ subject: 'Deploy finished', type: 'completion', markdown: 'All hosts updated.', sender: SENDER })).id
  return { older, newer }
}

/** git-sync bringing the primary's index: flags plus its content clock. */
function syncCopy(patch: (letters: LetterRecord[]) => void, lastUpdated: string): void {
  const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')) as { letters: LetterRecord[]; lastUpdated: string }
  patch(raw.letters)
  raw.lastUpdated = lastUpdated
  fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(raw))
}

function queueFiles(): string[] {
  try { return fs.readdirSync(HUMAN_INBOX_QUEUE_DIR).filter(n => n.endsWith('.json')) } catch { return [] }
}

/** A primary that takes flag writes and stamps a clock, and answers lists itself. */
function onlinePrimary(stamp: string, opts: { superseded?: boolean; status404?: boolean } = {}): void {
  primary.mode = 'online'
  primary.answer = (action, params) => {
    if (action === 'server.human-inbox') return { ok: true, result: { letters: [], unreadCount: 0, fromPrimary: true } }
    if (action === 'server.human-inbox.get') return { ok: true, result: { letter: { id: params.id, fromPrimary: true } } }
    if (opts.status404) {
      return { ok: false, failure: { kind: 'error', status: 404, code: 'not_found', message: `Letter not found: ${String(params.id)}` } }
    }
    return {
      ok: true,
      result: {
        letter: { id: params.id, read: params.read, pinned: params.pinned, archived: params.archived },
        storeUpdatedAt: stamp,
        ...(opts.superseded ? { superseded: true } : {}),
      },
    }
  }
}

describe('reads while the primary is unreachable', () => {
  it('the list comes from the synced copy, pinned first then newest, with the unread count', async () => {
    const { older, newer } = await seedCopy()
    const { status, json } = await api('GET', '/human-inbox')
    expect(status).toBe(200)
    expect(json.servedFrom).toBe('mirror')
    expect(typeof json.mirrorUpdatedAt).toBe('string')
    expect(json.letters.map((l: LetterRecord) => l.id)).toEqual([newer, older])
    expect(json.unreadCount).toBe(2)
    expect(primary.calls.map(c => c.action)).toEqual(['server.human-inbox'])
  })

  it('one letter comes from the copy with its body', async () => {
    const { older } = await seedCopy()
    const { status, json } = await api('GET', `/human-inbox/${older}`)
    expect(status).toBe(200)
    expect(json.servedFrom).toBe('mirror')
    expect(json.letter.id).toBe(older)
    expect(json.letter.body).toContain('# Digest')
  })

  it('a relay timeout and a primary too old for the action also fall back to the copy', async () => {
    await seedCopy()
    primary.mode = 'timeout'
    expect((await api('GET', '/human-inbox')).json.servedFrom).toBe('mirror')
    primary.mode = 'old'
    expect((await api('GET', '/human-inbox')).json.servedFrom).toBe('mirror')
  })

  it('a box with no copy, or a letter the copy lacks, stays an honest bridge_offline', async () => {
    const none = await api('GET', '/human-inbox')
    expect(none.status).toBe(503)
    expect(none.json.error.code).toBe('bridge_offline')
    await seedCopy()
    const missing = await api('GET', '/human-inbox/lt-zzzzzz-abcd')
    expect(missing.status).toBe(503)
    expect(missing.json.error.code).toBe('bridge_offline')
  })

  it('an index caught half written by a checkout is read again, not served as an empty inbox', async () => {
    const { older, newer } = await seedCopy()
    const good = fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')
    fs.writeFileSync(humanInboxPaths.indexFile, good.slice(0, Math.floor(good.length / 2)))
    setTimeout(() => fs.writeFileSync(humanInboxPaths.indexFile, good), 60)
    const { status, json } = await api('GET', '/human-inbox')
    expect(status).toBe(200)
    expect(json.letters.map((l: LetterRecord) => l.id).sort()).toEqual([older, newer].sort())
  })

  it('the primary answers whenever it can (fresh beats the copy)', async () => {
    await seedCopy()
    onlinePrimary('2026-10-03T10:00:00.000Z')
    const { json } = await api('GET', '/human-inbox')
    expect(json.fromPrimary).toBe(true)
    expect(json.servedFrom).toBeUndefined()
  })
})

describe('flag changes while the primary is unreachable', () => {
  it('a read is answered at once, shown in every later read, and queued durably', async () => {
    const { older } = await seedCopy()
    const before = Date.now()
    const marked = await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(marked.status).toBe(200)
    expect(marked.json.queued).toBe(true)
    expect(marked.json.letter).toMatchObject({ id: older, read: true })

    const list = await api('GET', '/human-inbox')
    expect(list.json.letters.find((l: LetterRecord) => l.id === older).read).toBe(true)
    expect(list.json.unreadCount).toBe(1)
    expect((await api('GET', `/human-inbox/${older}`)).json.letter.read).toBe(true)

    const entries = await readStateEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ letterId: older, field: 'read', value: true, state: 'pending' })
    expect(entries[0].at).toBeGreaterThanOrEqual(before)
    // The copy itself is never written: git-sync owns that directory on a replica.
    expect(JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')).letters.every((l: LetterRecord) => !l.read)).toBe(true)
  })

  it('repeated toggles of one flag keep one change, the last one', async () => {
    const { older } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    await api('POST', `/human-inbox/${older}/read`, { read: false })
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(queueFiles()).toEqual([`${older}.read.json`])
    expect((await readStateEntries())[0].value).toBe(true)
  })

  it('pin re-sorts the copy and archive moves the letter to the shelf', async () => {
    const { older, newer } = await seedCopy()
    await api('POST', `/human-inbox/${older}/pin`, { pinned: true })
    expect((await api('GET', '/human-inbox')).json.letters.map((l: LetterRecord) => l.id)).toEqual([older, newer])

    await api('POST', `/human-inbox/${newer}/archive`, { archived: true })
    const live = await api('GET', '/human-inbox')
    expect(live.json.letters.map((l: LetterRecord) => l.id)).toEqual([older])
    expect(live.json.unreadCount).toBe(1)
    const shelf = await api('GET', '/human-inbox?archived=1')
    expect(shelf.json.letters.map((l: LetterRecord) => l.id)).toEqual([newer])
  })

  it('a timeout after the send is queued too (setting a flag is idempotent)', async () => {
    const { older } = await seedCopy()
    primary.mode = 'timeout'
    const marked = await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(marked.json.queued).toBe(true)
    expect(queueFiles()).toHaveLength(1)
  })

  it('a letter the copy does not hold is not queued', async () => {
    await seedCopy()
    const res = await api('POST', '/human-inbox/lt-zzzzzz-abcd/read', { read: true })
    expect(res.status).toBe(503)
    expect(queueFiles()).toHaveLength(0)
  })

  it('answers still need the primary', async () => {
    const { older } = await seedCopy()
    const res = await api('POST', `/human-inbox/${older}/human-reply`, { text: 'Thanks' })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('bridge_offline')
  })
})

describe('when the primary is back', () => {
  it('queued changes replay before a read, with the moment the human made them', async () => {
    const { older, newer } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    await api('POST', `/human-inbox/${newer}/pin`, { pinned: true })
    const queued = await readStateEntries()

    onlinePrimary('2026-10-03T11:00:00.000Z')
    primary.calls.length = 0
    const list = await api('GET', '/human-inbox')
    expect(list.json.fromPrimary).toBe(true)
    expect(primary.calls.map(c => c.action)).toEqual([
      'server.human-inbox.read', 'server.human-inbox.pin', 'server.human-inbox',
    ])
    expect(primary.calls[0].params).toEqual({ id: older, read: true, since: queued[0].at })
    expect(primary.calls[1].params).toEqual({ id: newer, pinned: true, since: queued[1].at })
    expect((await readStateEntries()).every(e => e.state === 'applied' && e.storeUpdatedAt === '2026-10-03T11:00:00.000Z')).toBe(true)
  })

  it('an applied change stays on top of the copy until the copy reaches the primary stamp', async () => {
    const { older } = await seedCopy()
    // Mac online: the read reaches it at once...
    onlinePrimary('2099-01-01T00:00:00.000Z')
    const direct = await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(direct.json).toEqual({ letter: { id: older, read: true } })
    // ...then the Mac sleeps before its git tick: the copy still says unread.
    primary.mode = 'offline'
    const stale = await api('GET', '/human-inbox')
    expect(stale.json.servedFrom).toBe('mirror')
    expect(stale.json.letters.find((l: LetterRecord) => l.id === older).read).toBe(true)

    // The sync lands a copy at least as new as the primary's write: the entry goes.
    syncCopy((ls) => { ls.find(l => l.id === older)!.read = true }, '2099-01-01T00:00:00.000Z')
    const synced = await api('GET', '/human-inbox')
    expect(synced.json.letters.find((l: LetterRecord) => l.id === older).read).toBe(true)
    expect(queueFiles()).toHaveLength(0)
  })

  it('a copy that is older than the primary stamp keeps the change on top', async () => {
    const { older } = await seedCopy()
    onlinePrimary('2099-01-01T00:00:00.000Z')
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    primary.mode = 'offline'
    syncCopy(() => {}, '2098-12-31T23:59:59.000Z')
    expect((await api('GET', '/human-inbox')).json.letters.find((l: LetterRecord) => l.id === older).read).toBe(true)
    expect(queueFiles()).toHaveLength(1)
  })

  it('a replay the primary superseded is dropped, and the copy shows the primary state', async () => {
    const { older } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    onlinePrimary('2026-10-03T12:00:00.000Z', { superseded: true })
    expect(await flushStateQueue()).toBe(1)
    expect(queueFiles()).toHaveLength(0)
    primary.mode = 'offline'
    expect((await api('GET', '/human-inbox')).json.letters.find((l: LetterRecord) => l.id === older).read).toBe(false)
  })

  it('a replay the primary refuses (the letter is gone) is dropped', async () => {
    const { older } = await seedCopy()
    await api('POST', `/human-inbox/${older}/archive`, { archived: true })
    onlinePrimary('2026-10-03T12:00:00.000Z', { status404: true })
    expect(await flushStateQueue()).toBe(1)
    expect(queueFiles()).toHaveLength(0)
  })

  it('a replay the primary FAILS (5xx) is kept for the next try', async () => {
    const { older } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    primary.mode = 'online'
    primary.answer = () => ({ ok: false, failure: { kind: 'error', status: 500, code: 'internal', message: 'index lock timed out' } })
    expect(await flushStateQueue()).toBe(0)
    expect(await readStateEntries()).toMatchObject([{ letterId: older, state: 'pending' }])
  })

  it('one letter is still asked for while changes are queued, with those changes on top', async () => {
    const { older } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    const fresh = 'lt-zzzzzz-abcd' // newer than the copy (a letter a push just announced)
    primary.mode = 'online'
    primary.answer = (action, params) => {
      if (action === 'server.human-inbox.read') {
        return { ok: false, failure: { kind: 'error', status: 503, code: 'internal', message: 'busy' } }
      }
      return { ok: true, result: { letter: { id: params.id, read: false, pinned: false, archived: false, fromPrimary: true } } }
    }
    const newer = await api('GET', `/human-inbox/${fresh}`)
    expect(newer.status).toBe(200)
    expect(newer.json.letter).toMatchObject({ id: fresh, fromPrimary: true, read: false })
    const queued = await api('GET', `/human-inbox/${older}`)
    expect(queued.json.letter).toMatchObject({ id: older, fromPrimary: true, read: true })
  })

  it('a replay stops at the first unreachable answer and keeps the rest', async () => {
    const { older, newer } = await seedCopy()
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    await api('POST', `/human-inbox/${newer}/read`, { read: true })
    primary.calls.length = 0
    expect(await flushStateQueue()).toBe(0)
    expect(primary.calls).toHaveLength(1)
    expect((await readStateEntries()).every(e => e.state === 'pending')).toBe(true)
  })

  it('a refusal on a direct write passes through and queues nothing', async () => {
    const { older } = await seedCopy()
    onlinePrimary('2026-10-03T12:00:00.000Z', { status404: true })
    const res = await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
    expect(queueFiles()).toHaveLength(0)
  })

  it('an older primary that sends no stamp leaves nothing behind', async () => {
    const { older } = await seedCopy()
    primary.mode = 'online'
    primary.answer = (_a, params) => ({ ok: true, result: { letter: { id: params.id, read: params.read } } })
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    expect(queueFiles()).toHaveLength(0)
  })

  it('a newer change to a flag replaces the older one still queued', async () => {
    const { older } = await seedCopy()
    // The earlier tap is still queued when the later one lands applied.
    await api('POST', `/human-inbox/${older}/read`, { read: false })
    onlinePrimary('2099-01-01T00:00:00.000Z')
    await api('POST', `/human-inbox/${older}/read`, { read: true })
    const entries = await readStateEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ value: true, state: 'applied' })
  })
})

describe('the queue lives outside the synced inbox', () => {
  it('is under cache/, which the data repo ignores', () => {
    expect(HUMAN_INBOX_QUEUE_DIR.split(path.sep)).toContain('cache')
    expect(HUMAN_INBOX_QUEUE_DIR.startsWith(humanInboxPaths.dir)).toBe(false)
  })
})
