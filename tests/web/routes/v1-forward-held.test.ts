/**
 * A phone call never reaches the Mac past a change the cloud companion still holds for it
 * (web/v1-forward/proxy.ts heldFor, policy.ts HELD_FOR_MAC).
 *
 * 2026-11-22: the phone replied to a letter while the Mac slept; the companion held the reply
 * (journal kind `inbox-reply`) and the letter showed it as "received". The Mac woke, and from
 * then on the companion forwarded the phone's reads of that letter to the Mac, which had not
 * drained the journal yet: for 15 s the letter came back without the reply (the phone removed
 * it, and its page jumped), until the Mac drained it. A reply sent in those 15 s would have
 * gone to the Mac at once and reached the session before the held one.
 *
 * Pinned here:
 *  - while an inbox change is held, every inbox call (the list, a letter, a reply, an answer,
 *    a flag) is answered by the companion, whose routes show and order what is held; other
 *    calls still go to the Mac; once nothing is held, inbox calls go to the Mac again;
 *  - a session patch stays only while a patch of that same session is held; task writes
 *    stay while task changes are held (as before, now with journaled ones too);
 *  - the class: every kind the companion's journal writes is classed in HELD_FOR_MAC (read
 *    from the journal's source, so a new kind fails here until it is), and the real check
 *    (companionHeldFor) answers held for a waiting record of every gated kind.
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { AddressInfo, Server } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-v1-forward-held', { CLOUD_MODE: true }))

const { journal } = vi.hoisted(() => ({ journal: { records: [] as Array<Record<string, unknown>>, notDrained: new Set<string>() } }))
vi.mock('../../../src/core/companion-journal.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/companion-journal.js')>()
  return {
    ...real,
    macDrains: (kind: string) => !journal.notDrained.has(kind),
    companionJournalRecords: () => journal.records,
    companionJournalSessionIds: () => new Set(journal.records.filter((r) => r.kind === 'session-meta').map((r) => r.sid as string)),
  }
})

import { createV1Forward, type CallOutcome, type PrimarySnapshot } from '../../../src/web/v1-forward/proxy.js'
import { companionHeldFor, type HeldCall } from '../../../src/web/v1-forward/held.js'
import { HELD_FOR_MAC, heldCallOf } from '../../../src/web/v1-forward/policy.js'

const NOW = Date.now()
const fresh = (): PrimarySnapshot => ({ bridge: true, heard: true, lastSeenAt: Date.now() - 1_000, leading: 0, backupAllowed: true, takeoverMs: 60_000 })
const reply = (status: number, value: unknown): CallOutcome => {
  const buf = Buffer.from(JSON.stringify(value))
  return { ok: true, result: { status, headers: { 'content-type': 'application/json; charset=utf-8' }, size: buf.byteLength, data: buf.toString('base64') } }
}

let server: Server
let base = ''
const forwarded: string[] = []
let held: (call: HeldCall) => boolean = () => false

beforeAll(async () => {
  const fwd = createV1Forward({
    now: () => Date.now(),
    enabled: () => true,
    primary: async () => fresh(),
    call: async (params) => { forwarded.push(`${params.method} ${params.url}`); return reply(200, { from: 'mac' }) },
    heldFor: (call) => held(call),
  })
  const app = express()
  app.use(express.json())
  app.use('/api/v1', fwd.middleware)
  app.all('/api/v1/*rest', (req, res) => { res.status(200).json({ from: 'companion', path: req.path }) })
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  held = () => false
  forwarded.length = 0
  journal.records = []
})

async function who(method: string, p: string, body?: unknown): Promise<string> {
  const r = await fetch(base + p, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return ((await r.json()) as { from: string }).from
}

const INBOX_CALLS: Array<[string, string, unknown?]> = [
  ['GET', '/human-inbox'],
  ['GET', '/human-inbox?archived=1'],
  ['GET', '/human-inbox/hl-1'],
  ['POST', '/human-inbox/hl-1/human-reply', { text: 'B, please', clientId: 'ios-2' }],
  ['POST', '/human-inbox/hl-1/answer', { actionId: 'b' }],
  ['POST', '/human-inbox/hl-1/read', { read: true }],
  ['POST', '/Human-Inbox/hl-1/pin', { pinned: true }],
]

describe('the forward keeps a call behind what the companion holds for the Mac', () => {
  it('an inbox change held: every inbox call is answered here; other calls still go to the Mac', async () => {
    held = (c) => c.family === 'inbox'
    for (const [m, p, b] of INBOX_CALLS) expect(`${m} ${p}: ${await who(m, p, b)}`).toBe(`${m} ${p}: companion`)
    expect(forwarded).toEqual([])
    expect(await who('GET', '/tasks/t-1/board')).toBe('mac')
    expect(await who('PATCH', '/sessions/s-1', { title: 'x' })).toBe('mac')
    expect(forwarded).toEqual(['GET /api/v1/tasks/t-1/board', 'PATCH /api/v1/sessions/s-1'])
  })

  it('nothing held: inbox calls go to the Mac as before', async () => {
    for (const [m, p, b] of INBOX_CALLS) expect(`${m} ${p}: ${await who(m, p, b)}`).toBe(`${m} ${p}: mac`)
    expect(forwarded).toHaveLength(INBOX_CALLS.length)
  })

  it('a session patch stays only while a patch of that same session is held; its reads still go', async () => {
    held = (c) => c.family === 'session-patch' && c.sessionId === 's-held'
    expect(await who('PATCH', '/sessions/s-held', { title: 'Renamed again' })).toBe('companion')
    expect(await who('PATCH', '/sessions/s-other', { title: 'Other' })).toBe('mac')
    expect(await who('GET', '/sessions/s-held/summary')).toBe('mac')
    expect(await who('POST', '/human-inbox/hl-1/read', { read: true })).toBe('mac')
  })

  it('a task write stays while task changes are held', async () => {
    held = (c) => c.family === 'task-writes'
    expect(await who('PATCH', '/tasks/t-1', { title: 'x' })).toBe('companion')
    expect(await who('GET', '/human-inbox')).toBe('mac')
  })
})

describe('every kind the companion journal holds for the Mac is classed (the class guard)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/core/companion-journal.ts'), 'utf8')
  // Every write into the companion's journal: append, appendBlobs, appendNote (its kind is `note`), and any new one.
  const writers = [...source.matchAll(/\.append(\w*)\(\s*COMPANION_JOURNAL_HOME\s*,\s*(?:\{\s*kind:\s*'([a-z][a-z0-9-]*)')?/g)]
  const kinds = writers.map((m) => m[2] ?? (m[1] === 'Note' ? 'note' : `(a kind this test cannot read: .append${m[1]})`))

  it('each writer names its kind where this test can read it, and each kind is in HELD_FOR_MAC; no stale entry', () => {
    expect(writers.length).toBeGreaterThan(5)
    // A writer whose kind is computed would be a kind nobody classed.
    expect(kinds.filter((k) => k.startsWith('('))).toEqual([])
    expect([...new Set(kinds)].sort()).toEqual(Object.keys(HELD_FOR_MAC).sort())
  })

  it.each(Object.entries(HELD_FOR_MAC).filter(([, c]) => 'family' in c) as Array<[string, { family: HeldCall['family'] }]>)(
    'a waiting %s record keeps its calls on the companion (the real check)',
    async (kind, { family }) => {
      const call: HeldCall = family === 'session-patch' ? { family, sessionId: 's-1' } : { family }
      expect(await companionHeldFor(call)).toBe(false)
      journal.records = [{ seq: 1, kind, sid: 's-1', letterId: 'lt-mheld1-a1b2', taskId: 't-1', op: 'reply', text: 'x', clientId: 'ios-1', madeAt: NOW, at: NOW }]
      expect(await companionHeldFor(call)).toBe(true)
      // A session patch waits only behind its own session's.
      if (family === 'session-patch') expect(await companionHeldFor({ family, sessionId: 's-2' })).toBe(false)
      // Parked by a Mac that went back to a release that does not drain the kind: it keeps nothing.
      journal.notDrained = new Set([kind])
      try { expect(await companionHeldFor(call)).toBe(false) } finally { journal.notDrained = new Set() }
    },
  )

  it('each gated family has its calls: a held family no phone call belongs to would gate nothing', () => {
    expect(heldCallOf('GET', '/human-inbox/hl-1')).toEqual({ family: 'inbox' })
    expect(heldCallOf('PATCH', '/sessions/s-1')).toEqual({ family: 'session-patch', sessionId: 's-1' })
    expect(heldCallOf('GET', '/sessions/s-1')).toBeNull()
    const families = new Set(Object.values(HELD_FOR_MAC).flatMap((c) => ('family' in c ? [c.family] : [])))
    expect([...families].sort()).toEqual(['inbox', 'session-patch', 'task-writes'])
  })
})
