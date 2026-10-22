/**
 * A session's letter to the user, saved by its host while the Mac was away, end to end:
 * the real offline host journals it (offline-host-core.ts opLetter, a real journal in a
 * temp dir), and the real Mac drain (runOfflineHandover) takes it over a connection that
 * answers offline.drain / offline.blob / offline.ack from that host, and sends it through
 * the letter path the online op uses (apply-letter.ts → sendLetterAsCallerOnce) into the
 * letter store of a temp home. Covered: the letter as the session would have sent it
 * online (id, time, sender, body, buttons, one event), a redrain after a lost ack, a
 * crash between the send and the ledger row, a body the host lost, a record that is not a
 * whole letter, and an older Mac that never takes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-letter'))
const told = vi.hoisted(() => ({ texts: [] as Array<{ sid: string; text: string }> }))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async (session: { claudeSessionId: string }, msg: { enqueueText: string }) => {
    told.texts.push({ sid: session.claudeSessionId, text: msg.enqueueText })
    return { delivery: 'queued' }
  }),
}))
vi.mock('../../../src/ops/executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ops/executor.js')>()),
  executeOp: vi.fn(async () => { throw new Error('Draining a letter must not execute its item actions') }),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { lookupJournaled } from '../../../src/core/offline-merge/ledger.js'
import { agentReply, getLetter, humanInboxPaths, listLetters, sendLetterOnce, setArchived, setPinned, setRead, writeItemReceipt } from '../../../src/core/human-inbox/store.js'
import { readItemLedger } from '../../../src/core/human-inbox/item-ledger.js'
import type { InboxItemReceipt, InboxLetterItem } from '../../../src/core/human-inbox/types.js'
import { bus, type BusEvent } from '../../../src/core/event-bus.js'
import { executeOp } from '../../../src/ops/executor.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { JOURNAL_V2_DRAINS } from '../../../src/providers/offline-journal-core.js'
import { JHOME, journalHost, journalLines, journalTmpDir, cleanupJournalDirs, jslice, gatewayCall } from '../../helpers/offline-journal-harness.js'

const SID = 'efefefef-5555-4555-8555-555555555555'
const HOST = 'devbox'
const BODY = '## Two layouts\n\nPick one: café 中文 🚀.\n'
const ASK = {
  subject: 'Pick a layout for the marina page', type: 'action_required', markdown: BODY, text: 'Two layouts, need a pick',
  actions: [{ id: 'a', label: 'Layout A', description: 'denser' }, { id: 'b', label: 'Layout B' }],
}

const DIGEST_BODY = '## Mail digest\n\nThirty messages, each with its own available actions.\n'
const DIGEST = { subject: 'Marina mail digest', type: 'info' as const, markdown: DIGEST_BODY }
const mailItem = (id: string): InboxLetterItem => ({
  id, subject: `Marina update ${id}`, summary: 'Details: \u{e9} \u{4e2d}\u{6587} \u{1f680}.\nKeep each mail action separate.',
  source: { kind: 'mail', account: `account-${id}`, message: `message-${id}` },
  display: {
    sender: { name: 'Marina desk', address: 'desk@example.test' },
    sentAt: '2026-10-14T09:30:00Z', accountLabel: `Mailbox ${id}`, accountHint: 'A neutral test mailbox',
  },
  actions: [
    { id: `${id}-read`, kind: 'op', intent: 'mark_read' },
    { id: `${id}-find`, kind: 'op', intent: 'find_task' },
    { id: `${id}-create`, kind: 'op', intent: 'create_task' },
    { id: `${id}-attach`, kind: 'op', intent: 'attach_task' },
    { id: `${id}-ask`, kind: 'reply_ai', label: 'Ask about this mail', question: `Explain mail ${id}` },
  ],
})
const digestItems = (): InboxLetterItem[] => Array.from({ length: 30 }, (_, n) => mailItem(`digest-${n}`))

/** A host that saved letters, and the connection the Mac drains it over. */
function hostWithLetters(opts: { journalV2?: boolean; dropAcks?: number; skew?: number; mutate?: (r: Record<string, unknown>) => Record<string, unknown> } = {}) {
  // `skew`: how far this host's clock runs ahead of the Mac's.
  const skew = opts.skew ?? 0
  const clock = { now: Date.now() + skew }
  const journalDir = journalTmpDir()
  const h = journalHost(journalDir, clock, { letters: true })
  h.host.configure(jslice())
  const calls: Array<{ cmd: string; params?: Record<string, unknown> }> = []
  const gone = new Set<string>()
  let dropAcks = opts.dropAcks ?? 0
  let handed = 0
  const conn = {
    hostKey: HOST, journalV2: opts.journalV2 ?? true,
    send: async (cmd: string, p?: Record<string, unknown>) => {
      calls.push({ cmd, params: p })
      if (cmd === 'offline.drain') {
        clock.now = Date.now() + skew
        const out = h.host.drain(JHOME, (p?.kinds as string[] | undefined) ?? null)
        handed += out.records.length
        const records = opts.mutate ? out.records.map((r) => opts.mutate!(r as unknown as Record<string, unknown>)) : out.records
        return { ok: true, ...out, records }
      }
      if (cmd === 'offline.blob') {
        if (gone.has(String(p?.sha))) return { ok: false, code: 'not_found', message: 'this host does not hold that body' }
        return h.journal.readBlob(p?.sha, p?.offset) as unknown as Record<string, unknown>
      }
      if (cmd === 'offline.ack') {
        // A lost ack: the Mac applied the record, the host never heard.
        if (dropAcks > 0) { dropAcks--; return { ok: true, remaining: 1 } }
        return { ok: true, ...h.host.ack(JHOME, { seqs: p?.seqs, ...(typeof p?.now === 'number' ? { leaderNow: p.now } : {}) }) }
      }
      return { ok: true }
    },
  }
  const write = async (args: Record<string, unknown>, sid = SID) => {
    const r = await gatewayCall(h.host, sid, 'human_inbox_send', args)
    if (!r.ok) throw new Error(JSON.stringify(r))
    return r.result as { letterId: string; seq: number }
  }
  return { ...h, journalDir, clock, conn, calls, gone, write, handed: () => handed }
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function drain(conn: unknown): Promise<void> {
  await runOfflineHandover(conn as never)
  await settle()
}
function entries(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}
/** The letters a session sent (the drain's own letter about refused writes is `external`). */
async function sessionLetters() {
  return (await listLetters()).letters.filter((l) => l.sender.sessionId !== 'external')
}

const seen: BusEvent[] = []
let taskId = ''
beforeEach(async () => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  fs.rmSync(conflictDir(), { recursive: true, force: true })
  told.texts.length = 0
  seen.length = 0
  vi.mocked(executeOp).mockClear()
  bus.subscribe('test-drain-letter', (e) => { seen.push(e) }, { global: true })
  if (!taskId) {
    taskId = (await addTask({ title: 'Marina page', project: 'Acme' } as never)).task.id
    await createSessionRecord(SID, taskId, 'Acme', '/tmp', { host: HOST, title: 'Build the marina page' })
  }
})
afterEach(() => { bus.unsubscribe('test-drain-letter'); cleanupJournalDirs() })
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

const newLetterEvents = () => seen.filter((e) => e.name === 'human-inbox:letter' && (e.data as { kind?: string }).kind === 'new'
  && (e.data as { senderSessionId?: string }).senderSessionId === SID)

describe('a letter saved on the host reaches the inbox as if sent online', () => {
  it('with its id, the time it was written, the session as sender, its body and buttons, once', async () => {
    const h = hostWithLetters()
    const writtenAt = Date.now() - 2 * 3_600_000
    h.clock.now = writtenAt
    const { letterId } = await h.write(ASK)
    await drain(h.conn)

    const letters = await sessionLetters()
    expect(letters).toHaveLength(1)
    // On this Mac's clock, measured at the drain (a few ms of round trip).
    expect(Math.abs(letters[0].createdAt - writtenAt)).toBeLessThan(100)
    expect(letters[0]).toMatchObject({
      id: letterId, subject: ASK.subject, type: 'action_required', bodyFormat: 'markdown',
      textPreview: 'Two layouts, need a pick', read: false,
      sender: { sessionId: SID, host: HOST, sessionTitle: 'Build the marina page', taskId, taskTitle: 'Marina page', project: 'Acme' },
      actions: [{ id: 'a', label: 'Layout A', description: 'denser' }, { id: 'b', label: 'Layout B' }],
    })
    expect((await getLetter(letterId))?.body).toBe(BODY)
    expect(newLetterEvents()).toHaveLength(1)
    // Applied, recorded in the ledger, acked; the host holds nothing more, and no letter about it.
    expect(h.journal.records(JHOME)).toEqual([])
    expect(h.calls.find((c) => c.cmd === 'offline.drain')?.params).toMatchObject({ kinds: expect.arrayContaining(['letter']) })
    expect(entries()).toEqual([])
    expect(told.texts).toEqual([])
  })

  it('dates it on this Mac\'s clock, for a host whose clock runs ten minutes ahead', async () => {
    const skew = 10 * 60_000
    const h = hostWithLetters({ skew })
    const writtenAt = Date.now() - 3_600_000
    h.clock.now = writtenAt + skew
    const { letterId } = await h.write({ subject: 'Report', type: 'review', html: '<p>Ready</p>' })
    expect(h.journal.records(JHOME)[0]).toMatchObject({ at: writtenAt + skew })
    await drain(h.conn)
    const l = (await sessionLetters()).find((x) => x.id === letterId)
    expect(l).toMatchObject({ bodyFormat: 'html' })
    expect(Math.abs(l!.createdAt - writtenAt)).toBeLessThan(100)
    expect((await getLetter(letterId))?.body).toBe('<p>Ready</p>')
  })

  it('several letters of one drain arrive in order, each once', async () => {
    const h = hostWithLetters()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { h.clock.now = Date.now() - (10 - i) * 60_000; ids.push((await h.write({ subject: `Digest ${i}`, type: 'info', markdown: `day ${i}` })).letterId) }
    await drain(h.conn)
    const letters = await sessionLetters()
    expect(letters.map((l) => l.id).sort()).toEqual([...ids].sort())
    expect(newLetterEvents()).toHaveLength(5)
  })
})

describe('typed mail items survive the offline letter journal', () => {
  it('drains all thirty items exactly once without executing their actions', async () => {
    const h = hostWithLetters({ dropAcks: 2 })
    const items = digestItems()
    const { letterId } = await h.write({ ...DIGEST, items })
    const rec = h.journal.records(JHOME)[0] as unknown as { opId: string; rev: number; args: { items: InboxLetterItem[] } }
    expect(h.journal.records(JHOME)).toHaveLength(1)
    expect(rec.args.items).toEqual(items)
    expect(journalLines(h.journalDir).map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ v: 2, h: 1, home: JHOME, nextSeq: 1 }),
      expect.objectContaining({ kind: 'letter', letterId, args: expect.objectContaining({ items }) }),
    ])
    const executionBefore = await readItemLedger()

    await drain(h.conn)
    await drain(h.conn)

    const saved = (await getLetter(letterId))!
    expect(saved).toMatchObject({ id: letterId, type: 'info', body: DIGEST_BODY, createdByOp: rec.opId })
    expect(saved.items).toEqual(items.map(item => ({ ...item, receipts: [] })))
    expect(saved.items).toHaveLength(30)
    expect(saved.thread).toEqual([])
    expect(saved.answered).toBeUndefined()
    expect((await sessionLetters()).map(letter => letter.id)).toEqual([letterId])
    expect(newLetterEvents()).toHaveLength(1)
    expect(h.handed()).toBeGreaterThanOrEqual(3)
    expect(h.journal.records(JHOME)).toEqual([])
    expect(lookupJournaled({ hostKey: HOST, home: WALNUT_HOME, opId: rec.opId, rev: rec.rev })).toMatchObject({ outcome: 'applied' })
    expect(await readItemLedger()).toEqual(executionBefore)
    expect(executeOp).not.toHaveBeenCalled()
    expect(told.texts).toEqual([])
    expect(entries()).toEqual([])
  })

  it('a crash before the ledger and a lost ack preserve root items, thread items, receipts and reader flags on redrain', async () => {
    // Ten lost acks keep the real journal pending across two separate handovers.
    const h = hostWithLetters({ dropAcks: 10 })
    const items = digestItems()
    const { letterId } = await h.write({ ...DIGEST, items })
    const rec = h.journal.records(JHOME)[0] as unknown as { opId: string; rev: number; args: { items: InboxLetterItem[] } }
    expect(rec.args.items).toEqual(items)
    const key = { hostKey: HOST, home: WALNUT_HOME, opId: rec.opId, rev: rec.rev }
    expect(lookupJournaled(key)).toBeNull()
    // The crashed drain sent the original letter but never recorded or acked the op.
    const sent = await sendLetterOnce({ ...DIGEST, items, sender: { sessionId: SID, host: HOST } }, { id: letterId, opKey: rec.opId })
    expect(sent.duplicate).toBe(false)
    expect(sent.letter).toMatchObject({ id: letterId, createdByOp: rec.opId })
    expect(newLetterEvents()).toHaveLength(1)
    const followup = mailItem('followup-mail')
    await agentReply(letterId, { text: 'One more message arrived', markdown: '## Follow-up\n\nKeep this thread document.', items: [followup] })
    const receipt: InboxItemReceipt = {
      actionId: items[0].actions[0].id, requestId: 'digest-read-request', planId: 'digest-read-plan', planVersion: 1,
      revision: 1, updatedAt: '2026-10-14T10:00:00Z', status: 'success', intent: 'mark_read', source: items[0].source,
      input: {}, stage: 'finished', recovery: [],
    }
    await writeItemReceipt(letterId, items[0].id, receipt)
    const newerReceipt = { ...receipt, revision: 2, updatedAt: '2026-10-14T10:01:00Z' }
    await writeItemReceipt(letterId, items[0].id, newerReceipt)
    await setRead(letterId, true)
    await setPinned(letterId, true)
    await setArchived(letterId, true)
    const before = (await getLetter(letterId))!
    expect(before.items).toEqual(items.map((item, n) => ({ ...item, receipts: n === 0 ? [newerReceipt] : [] })))
    expect(before.thread).toEqual([expect.objectContaining({
      from: 'agent', text: 'One more message arrived', body: '## Follow-up\n\nKeep this thread document.',
      items: [{ ...followup, receipts: [] }],
    })])
    expect(before).toMatchObject({ read: true, pinned: true, archived: true, body: DIGEST_BODY, createdByOp: rec.opId })
    const executionBefore = await readItemLedger()
    seen.length = 0

    await drain(h.conn)
    expect(h.journal.records(JHOME)).toHaveLength(1)
    expect(lookupJournaled(key)).toMatchObject({ outcome: 'applied' })
    expect(await getLetter(letterId)).toEqual(before)
    await drain(h.conn)

    expect(h.handed()).toBeGreaterThanOrEqual(11)
    expect(h.journal.records(JHOME)).toEqual([])
    expect(await getLetter(letterId)).toEqual(before)
    const kept = await sendLetterOnce({ ...DIGEST, items, sender: { sessionId: SID, host: HOST } }, { id: letterId, opKey: rec.opId })
    expect(kept.duplicate).toBe(true)
    expect(kept.letter).toEqual((await listLetters({ archived: true })).letters[0])
    expect((await listLetters()).letters).toEqual([])
    expect((await listLetters({ archived: true })).letters.map(letter => letter.id)).toEqual([letterId])
    expect(newLetterEvents()).toHaveLength(0)
    expect(await readItemLedger()).toEqual(executionBefore)
    expect(executeOp).not.toHaveBeenCalled()
    expect(told.texts).toEqual([])
    expect(entries()).toEqual([])
  })

  it.each([
    ['an arbitrary tool', [{ ...mailItem('unsafe'), actions: [{ id: 'unsafe-read', kind: 'op', intent: 'mark_read', tool: 'arbitrary_tool' }] }], /actions\.0\.tool/],
    ['arbitrary arguments', [{ ...mailItem('unsafe'), actions: [{ id: 'unsafe-read', kind: 'op', intent: 'mark_read', args: { account: 'another-account' } }] }], /actions\.0\.args/],
    ['duplicate item ids', [mailItem('same'), { ...mailItem('other'), id: 'same' }], /Duplicate item or action id: same/],
    ['duplicate action ids', [mailItem('one'), { ...mailItem('two'), actions: [{ id: 'one-read', kind: 'op', intent: 'mark_read' }] }], /Duplicate item or action id: one-read/],
  ] as Array<[string, unknown[], RegExp]>)('rejects %s without saving a journal record', async (_label, items, message) => {
    const h = hostWithLetters()
    const result = await gatewayCall(h.host, SID, 'human_inbox_send', { ...DIGEST, items })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_request', message: expect.stringMatching(message) } })
    expect(h.journal.records(JHOME)).toEqual([])
    expect(journalLines(h.journalDir)).toEqual([])
    expect(await sessionLetters()).toEqual([])
    expect(executeOp).not.toHaveBeenCalled()
  })

  it('rejects metadata over 256 KiB honestly instead of dropping mail items', async () => {
    const h = hostWithLetters()
    // Every item is valid on its own; only the journal's aggregate metadata cap is exceeded.
    const items = digestItems().map(item => ({ ...item, summary: 's'.repeat(10_000) }))
    const args = { ...DIGEST, items }
    expect(Buffer.byteLength(JSON.stringify({ subject: args.subject, type: args.type, items }), 'utf8')).toBeGreaterThan(256 * 1024)
    const result = await gatewayCall(h.host, SID, 'human_inbox_send', args)
    expect(result).toMatchObject({
      ok: false, error: { code: 'bad_request', message: "the letter's fields are too large to save on this host (limit 262144 bytes besides the body)" },
    })
    expect(h.journal.records(JHOME)).toEqual([])
    expect(journalLines(h.journalDir)).toEqual([])
    expect(items).toHaveLength(30)
    expect(items.every(item => item.summary.length === 10_000)).toBe(true)
    expect(await sessionLetters()).toEqual([])
    expect(newLetterEvents()).toHaveLength(0)
    // A smaller retry keeps all thirty items rather than inheriting any truncated save.
    const retryItems = digestItems()
    await h.write({ ...DIGEST, items: retryItems })
    expect(h.journal.records(JHOME)).toHaveLength(1)
    expect(h.journal.records(JHOME)[0].args).toMatchObject({ items: retryItems })
    expect(executeOp).not.toHaveBeenCalled()
  })
})

describe('a letter is never sent twice', () => {
  it('a redrain after a lost ack: the ledger answers, nothing is sent again', async () => {
    const h = hostWithLetters({ dropAcks: 2 })
    const { letterId } = await h.write(ASK)
    // The drain's next round, then the next drain, are handed the same record again.
    await drain(h.conn)
    await drain(h.conn)
    expect(h.handed()).toBeGreaterThanOrEqual(3)
    expect(h.journal.records(JHOME)).toEqual([])
    expect((await sessionLetters()).map((l) => l.id)).toEqual([letterId])
    expect(newLetterEvents()).toHaveLength(1)
  })

  it('a crash after the send and before its ledger row: the letter\'s op id answers, nothing is sent again', async () => {
    const h = hostWithLetters()
    const { letterId } = await h.write(ASK)
    const rec = h.journal.records(JHOME)[0] as unknown as { opId: string; rev: number }
    // What the crashed drain did before it died: the letter is in the store under the op.
    await sendLetterOnce({ ...ASK, type: 'action_required', sender: { sessionId: SID, host: HOST } } as never, { id: letterId, opKey: rec.opId })
    seen.length = 0
    await drain(h.conn)
    expect((await sessionLetters()).map((l) => l.id)).toEqual([letterId])
    expect(newLetterEvents()).toHaveLength(0)
    expect(h.journal.records(JHOME)).toEqual([])
    expect(lookupJournaled({ hostKey: HOST, home: WALNUT_HOME, opId: rec.opId, rev: rec.rev })).toMatchObject({ outcome: 'applied' })
  })
})

describe('a letter that cannot be sent is refused, lettered and told, then acked', () => {
  it('its body is gone from the host', async () => {
    const h = hostWithLetters()
    const { letterId } = await h.write(ASK)
    h.gone.add(String((h.journal.records(JHOME)[0] as unknown as { bodyBlob: string }).bodyBlob))
    await drain(h.conn)
    expect(await sessionLetters()).toEqual([])
    expect(h.journal.records(JHOME)).toEqual([])
    const e = entries()
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ kind: 'refused', recordKind: 'letter', reason: `the letter "${ASK.subject}" (${letterId}) was not sent: its text is gone from the host` })
    expect(told.texts).toHaveLength(1)
    expect(told.texts[0].sid).toBe(SID)
    expect(told.texts[0].text).toContain(`- human_inbox_send: the letter "${ASK.subject}" (${letterId}) was not sent: its text is gone from the host`)
    // The drain's own letter names it as a letter to the user.
    const own = (await listLetters()).letters.filter((l) => l.sender.sessionId === 'external')
    expect(own).toHaveLength(1)
    expect((await getLetter(own[0].id))?.body).toContain('a letter to you')
  })

  it.each([
    ['no arguments', { args: undefined }, /the record is not a whole letter$/],
    ['no body', { bodyBlob: undefined }, /the record is not a whole letter$/],
    ['an unknown format', { format: 'pdf' }, /the record is not a whole letter$/],
    ['arguments the op refuses', { args: { subject: 'Hi', type: 'urgent' } }, /was not sent: Invalid arguments for human_inbox_send: type/],
    ['a decision with no options', { args: { subject: 'Hi', type: 'action_required' } }, /was not sent: action_required needs at least one action/],
  ] as Array<[string, Record<string, unknown>, RegExp]>)('the record has %s', async (_label, over, reason) => {
    // A record no host of this build writes (a damaged or foreign journal line).
    const h = hostWithLetters({ mutate: (r) => ({ ...r, ...over }) })
    await h.write({ subject: 'Hi', type: 'info', markdown: 'm' })
    await drain(h.conn)
    expect(await sessionLetters()).toEqual([])
    expect(entries()).toEqual([expect.objectContaining({ kind: 'refused', recordKind: 'letter', reason: expect.stringMatching(reason) })])
    expect(h.journal.records(JHOME)).toEqual([])
    expect(told.texts.map((t) => t.sid)).toEqual([SID])
  })
})

describe('an older Mac never takes a letter', () => {
  it('a Mac without journal v2 leaves it on the host', async () => {
    const h = hostWithLetters({ journalV2: false })
    await h.write(ASK)
    await drain(h.conn)
    expect(await sessionLetters()).toEqual([])
    expect(h.journal.records(JHOME)).toHaveLength(1)
  })

  it('a Mac whose kinds leave letters out: the host never handed it one', async () => {
    const h = hostWithLetters()
    await h.write(ASK)
    expect(h.host.drain(JHOME, JOURNAL_V2_DRAINS.filter((k) => k !== 'letter')).records).toEqual([])
    expect(h.journal.records(JHOME)).toHaveLength(1)
  })
})
