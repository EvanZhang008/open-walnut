/**
 * The human's reply to a letter, and the option they pick on it, on the cloud companion
 * while the Mac is away (journal kind `inbox-reply`).
 *
 * 2026-11-05: the user replied by voice to a letter on the phone while the Mac was away;
 * `POST /human-inbox/:id/human-reply` on the companion only relayed, answered `503
 * bridge_offline` in 1 ms, and the reply reached the Mac 1h45m later when the phone resent
 * its draft. Pinned here:
 *
 *  - the Mac not reachable (provably not sent) and draining `inbox-reply`: the reply and the
 *    answer are journal records, answered `202 {letter, delivery: pending, queued}` with the
 *    turn in the letter's thread (as the Mac's own answer reads), and a retry of the same
 *    action adds no second record;
 *  - every read here (the letter, the list) shows the turn while it waits, and after the
 *    Mac's ack until the copy holds it (by clientId; an answer by the letter's answer), or
 *    for at most ten minutes;
 *  - a relay that may have reached the Mac (a timeout after the send) journals a reply (the
 *    Mac keeps one turn per clientId) but not an answer;
 *  - pictures (inline from the phone, or uploaded here) go with the turn once the Mac drains
 *    `inbox-reply-pictures`: saved in this box's images folder, shown on the turn at once,
 *    their bytes journal blobs with the words; a Mac that drains only `inbox-reply`, or a
 *    picture this box cannot keep, keeps the 503 (the words never go without them);
 *  - kept as before: a Mac that does not drain the kind (503), a session answering for the
 *    user (503), and every answer the Mac itself gives.
 *
 * Real express app, real router, real journal, real copy on disk. The ONLY mock is the
 * bridge hop (tryControlRelay / callPrimaryControl): this box has no Mac.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo, Server } from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-companion-reply', { CLOUD_MODE: true }))

/** The fake Mac: how it behaves, and every call it got. */
const { mac } = vi.hoisted(() => ({
  mac: {
    mode: 'offline' as 'offline' | 'timeout' | 'old' | 'online',
    calls: [] as Array<{ action: string; params: Record<string, unknown> }>,
    /** The Mac's own reply while online. */
    answer: null as null | ((action: string, params: Record<string, unknown>) => Record<string, unknown>),
  },
}))

vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  const offline = (notSent: boolean) => ({
    ok: false as const, notSent,
    answer: (res: import('express').Response) => actual.sendV1Error(res, 503, 'bridge_offline', notSent ? 'No live bridge to the primary box.' : 'bridge request timed out'),
  })
  return {
    ...actual,
    tryControlRelay: async (action: string, _sid: string, params: Record<string, unknown> = {}) => {
      mac.calls.push({ action, params })
      if (mac.mode === 'offline') return offline(true)
      if (mac.mode === 'timeout') return offline(false)
      if (mac.mode === 'old') return { ok: true as const, reply: { ok: false, error: `Unknown control action: ${action}` } }
      if (!mac.answer) throw new Error('online with no answer scripted')
      return { ok: true as const, reply: mac.answer(action, params) }
    },
    // Reads and flags: the Mac is away for them in every case here.
    callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown> = {}) => {
      mac.calls.push({ action, params })
      return { ok: false, failure: { kind: 'bridge_offline', message: 'Your primary box (Mac) is offline', notSent: true } }
    },
  }
})

import { WALNUT_HOME, HUMAN_INBOX_QUEUE_DIR, IMAGES_DIR } from '../../src/constants.js'
import { humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import {
  _resetCompanionJournalForTesting, ackCompanionJournal, companionJournalBlobBody, companionJournalDir, companionJournalRecords, drainCompanionJournal,
} from '../../src/core/companion-journal.js'
import { humanInboxV1Router } from '../../src/web/routes/human-inbox-v1.js'
import type { LetterRecord, LetterSender, ThreadEntry } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-companion-reply', host: 'workstation' }
const ACKED_FILE = () => path.join(HUMAN_INBOX_QUEUE_DIR, 'turns-acked.json')

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
  _resetCompanionJournalForTesting()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(async () => {
  _resetCompanionJournalForTesting()
  fs.rmSync(companionJournalDir(), { recursive: true, force: true })
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  fs.rmSync(HUMAN_INBOX_QUEUE_DIR, { recursive: true, force: true })
  mac.mode = 'offline'
  mac.calls.length = 0
  mac.answer = null
  fs.rmSync(IMAGES_DIR, { recursive: true, force: true })
  // The Mac drained once and named the kinds (its last `offline.drain`).
  await drainCompanionJournal(MAC_KINDS)
})

const MAC_KINDS = ['inbox-state', 'inbox-reply', 'inbox-reply-pictures']

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

/** A letter in the box's copy, as the Mac wrote it. */
async function seedLetter(): Promise<string> {
  return (await sendLetter({
    subject: 'Pick a layout for the marina page', type: 'action_required', markdown: '# Two layouts',
    actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }], sender: SENDER,
  })).id
}

/** The Mac's next copy round: its index with `patch` applied. */
function syncCopy(patch: (letters: LetterRecord[]) => void): void {
  const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')) as { letters: LetterRecord[] }
  patch(raw.letters)
  fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(raw))
}

/** The Mac drains the journal (a record is handed out first) and acks `seqs`. */
async function macTakes(seqs: number[]) {
  await drainCompanionJournal(MAC_KINDS)
  return ackCompanionJournal(seqs, Date.now())
}
const replyRecords = () => companionJournalRecords().filter((r) => r.kind === 'inbox-reply' || r.kind === 'inbox-reply-pictures')
const humanTurns = (letter: { thread: ThreadEntry[] }) => letter.thread.filter((t) => t.from === 'human')

describe('a reply while the Mac is away', () => {
  it('is journaled and answered 202 with the turn in the letter, once per clientId', async () => {
    const id = await seedLetter()
    const before = Date.now()
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Layout A, but keep the map', clientId: 'ios-1' })
    expect(r.status).toBe(202)
    expect(r.json).toMatchObject({ queued: true, delivery: { status: 'pending' }, clientId: 'ios-1' })
    // The Mac's own answer shape: the body-inlined letter with the turn on it.
    expect(r.json.letter.id).toBe(id)
    expect(r.json.letter.body).toContain('# Two layouts')
    expect(humanTurns(r.json.letter)).toEqual([
      { from: 'human', text: 'Layout A, but keep the map', at: expect.any(Number), clientId: 'ios-1', delivery: { status: 'pending', at: expect.any(Number) } },
    ])
    expect(r.json.letter.read).toBe(true)
    const [rec, ...rest] = replyRecords()
    expect(rest).toEqual([])
    expect(rec).toMatchObject({ kind: 'inbox-reply', letterId: id, op: 'reply', text: 'Layout A, but keep the map', clientId: 'ios-1' })
    expect(rec.madeAt).toBeGreaterThanOrEqual(before)
    expect(mac.calls.map((c) => c.action)).toEqual(['server.human-inbox.human-reply'])

    // The phone resends its draft: the same record, the same single turn.
    const again = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Layout A, but keep the map', clientId: 'ios-1' })
    expect(again.status).toBe(202)
    expect(replyRecords()).toHaveLength(1)
    expect(humanTurns(again.json.letter)).toHaveLength(1)
  })

  it('shows on the letter and the list while it waits, and after the ack until the copy holds it', async () => {
    const id = await seedLetter()
    await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Ship layout B', clientId: 'ios-2' })
    const one = await api('GET', `/human-inbox/${id}`)
    expect(one.json.servedFrom).toBe('mirror')
    expect(humanTurns(one.json.letter).map((t) => t.clientId)).toEqual(['ios-2'])
    const list = await api('GET', '/human-inbox')
    const row = list.json.letters.find((l: LetterRecord) => l.id === id)
    expect(humanTurns(row).map((t: ThreadEntry) => t.text)).toEqual(['Ship layout B'])
    expect(row.read).toBe(true)
    expect(list.json.unreadCount).toBe(0)

    // The Mac took the record: it leaves the journal, and the turn stays shown.
    const seq = replyRecords()[0].seq
    expect(await macTakes([seq])).toMatchObject({ ok: true, remaining: 0 })
    expect(replyRecords()).toEqual([])
    expect(fs.existsSync(ACKED_FILE())).toBe(true)
    expect(humanTurns((await api('GET', `/human-inbox/${id}`)).json.letter).map((t) => t.clientId)).toEqual(['ios-2'])
    expect(humanTurns((await api('GET', '/human-inbox')).json.letters.find((l: LetterRecord) => l.id === id)).map((t: ThreadEntry) => t.clientId)).toEqual(['ios-2'])

    // The copy round brings the Mac's turn (its own time and delivery): shown once, the kept entry goes.
    syncCopy((ls) => {
      ls.find((l) => l.id === id)!.thread.push({ from: 'human', text: 'Ship layout B', at: Date.now(), clientId: 'ios-2', delivery: { status: 'queued', at: Date.now() } })
    })
    const synced = await api('GET', `/human-inbox/${id}`)
    expect(humanTurns(synced.json.letter)).toMatchObject([{ clientId: 'ios-2', delivery: { status: 'queued' } }])
    expect(fs.existsSync(ACKED_FILE())).toBe(false)
  })

  it('an acked turn the copy never shows is dropped after ten minutes', async () => {
    const id = await seedLetter()
    await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Either works', clientId: 'ios-3' })
    await macTakes([replyRecords()[0].seq])
    const kept = JSON.parse(fs.readFileSync(ACKED_FILE(), 'utf-8')) as { turns: Array<Record<string, unknown>> }
    kept.turns[0].ackedAt = Date.now() - 11 * 60_000
    fs.writeFileSync(ACKED_FILE(), JSON.stringify(kept))
    expect(humanTurns((await api('GET', `/human-inbox/${id}`)).json.letter)).toEqual([])
  })

  it('a reply with no clientId gets one made here, and the relay carried it', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Go with A' })
    expect(r.status).toBe(202)
    expect(r.json.clientId).toMatch(/^rp-[0-9a-f-]{36}$/)
    expect(mac.calls[0].params.clientId).toBe(r.json.clientId)
    expect(replyRecords()[0]).toMatchObject({ clientId: r.json.clientId })
  })

  it('a relay that may have reached the Mac (a timeout) still journals a reply: the Mac keeps one turn per clientId', async () => {
    const id = await seedLetter()
    mac.mode = 'timeout'
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Layout B', clientId: 'ios-4' })
    expect(r.status).toBe(202)
    expect(replyRecords()).toHaveLength(1)
  })

  it('a Mac too old for the action is not sent to either: journaled', async () => {
    const id = await seedLetter()
    mac.mode = 'old'
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Layout B', clientId: 'ios-5' })).status).toBe(202)
    expect(replyRecords()).toHaveLength(1)
  })
})

describe('an answer while the Mac is away', () => {
  it('is journaled and answered 202 with the letter answered; the same answer again adds nothing', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b', freeText: 'with the dark header' })
    expect(r.status).toBe(202)
    expect(r.json).toMatchObject({ queued: true, delivery: { status: 'pending' } })
    expect(r.json.letter.answered).toMatchObject({ actionId: 'b', label: 'Layout B', freeText: 'with the dark header' })
    expect(r.json.letter.answered.by).toBeUndefined()
    expect(humanTurns(r.json.letter)).toMatchObject([{ text: 'Layout B: with the dark header', delivery: { status: 'pending' } }])
    expect(replyRecords()).toMatchObject([{ kind: 'inbox-reply', letterId: id, op: 'answer', actionId: 'b', freeText: 'with the dark header' }])

    const again = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b', freeText: 'with the dark header' })
    expect(again.status).toBe(202)
    expect(replyRecords()).toHaveLength(1)
    expect(humanTurns(again.json.letter)).toHaveLength(1)
    // Another answer: the Mac takes one per letter, so it is not kept for it.
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })).status).toBe(503)
    expect(replyRecords()).toHaveLength(1)

    const list = await api('GET', '/human-inbox')
    expect(list.json.letters.find((l: LetterRecord) => l.id === id).answered).toMatchObject({ actionId: 'b' })
    // Acked, then the copy answers it: one turn, the copy's own.
    await macTakes([replyRecords()[0].seq])
    expect((await api('GET', `/human-inbox/${id}`)).json.letter.answered).toMatchObject({ actionId: 'b' })
    syncCopy((ls) => {
      const l = ls.find((x) => x.id === id)!
      l.answered = { actionId: 'b', label: 'Layout B', freeText: 'with the dark header', at: Date.now() }
      l.thread.push({ from: 'human', text: 'Layout B: with the dark header', at: Date.now(), delivery: { status: 'queued', at: Date.now() } })
    })
    expect(humanTurns((await api('GET', `/human-inbox/${id}`)).json.letter)).toMatchObject([{ delivery: { status: 'queued' } }])
    expect(fs.existsSync(ACKED_FILE())).toBe(false)
  })

  it('an answer whose relay may have reached the Mac keeps the 503', async () => {
    const id = await seedLetter()
    mac.mode = 'timeout'
    const r = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('bridge_offline')
    expect(replyRecords()).toEqual([])
  })

  it('an option the letter does not offer is not kept', async () => {
    const id = await seedLetter()
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'zzz' })).status).toBe(503)
    expect(replyRecords()).toEqual([])
  })
})

describe('kept as before', () => {
  it('a Mac that does not drain the kind: 503 and no record', async () => {
    const id = await seedLetter()
    await drainCompanionJournal(['inbox-state'])
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Thanks', clientId: 'ios-6' })
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('bridge_offline')
    // No clientId made for a reply that is never kept.
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Thanks' })).status).toBe(503)
    expect(mac.calls[1].params.clientId).toBeUndefined()
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })).status).toBe(503)
    expect(replyRecords()).toEqual([])
  })

  it('a Mac that drains only inbox-reply: a turn with pictures keeps its 503 and no record', async () => {
    await drainCompanionJournal(['inbox-state', 'inbox-reply'])
    const id = await seedLetter()
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'See this', clientId: 'ios-7', images: [PNG] })).status).toBe(503)
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a', images: [PNG] })).status).toBe(503)
    expect(replyRecords()).toEqual([])
    // The words alone still go.
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'See this', clientId: 'ios-7' })).status).toBe(202)
  })

  it('a picture this box cannot keep: 503 and no record (the words never go without it)', async () => {
    const id = await seedLetter()
    // An upload that is not on this box.
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'See this', clientId: 'ios-8', imageRefs: ['1700000000000-aaaaaaaaaaaa.png'] })).status).toBe(503)
    // One good picture and one that is not a picture at all.
    expect((await api('POST', `/human-inbox/${id}/human-reply`, { text: 'See this', clientId: 'ios-8', images: [PNG, { data: 'x', mediaType: 'text/plain' }] })).status).toBe(503)
    expect(replyRecords()).toEqual([])
  })

  it('a session answering for the user: 503 and no record (the Mac records its task)', async () => {
    const id = await seedLetter()
    const res = await fetch(`${base}/human-inbox/${id}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': 'sess-some-task' }, body: JSON.stringify({ actionId: 'a' }),
    })
    expect(res.status).toBe(503)
    expect(replyRecords()).toEqual([])
  })

  it('a letter not in the copy: 503 and no record', async () => {
    await seedLetter()
    expect((await api('POST', '/human-inbox/lt-zzzzzz-abcd/human-reply', { text: 'Hi', clientId: 'ios-9' })).status).toBe(503)
    expect(replyRecords()).toEqual([])
  })

  it('the Mac answering: its answer and its refusals pass through, nothing is journaled', async () => {
    const id = await seedLetter()
    mac.mode = 'online'
    mac.answer = (_action, params) => ({ ok: true, result: { letter: { id: params.id, fromMac: true }, delivery: { status: 'pending' } } })
    const ok = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Hi', clientId: 'ios-10' })
    expect(ok.status).toBe(202)
    expect(ok.json).toEqual({ letter: { id, fromMac: true }, delivery: { status: 'pending' } })
    mac.answer = () => ({ ok: false, error: 'Letter was already answered (a)', errorKind: 'conflict' })
    const refused = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b' })
    expect(refused.status).toBe(409)
    expect(refused.json.error.message).toBe('Letter was already answered (a)')
    expect(replyRecords()).toEqual([])
  })
})

/** A real 1x1 PNG, as the phone posts it inline. */
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/hAh0WQAAAABJRU5ErkJggg==', 'base64')
const PNG = { data: PNG_BYTES.toString('base64'), mediaType: 'image/png' }
const RED_PNG = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mediaType: 'image/png' }

describe('a reply with pictures while the Mac is away', () => {
  it('inline pictures: saved here, shown on the turn, journaled with their bytes, once per clientId', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Like this one', clientId: 'ios-p1', images: [PNG, RED_PNG] })
    expect(r.status).toBe(202)
    const turn = humanTurns(r.json.letter)[0]
    expect(turn).toMatchObject({ text: 'Like this one', clientId: 'ios-p1', delivery: { status: 'pending' } })
    expect(turn.images).toHaveLength(2)
    // Each one a file in this box's images folder: the letter here shows it at once.
    for (const name of turn.images!) expect(fs.existsSync(path.join(IMAGES_DIR, name))).toBe(true)
    const recs = replyRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'inbox-reply-pictures', letterId: id, op: 'reply', text: 'Like this one', clientId: 'ios-p1', images: turn.images })
    for (let i = 0; i < 2; i++) {
      const body = companionJournalBlobBody(recs[0][`image${i}`])
      expect(body?.equals(fs.readFileSync(path.join(IMAGES_DIR, turn.images![i])))).toBe(true)
    }
    // The phone resends its draft: the same turn, no second record.
    const again = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'Like this one', clientId: 'ios-p1', images: [PNG, RED_PNG] })
    expect(again.status).toBe(202)
    expect(humanTurns(again.json.letter)).toHaveLength(1)
    expect(replyRecords()).toHaveLength(1)
    // Its pictures are not saved a second time.
    expect(fs.readdirSync(IMAGES_DIR).filter((n) => !n.startsWith('.') && fs.statSync(path.join(IMAGES_DIR, n)).isFile())).toHaveLength(2)
    // Every read here shows the turn with its pictures.
    const read = await api('GET', `/human-inbox/${id}`)
    expect(humanTurns(read.json.letter)[0].images).toEqual(turn.images)
  })

  it('an upload made here, and a picture alone with no words', async () => {
    const id = await seedLetter()
    fs.mkdirSync(IMAGES_DIR, { recursive: true })
    const name = '1700000000000-bbbbbbbbbbbb.png'
    fs.writeFileSync(path.join(IMAGES_DIR, name), PNG_BYTES)
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: '', clientId: 'ios-p2', imageRefs: [{ filename: name }] })
    expect(r.status).toBe(202)
    expect(humanTurns(r.json.letter)[0]).toMatchObject({ text: '', images: [name] })
    const [rec] = replyRecords()
    expect(rec).toMatchObject({ kind: 'inbox-reply-pictures', text: '', images: [name] })
    expect(companionJournalBlobBody(rec.image0)?.equals(PNG_BYTES)).toBe(true)
  })

  it('an answer with a picture: the option, its words and the picture on the turn', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b', freeText: 'like this', images: [PNG] })
    expect(r.status).toBe(202)
    expect(r.json.letter.answered).toMatchObject({ actionId: 'b', freeText: 'like this' })
    const turn = humanTurns(r.json.letter)[0]
    expect(turn).toMatchObject({ text: 'Layout B: like this' })
    expect(turn.images).toHaveLength(1)
    expect(replyRecords()).toMatchObject([{ kind: 'inbox-reply-pictures', op: 'answer', actionId: 'b', freeText: 'like this', images: turn.images }])
  })

  it('pictures with an answer the letter already has (from the copy): the 503, nothing kept', async () => {
    const id = await seedLetter()
    syncCopy((letters) => { letters.find((l) => l.id === id)!.answered = { actionId: 'a', label: 'Layout A', at: Date.now() } })
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a', images: [PNG] })).status).toBe(503)
    expect(replyRecords()).toEqual([])
    // The same answer with no pictures is the letter as it stands, as before.
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })).status).toBe(202)
  })

  it('after the Mac takes it: still shown with its pictures until the copy holds the turn', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/human-reply`, { text: 'This', clientId: 'ios-p3', images: [PNG] })
    const images = humanTurns(r.json.letter)[0].images
    const [rec] = replyRecords()
    expect(await macTakes([rec.seq])).toMatchObject({ ok: true, remaining: 0 })
    expect(humanTurns((await api('GET', `/human-inbox/${id}`)).json.letter)).toMatchObject([{ clientId: 'ios-p3', images }])
    // The copy holds it (the Mac saved the picture under the same name): shown once, from the copy.
    syncCopy((letters) => {
      letters.find((l) => l.id === id)!.thread.push({ from: 'human', text: 'This', at: Date.now(), clientId: 'ios-p3', images, delivery: { status: 'delivered', at: Date.now() } } as ThreadEntry)
    })
    expect(humanTurns((await api('GET', `/human-inbox/${id}`)).json.letter)).toMatchObject([{ clientId: 'ios-p3', images }])
  })
})
