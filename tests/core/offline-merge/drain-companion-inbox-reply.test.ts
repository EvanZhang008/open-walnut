/**
 * The journal kind `inbox-reply` on the Mac (offline-merge/apply-inbox-reply.ts), end to
 * end: the human's reply to a letter, or the option picked on it, taken on the cloud
 * companion while the Mac was away (core/companion-journal.ts journalInboxReply), drained
 * by the Mac's real handover (companion-journal-drain.ts) over the real door
 * (web/routes/bridge-journal.ts, machine credential, gzip) into the Mac's real letter
 * store, delivered to the letter's session through the online route's own calls.
 *
 * Pinned (2026-11-05, a voice reply on the phone reached the Mac 1h45m late):
 *   - a reply lands as one thread turn of the human's (clientId kept) and one delivery;
 *     a retry on the companion is one record; a redrain (the Mac crashed before its ack)
 *     is still one turn and one delivery;
 *   - an answer lands once (the letter answered, one delivery); a redrain answers nothing
 *     twice and letters nothing;
 *   - a letter gone, or an option it does not offer, is refused into the drain's letter
 *     (the user's words never vanish quietly), never retried;
 *   - the companion learns the kind from the Mac's drain: `macDrains('inbox-reply')`.
 *
 * CLOUD_MODE is read at import, so the companion and the Mac are two module graphs
 * (vi.resetModules + doMock) over one temp home, as drain-companion-journal.test.ts.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constantsBase = createMockConstants('walnut-drain-companion-inbox-reply')

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))
/** Every delivery to a session: the letter's origin is told the human's words here. */
const delivered = vi.hoisted(() => ({ sends: [] as Array<{ sid: string; text: string; source?: string }>, delayMs: 0 }))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-message-queue.js')>()),
  sendMessageToSession: vi.fn(async (sid: string, text: string, opts: { source?: string } = {}) => {
    if (delivered.delayMs) await new Promise((r) => setTimeout(r, delivered.delayMs))
    delivered.sends.push({ sid, text, source: opts.source })
    return { id: `msg-${delivered.sends.length}` }
  }),
}))

async function loadCompanion() {
  vi.resetModules()
  vi.doMock('../../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: true }))
  return {
    journal: await import('../../../src/core/companion-journal.js'),
    door: await import('../../../src/web/routes/bridge-journal.js'),
    auth: await import('../../../src/core/device-auth.js'),
  }
}
async function loadMac() {
  vi.resetModules()
  vi.doMock('../../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: false }))
  return {
    tm: await import('../../../src/core/task-manager.js'),
    taskDb: await import('../../../src/core/task-db.js'),
    drain: await import('../../../src/core/companion-journal-drain.js'),
    handover: await import('../../../src/core/offline-handover.js'),
    conflicts: await import('../../../src/core/offline-merge/conflict-log.js'),
    ingest: await import('../../../src/core/cloud-ingest.js'),
    sessions: await import('../../../src/core/session-tracker.js'),
    inbox: await import('../../../src/core/human-inbox/store.js'),
  }
}

const HOME = constantsBase.WALNUT_HOME as string
const token = crypto.randomBytes(16).toString('hex')
const SID = 'cccccccc-3333-4333-8333-cccccccccccc'
let companion: Awaited<ReturnType<typeof loadCompanion>>
let mac: Awaited<ReturnType<typeof loadMac>>
let server: Server

beforeAll(async () => {
  await fsp.rm(HOME, { recursive: true, force: true })
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true })
  await fsp.writeFile(path.join(HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), kind: 'machine' },
  ] }), { mode: 0o600 })
  companion = await loadCompanion()
  companion.auth._resetDeviceAuthForTesting()
  const app = express()
  app.use(companion.door.BRIDGE_JOURNAL_PATH, companion.door.createBridgeJournalRouter())
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${addr.port}/bridge`, token }
  mac = await loadMac()
  mac.ingest._resetCloudIngestForTesting()
  mac.handover._setHandoverBackoffForTesting([1, 1])
  // The letters' origin session, on the Mac.
  const taskId = (await mac.tm.addTask({ title: 'Marina page', project: 'Acme' } as never)).task.id
  await mac.sessions.createSessionRecord(SID, taskId, 'Acme', '/tmp', { title: 'Build the marina page' })
  // The Mac drains once with nothing waiting: the companion learns the kinds it takes.
  await mac.drain.drainCompanionJournalNow()
  expect(companion.journal.macDrains('inbox-reply')).toBe(true)
}, 60_000)

afterAll(async () => {
  mac?.handover._setHandoverBackoffForTesting(null)
  mac?.taskDb.closeDb()
  companion?.journal._resetCompanionJournalForTesting()
  await new Promise<void>((r) => server?.close(() => r()))
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { delivered.sends.length = 0; delivered.delayMs = 0 })

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))
async function ask(subject: string): Promise<string> {
  return (await mac.inbox.sendLetter({
    subject, type: 'action_required', markdown: '# Two layouts',
    actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }],
    sender: { sessionId: SID, host: 'workstation' },
  })).id
}
const letterOf = async (id: string) => (await mac.inbox.getLetter(id, { deferBodies: true }))!
const humanTurns = async (id: string) => (await letterOf(id)).thread.filter((t) => t.from === 'human')
function refusedEntries(opId: string) {
  let names: string[] = []
  try { names = fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => mac.conflicts.readConflictLog(n.slice(0, -5))?.entries ?? []).filter((e) => e.opId === opId)
}

/** Drain `records` over a link that hands them out until acked, dropping the first `dropAcks` acks. */
async function drainHanded(records: Array<Record<string, unknown>>, dropAcks: number): Promise<number[]> {
  const acked: number[] = []
  let drops = dropAcks
  const conn = {
    hostKey: 'companion', journalV2: true,
    send: async (cmd: string, p?: Record<string, unknown>) => {
      if (cmd === 'offline.drain') return { ok: true, records: records.filter((r) => !acked.includes(r.seq as number)), now: Date.now() }
      if (cmd === 'offline.ack') {
        if (drops > 0) { drops--; return { ok: true, remaining: records.length } }
        acked.push(...((p?.seqs as number[]) ?? []))
      }
      return { ok: true }
    },
  }
  for (let round = 0; round <= dropAcks; round++) {
    mac.handover._resetOfflineHandoverForTesting()
    await mac.handover.runOfflineHandover(conn as never)
    await settle()
  }
  return acked
}

describe('a reply taken on the companion while the Mac was away', () => {
  it('lands on its letter once and is delivered once; a retry is one record', async () => {
    const id = await ask('Pick a layout for the marina page')
    const madeAt = Date.now() - 60_000
    const first = companion.journal.journalInboxReply({ letterId: id, op: 'reply', text: 'Layout A, keep the map', clientId: 'ios-r1', madeAt })
    expect(first).toMatchObject({ ok: true })
    // The phone resends its draft before the Mac is back: the same record.
    expect(companion.journal.journalInboxReply({ letterId: id, op: 'reply', text: 'Layout A, keep the map', clientId: 'ios-r1', madeAt: Date.now() })).toMatchObject({ ok: true, duplicate: true, opId: (first as { opId: string }).opId })
    expect(companion.journal.companionJournalRecords().filter((r) => r.kind === 'inbox-reply')).toHaveLength(1)

    const result = await mac.drain.drainCompanionJournalNow()
    await settle()
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
    expect(companion.journal.companionJournalRecords()).toEqual([])
    const turns = await humanTurns(id)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ text: 'Layout A, keep the map', clientId: 'ios-r1', delivery: { status: 'queued' } })
    expect(turns[0].by).toBeUndefined()
    expect(delivered.sends).toHaveLength(1)
    expect(delivered.sends[0]).toMatchObject({ sid: SID, source: 'human-inbox' })
    expect(delivered.sends[0].text).toContain('Layout A, keep the map')
    expect((await letterOf(id)).read).toBe(true)
  })

  it('a redrain (the Mac crashed before its ack) is still one turn and one delivery', async () => {
    const id = await ask('Pick a header for the marina page')
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ir-redrain-reply', rev: 1, letterId: id, op: 'reply', text: 'The dark one', clientId: 'ios-r2', madeAt: Date.now() - 1000 }
    const acked = await drainHanded([rec], 1)
    expect(acked).toEqual([1])
    expect((await humanTurns(id)).map((t) => t.clientId)).toEqual(['ios-r2'])
    expect(delivered.sends).toHaveLength(1)
  })
})

describe('an answer taken on the companion while the Mac was away', () => {
  it('answers its letter once and is delivered once', async () => {
    const id = await ask('Pick a footer for the marina page')
    expect(companion.journal.journalInboxReply({ letterId: id, op: 'answer', actionId: 'b', freeText: 'with the links', madeAt: Date.now() - 30_000 })).toMatchObject({ ok: true })
    const result = await mac.drain.drainCompanionJournalNow()
    await settle()
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
    const letter = await letterOf(id)
    expect(letter.answered).toMatchObject({ actionId: 'b', label: 'Layout B', freeText: 'with the links' })
    expect(letter.answered?.by).toBeUndefined()
    expect((await humanTurns(id)).map((t) => t.text)).toEqual(['Layout B: with the links'])
    expect(delivered.sends).toHaveLength(1)
  })

  it('a redrain answers nothing twice and letters nothing', async () => {
    const id = await ask('Pick a font for the marina page')
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ia-redrain-answer', rev: 1, letterId: id, op: 'answer', actionId: 'a', madeAt: Date.now() - 1000 }
    const acked = await drainHanded([rec], 1)
    expect(acked).toEqual([1])
    expect((await letterOf(id)).answered).toMatchObject({ actionId: 'a' })
    expect(await humanTurns(id)).toHaveLength(1)
    expect(delivered.sends).toHaveLength(1)
    expect(refusedEntries('ia-redrain-answer')).toEqual([])
  })
})

describe('what the Mac refuses', () => {
  it('a letter gone, or an option it does not offer, is refused into the drain letter, not retried', async () => {
    const id = await ask('Pick a color for the marina page')
    const gone = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ir-gone', rev: 1, letterId: 'lt-gone0000-000000', op: 'reply', text: 'Hello?', clientId: 'ios-r3', madeAt: Date.now() }
    const unknown = { v: 2, seq: 2, at: Date.now(), kind: 'inbox-reply', opId: 'ia-unknown', rev: 1, letterId: id, op: 'answer', actionId: 'zzz', madeAt: Date.now() }
    const acked = await drainHanded([gone, unknown], 0)
    expect(acked.sort()).toEqual([1, 2])
    expect(refusedEntries('ir-gone')).toMatchObject([{ kind: 'refused', recordKind: 'inbox-reply', reason: expect.stringContaining('your reply "Hello?" to a letter was not delivered') }])
    expect(refusedEntries('ia-unknown')).toMatchObject([{ kind: 'refused', reason: expect.stringContaining('Unknown actionId') }])
    expect((await letterOf(id)).answered).toBeUndefined()
    expect(delivered.sends).toEqual([])
  })
})

// Review, 2026-11-07: three ways a drained turn could still be lost or dropped.
describe('nothing is acked before the words are in the session\'s queue', () => {
  it('a slow delivery holds the ack until it is queued, never acked on a pending one', async () => {
    const id = await ask('Pick a logo for the marina page')
    delivered.delayMs = 3_000
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ir-slow-delivery', rev: 1, letterId: id, op: 'reply', text: 'The round one', clientId: 'ios-r5', madeAt: Date.now() - 1000 }
    const acked = await drainHanded([rec], 0)
    expect(acked).toEqual([1])
    // At the ack the delivery was done: queued, never pending.
    expect(delivered.sends).toHaveLength(1)
    expect((await humanTurns(id))[0].delivery?.status).toBe('queued')
  }, 30_000)

  it('an answer with a slow delivery holds the ack until it is queued', async () => {
    const id = await ask('Pick a colour for the marina page')
    delivered.delayMs = 3_000
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ia-slow-delivery', rev: 1, letterId: id, op: 'answer', actionId: 'b', madeAt: Date.now() - 1000 }
    expect(await drainHanded([rec], 0)).toEqual([1])
    expect(delivered.sends).toHaveLength(1)
    expect((await humanTurns(id))[0].delivery?.status).toBe('queued')
  }, 30_000)

  it('an answer recorded but never handed over (a crash in between) is delivered on the redrain, once', async () => {
    const id = await ask('Pick a banner for the marina page')
    const madeAt = Date.now() - 5_000
    // The store has the answer, its delivery still pending: the process ended before the queue.
    await mac.inbox.answerLetter(id, { actionId: 'a' })
    expect((await humanTurns(id))[0].delivery?.status).toBe('pending')
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ia-pending-answer', rev: 1, letterId: id, op: 'answer', actionId: 'a', madeAt }
    const acked = await drainHanded([rec], 0)
    expect(acked).toEqual([1])
    expect(delivered.sends).toHaveLength(1)
    expect((await humanTurns(id))).toHaveLength(1)
    expect((await humanTurns(id))[0].delivery?.status).toBe('queued')
    expect(refusedEntries('ia-pending-answer')).toEqual([])
  })
})

describe('the reply\'s own read and unarchive are the human\'s moment', () => {
  it('a reply, then the letter archived again while away: archived after the drain', async () => {
    const id = await ask('Pick a map for the marina page')
    await mac.inbox.setArchived(id, true)
    await settle(20)
    const t = Date.now() + 1_000
    const reply = { v: 2, seq: 1, at: t, kind: 'inbox-reply', opId: 'ir-then-archive', rev: 1, letterId: id, op: 'reply', text: 'Map B', clientId: 'ios-r6', madeAt: t }
    const archive = { v: 2, seq: 2, at: t + 1_000, kind: 'inbox-state', opId: 'is-then-archive', rev: 1, letterId: id, field: 'archived', value: true, madeAt: t + 1_000 }
    // The drain runs well after both (the Mac woke 10 s later).
    await settle(20)
    vi.useFakeTimers({ toFake: ['Date'], now: t + 10_000 })
    try { await drainHanded([reply, archive], 0) } finally { vi.useRealTimers() }
    const letter = await letterOf(id)
    expect((await humanTurns(id)).map((x) => x.clientId)).toEqual(['ios-r6'])
    expect(letter.archived).toBe(true)
  })

  it('archived, then replied to while away: in the inbox after the drain (the reply was last)', async () => {
    const id = await ask('Pick a footer for the marina page')
    await settle(20)
    const t = Date.now() + 1_000
    const archive = { v: 2, seq: 1, at: t, kind: 'inbox-state', opId: 'is-before-reply', rev: 1, letterId: id, field: 'archived', value: true, madeAt: t }
    const reply = { v: 2, seq: 2, at: t + 1_000, kind: 'inbox-reply', opId: 'ir-after-archive', rev: 1, letterId: id, op: 'reply', text: 'Footer B', clientId: 'ios-r7', madeAt: t + 1_000 }
    vi.useFakeTimers({ toFake: ['Date'], now: t + 10_000 })
    try { await drainHanded([archive, reply], 0) } finally { vi.useRealTimers() }
    const letter = await letterOf(id)
    expect(letter.archived).toBe(false)
    expect(letter.read).toBe(true)
  })

  it('an answer, then the letter archived while away: archived after the drain', async () => {
    const id = await ask('Pick a header for the marina page')
    await mac.inbox.setArchived(id, true)
    await settle(20)
    const t = Date.now() + 1_000
    const answer = { v: 2, seq: 1, at: t, kind: 'inbox-reply', opId: 'ia-then-archive', rev: 1, letterId: id, op: 'answer', actionId: 'a', madeAt: t }
    const archive = { v: 2, seq: 2, at: t + 1_000, kind: 'inbox-state', opId: 'is-after-answer', rev: 1, letterId: id, field: 'archived', value: true, madeAt: t + 1_000 }
    vi.useFakeTimers({ toFake: ['Date'], now: t + 10_000 })
    try { await drainHanded([answer, archive], 0) } finally { vi.useRealTimers() }
    const letter = await letterOf(id)
    expect(letter.answered?.actionId).toBe('a')
    expect(letter.archived).toBe(true)
  })
})

describe('a long answer note is compared as the store keeps it', () => {
  it('a redrain of an answer whose note was cut is this record\'s, never refused', async () => {
    const id = await ask('Pick a layout note for the marina page')
    const note = 'n'.repeat(4001)
    const rec = { v: 2, seq: 1, at: Date.now(), kind: 'inbox-reply', opId: 'ia-long-note', rev: 1, letterId: id, op: 'answer', actionId: 'b', freeText: note, madeAt: Date.now() - 1000 }
    const acked = await drainHanded([rec], 1)
    expect(acked).toEqual([1])
    expect(await humanTurns(id)).toHaveLength(1)
    expect(delivered.sends).toHaveLength(1)
    expect(refusedEntries('ia-long-note')).toEqual([])
  })
})
