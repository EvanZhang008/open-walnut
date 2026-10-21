/**
 * Stage 3a of docs/plan/walnut-companion-unified-replica.md, the Mac's side: the
 * companion's journal (core/companion-journal.ts) drained by the Mac's handover
 * (core/companion-journal-drain.ts, host key `companion`) over the real door
 * (web/routes/bridge-journal.ts, machine credential, gzip), applied to the Mac's
 * real task store.
 *
 * Pinned:
 *   - an away field write lands once, keyed `companion|<opId>|<rev>` on the task, and
 *     leaves the companion's journal;
 *   - the queue and the journal carry the same op id, so a write that went both ways
 *     (a live send that timed out after it landed, then journaled; or the reverse) is
 *     applied once, whichever arrives first;
 *   - a field the Mac changed meanwhile is a conflict, lettered as the companion's;
 *   - slice 3b: a session metadata patch lands through the online patch's own call; one
 *     that call refuses (an archive of a running session) is lettered with the session's
 *     title, never its id; a field the record may not carry is refused whole;
 *   - slice 3c: an inbox flag lands with the human's moment as `since`, so a newer change
 *     made on the Mac wins; a flag of a letter the Mac no longer has is skipped quietly
 *     (no letter about a read mark);
 *   - slice 3d: a task born on the companion lands with the id it minted, its fields and
 *     its project, once (created_by_op); a create the queue already landed (a live send
 *     that timed out after it landed) is skipped, never re-minted and never merged again
 *     over a later Mac edit; a later edit of it lands after it;
 *   - stage 4c: a note saved on the companion lands on the Mac with its body fetched
 *     through the door (`offline.blob`); an edit the Mac made meanwhile to another
 *     part of the note is merged with it, never lost;
 *   - slice 3e: a chat turn the companion answered itself lands in its conversation once
 *     (adopted by turn id, the row ensured), its texts fetched through the door and never
 *     inline; one the outbox already handed over is skipped; one whose answer the
 *     companion lost lands as a failed turn, its words kept; one whose words are lost is
 *     refused into the letter;
 *   - stage 4d: a memory save lands and merges like a note (apply-memory.ts); a note
 *     moved on the companion is moved on the Mac where the note is now, found by its id
 *     (apply-note-move.ts); one moved on the Mac meanwhile, or onto a taken path, stays
 *     and is lettered; one deleted on the Mac is quiet; a note made, moved and saved on
 *     the companion lands at its new path with its text, in that order;
 *   - a drain with nothing waiting is quiet.
 *
 * CLOUD_MODE is read at import, so the companion and the Mac are two module graphs
 * (vi.resetModules + doMock) over one temp home: the companion keeps its journal under
 * cache/journal, the Mac its task store under tasks/.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constantsBase = createMockConstants('walnut-drain-companion-journal')

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
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
    companionOp: await import('../../../src/core/offline-merge/companion-op.js'),
    conflicts: await import('../../../src/core/offline-merge/conflict-log.js'),
    letter: await import('../../../src/core/offline-merge/letter.js'),
    ingest: await import('../../../src/core/cloud-ingest.js'),
    sessions: await import('../../../src/core/session-tracker.js'),
    inbox: await import('../../../src/core/human-inbox/store.js'),
    outbox: await import('../../../src/core/task-outbox.js'),
    chatOutbox: await import('../../../src/core/cloud-chat-outbox.js'),
    notesIndex: await import('../../../src/core/notes-index.js'),
    indexer: await import('../../../src/core/notes-indexer.js'),
    notesRoute: await import('../../../src/web/routes/notes-v2.js'),
  }
}

const HOME = constantsBase.WALNUT_HOME as string
const token = crypto.randomBytes(16).toString('hex')
let companion: Awaited<ReturnType<typeof loadCompanion>>
let mac: Awaited<ReturnType<typeof loadMac>>
let server: Server
let opN = 0
const opId = () => `op-cj-${(++opN).toString(16).padStart(8, '0')}`

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
  // The Mac drains once with nothing waiting: the companion learns the kinds it takes.
  await mac.drain.drainCompanionJournalNow()
  expect(companion.journal.macDrains('task-fields')).toBe(true)
}, 60_000)

afterAll(async () => {
  mac?.handover._setHandoverBackoffForTesting(null)
  await mac?.indexer.settleNotesIndexer().catch(() => {})
  mac?.taskDb.closeDb()
  companion?.journal._resetCompanionJournalForTesting()
  await new Promise<void>((r) => server?.close(() => r()))
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {})
})

const appliedOps = async (id: string) => (await mac.tm.getTask(id)).applied_ops ?? []
const updateOp = (id: string, op: string, fields: Record<string, { base: unknown; value: unknown; at: number }>) => ({
  opId: op, type: 'update' as const, at: new Date().toISOString(), task: { id } as never, fields,
})

describe('the Mac drains the companion\'s journal', () => {
  it('an away write lands once, keyed by the companion\'s op id, and leaves the journal', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme plan', project: 'Acme' } as never)).task.id
    const op = opId()
    const r = companion.journal.journalTaskFields({ opId: op, taskId: id, fields: { title: { base: 'Acme plan', value: 'Acme plan, from the phone', at: Date.now() } } })
    expect(r).toMatchObject({ ok: true })
    const result = await mac.drain.drainCompanionJournalNow()
    expect(result).not.toBeNull()
    expect((await mac.tm.getTask(id)).title).toBe('Acme plan, from the phone')
    expect(await appliedOps(id)).toContain(`companion|${op}|1`)
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // The same record drained again (a Mac that crashed before its ack) changes nothing.
    const before = JSON.stringify(await mac.tm.getTask(id))
    await mac.drain.drainCompanionJournalNow()
    expect(JSON.stringify(await mac.tm.getTask(id))).toBe(before)
  })

  it('the journal first, then the same op through the queue: applied once', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme beta', project: 'Acme' } as never)).task.id
    const op = opId()
    const fields = { priority: { base: 'none', value: 'important', at: Date.now() } }
    companion.journal.journalTaskFields({ opId: op, taskId: id, fields })
    await mac.drain.drainCompanionJournalNow()
    expect((await mac.tm.getTask(id)).priority).toBe('important')
    // The Mac's own edit after it, then the queue's copy of the same op arrives.
    await mac.tm.updateTask(id, { priority: 'backlog' } as never)
    const r = await mac.companionOp.applyCompanionFields(updateOp(id, op, fields) as never, fields as never)
    expect(r).toMatchObject({ applied: false, reason: 'unchanged' })
    expect((await mac.tm.getTask(id)).priority).toBe('backlog')
  })

  it('the queue first (a live send that landed and timed out), then the journal record: applied once', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme gamma', project: 'Acme' } as never)).task.id
    const op = opId()
    const fields = { title: { base: 'Acme gamma', value: 'Acme gamma, renamed', at: Date.now() } }
    expect(await mac.companionOp.applyCompanionFields(updateOp(id, op, fields) as never, fields as never)).toMatchObject({ applied: true })
    await mac.tm.updateTask(id, { title: 'Acme gamma, the Mac\'s name' } as never)
    companion.journal.journalTaskFields({ opId: op, taskId: id, fields })
    await mac.drain.drainCompanionJournalNow()
    expect((await mac.tm.getTask(id)).title).toBe('Acme gamma, the Mac\'s name')
    expect(companion.journal.companionJournalRecords()).toEqual([])
  })

  it('a field the Mac changed meanwhile is a conflict, lettered as the companion\'s', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme delta', project: 'Acme' } as never)).task.id
    await mac.tm.updateTask(id, { priority: 'backlog' } as never)
    const op = opId()
    companion.journal.journalTaskFields({ opId: op, taskId: id, fields: { priority: { base: 'none', value: 'important', at: Date.now() - 600_000 } } })
    await mac.drain.drainCompanionJournalNow()
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // The Mac's later write is kept; the phone's is in the letter.
    expect((await mac.tm.getTask(id)).priority).toBe('backlog')
    const dir = mac.conflicts.conflictDir()
    const logs = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => mac.conflicts.readConflictLog(n.slice(0, -5))).filter(Boolean)
    const mine = logs.find((l) => l!.entries.some((e) => e.opId === op))
    expect(mine).toBeTruthy()
    expect(mine!.hostKey).toBe('companion')
    const letter = mac.letter.buildConflictLetter(mine!)
    expect(letter?.markdown ?? '').toContain('your cloud companion')
    expect(letter?.markdown ?? '').not.toContain('host companion')
  })

  it('a session change lands through the online patch; one it refuses is lettered by the session\'s title', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme epsilon', project: 'Acme' } as never)).task.id
    const sid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
    await mac.sessions.createSessionRecord(sid, id, 'Acme', '/tmp', { title: 'Acme epsilon run' })
    await mac.sessions.updateSessionRecord(sid, { process_status: 'running' } as never)
    expect(companion.journal.journalSessionMeta({ sessionId: sid, patch: { title: 'Acme epsilon, renamed away', human_note: 'Check the vendor reply' } })).toMatchObject({ ok: true })
    const refusedOp = companion.journal.journalSessionMeta({ sessionId: sid, patch: { archived: true } })
    expect(refusedOp).toMatchObject({ ok: true })
    // `mode` acts on the live CLI: never journaled (the caller relays or queues it).
    expect(companion.journal.journalSessionMeta({ sessionId: sid, patch: { mode: 'plan' } })).toBeNull()
    await mac.drain.drainCompanionJournalNow()
    expect(companion.journal.companionJournalRecords()).toEqual([])
    const rec = await mac.sessions.getSessionByClaudeId(sid)
    expect(rec).toMatchObject({ title: 'Acme epsilon, renamed away', human_note: 'Check the vendor reply' })
    expect(rec?.archived).not.toBe(true)
    const logs = fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json')).map((n) => mac.conflicts.readConflictLog(n.slice(0, -5))).filter(Boolean)
    const mine = logs.flatMap((l) => l!.entries.map((e) => ({ l: l!, e }))).find(({ e }) => e.opId === (refusedOp as { opId: string }).opId)
    expect(mine?.e).toMatchObject({ kind: 'refused', recordKind: 'session-meta' })
    const letter = mac.letter.buildConflictLetter(mine!.l)!.markdown
    expect(letter).toContain('the session "Acme epsilon, renamed away" (archived): Stop session before archiving')
    expect(letter).not.toContain(sid)
  })

  it('a session record naming a field it may not carry is refused whole', async () => {
    const id = (await mac.tm.addTask({ title: 'Acme zeta', project: 'Acme' } as never)).task.id
    const sid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    await mac.sessions.createSessionRecord(sid, id, 'Acme', '/tmp', { title: 'Acme zeta run', mode: 'default' })
    const handed: Array<Record<string, unknown>> = [{ v: 2, seq: 1, at: Date.now(), kind: 'session-meta', opId: opId(), rev: 1, sid, patch: { title: 'Acme zeta, renamed', mode: 'plan' } }]
    const acked: number[] = []
    mac.handover._resetOfflineHandoverForTesting()
    await mac.handover.runOfflineHandover({
      hostKey: 'companion', journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: handed.filter((r) => !acked.includes(r.seq as number)), now: Date.now() }
        if (cmd === 'offline.ack') acked.push(...((p?.seqs as number[]) ?? []))
        return { ok: true }
      },
    } as never)
    expect(acked).toEqual([1])
    expect((await mac.sessions.getSessionByClaudeId(sid))?.title).toBe('Acme zeta run')
  })

  it('an inbox flag lands; one older than a change made on the Mac does not; a letter gone is skipped quietly', async () => {
    const sender = { sessionId: 'sess-mac', host: 'workstation' }
    const a = (await mac.inbox.sendLetter({ subject: 'Acme digest', type: 'review', markdown: '# Digest', sender })).id
    const b = (await mac.inbox.sendLetter({ subject: 'Acme deploy', type: 'completion', markdown: 'Done', sender })).id
    const awayAt = Date.now() - 60_000
    // b: the Mac changed the flag after the phone did (read here, then unread again).
    await mac.inbox.setLetterState(b, 'read', true)
    await mac.inbox.setLetterState(b, 'read', false)
    const conflictsBefore = fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()).length : 0
    expect(companion.journal.journalInboxState({ letterId: a, field: 'read', value: true, madeAt: awayAt })).toMatchObject({ ok: true })
    expect(companion.journal.journalInboxState({ letterId: a, field: 'pinned', value: true, madeAt: awayAt })).toMatchObject({ ok: true })
    expect(companion.journal.journalInboxState({ letterId: b, field: 'read', value: true, madeAt: awayAt })).toMatchObject({ ok: true })
    expect(companion.journal.journalInboxState({ letterId: 'lt-gone0000-000000', field: 'archived', value: true, madeAt: awayAt })).toMatchObject({ ok: true })
    const result = await mac.drain.drainCompanionJournalNow()
    expect(companion.journal.companionJournalRecords()).toEqual([])
    const letters = (await mac.inbox.listLetters({ archived: false })).letters
    expect(letters.find((l) => l.id === a)).toMatchObject({ read: true, pinned: true })
    expect(letters.find((l) => l.id === b)?.read).toBe(false)
    expect(result).toMatchObject({ replayed: 2, skipped: 2, failed: 0 })
    const conflictsAfter = fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()).length : 0
    expect(conflictsAfter).toBe(conflictsBefore)
  })

  it('a task born on the companion lands with its id, fields and project, once; an edit of it lands after it', async () => {
    const id = `mcj${Date.now().toString(36)}aa01`
    const op = opId()
    companion.journal.journalTaskCreate({
      opId: op, taskId: id,
      fields: { title: 'Acme launch checklist', priority: 'important', description: 'From the phone', phase: 'IN_PROGRESS', note: 'Ask the vendor' },
      placement: { project: 'Acme' },
    })
    const madeAt = Date.now()
    // Its edit, made after it on the box: a record of its own, behind it.
    companion.journal.journalTaskFields({ opId: opId(), taskId: id, fields: { title: { base: 'Acme launch checklist', value: 'Acme launch checklist, v2', at: Date.now() } } })
    await new Promise((r) => setTimeout(r, 400))
    const drainedAt = Date.now()
    await mac.drain.drainCompanionJournalNow()
    const t = await mac.tm.getTask(id)
    // The task keeps the moment it was made on the box, not the drain's.
    expect(Date.parse(t.created_at)).toBeGreaterThanOrEqual(madeAt - 1_000)
    expect(Date.parse(t.created_at)).toBeLessThan(drainedAt - 200)
    expect(t).toMatchObject({ id, title: 'Acme launch checklist, v2', project: 'Acme', priority: 'important', description: 'From the phone', phase: 'IN_PROGRESS', created_by_op: op })
    expect(t.note).toContain('Ask the vendor')
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // Drained again (a Mac that crashed before its ack): still one task, unchanged.
    const before = JSON.stringify(await mac.tm.getTask(id))
    companion.journal.journalTaskCreate({ opId: op, taskId: id, fields: { title: 'Acme launch checklist' }, placement: { project: 'Acme' } })
    await mac.drain.drainCompanionJournalNow()
    expect(JSON.stringify(await mac.tm.getTask(id))).toBe(before)
    expect((await mac.tm.listTasks()).filter((x) => x.title.startsWith('Acme launch checklist'))).toHaveLength(1)
  })

  it('a create the queue already landed, then its journal record: skipped, never re-minted or merged again', async () => {
    const id = `mcj${Date.now().toString(36)}bb02`
    const op = opId()
    const now = new Date().toISOString()
    const row = { id, title: 'Acme budget', status: 'todo', phase: 'IN_PROGRESS', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: now, updated_at: now }
    expect(await mac.outbox.applyTaskOp({ opId: op, type: 'create', at: now, task: row } as never)).toMatchObject({ applied: true, reason: 'created' })
    expect(await mac.tm.getTask(id)).toMatchObject({ created_by_op: op })
    // The Mac moves it on, then the journal's copy of the same create arrives.
    await mac.tm.updateTask(id, { phase: 'NEED_ACTION' } as never)
    expect((await mac.tm.getTask(id)).phase).toBe('NEED_ACTION')
    const conflictsBefore = fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()).length : 0
    companion.journal.journalTaskCreate({ opId: op, taskId: id, fields: { title: 'Acme budget', phase: 'IN_PROGRESS', summary: 'Draft from the phone' }, placement: { project: 'Acme' } })
    const result = await mac.drain.drainCompanionJournalNow()
    expect(result).toMatchObject({ failed: 0 })
    expect((await mac.tm.listTasks()).filter((x) => x.title === 'Acme budget')).toHaveLength(1)
    expect((await mac.tm.getTask(id)).phase).toBe('NEED_ACTION')
    const conflictsAfter = fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()).length : 0
    expect(conflictsAfter).toBe(conflictsBefore)
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // And the queue's op again (a retry after the box lost the answer): nothing changes.
    mac.outbox._resetAppliedOpIdsForTesting() // the in-memory op set forgot it: the row decides
    expect(await mac.outbox.applyTaskOp({ opId: op, type: 'create', at: now, task: row } as never)).toMatchObject({ applied: false, reason: 'unchanged' })
    expect((await mac.tm.getTask(id)).phase).toBe('NEED_ACTION')
  })

  it('a note saved on the companion lands on the Mac; an edit the Mac made meanwhile is merged with it', async () => {
    const notesDir = constantsBase.NOTES_DIR as string
    const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
    const save = (rel: string, base: string, ours: string) => companion.journal.journalNote({
      path: rel, mode: 'put', baseHash: sha12(base), base: Buffer.from(base), ours: Buffer.from(ours), oursHash: sha12(ours),
    })
    await fsp.mkdir(path.join(notesDir, 'Acme'), { recursive: true })
    // A plain save over the note as the Mac has it.
    const base = '---\nid: n_acmeplan001\n---\n# Acme plan\n\nShip on Friday.\n'
    await fsp.writeFile(path.join(notesDir, 'Acme/plan.md'), base)
    const ours = `${base}\nBook the venue.\n`
    expect(save('Acme/plan.md', base, ours)).toMatchObject({ ok: true })
    await mac.drain.drainCompanionJournalNow()
    expect(await fsp.readFile(path.join(notesDir, 'Acme/plan.md'), 'utf8')).toBe(ours)
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // The Mac changes the title line, the companion the last line: both stay.
    const base2 = '---\nid: n_acmetodo001\n---\n# Acme todo\n\nfirst line\n\nsecond line\n\nthird line\n'
    await fsp.writeFile(path.join(notesDir, 'Acme/todo.md'), base2)
    expect(save('Acme/todo.md', base2, base2.replace('third line', 'third line, from the phone'))).toMatchObject({ ok: true })
    await fsp.writeFile(path.join(notesDir, 'Acme/todo.md'), base2.replace('first line', 'first line, from the Mac'))
    await mac.drain.drainCompanionJournalNow()
    const merged = await fsp.readFile(path.join(notesDir, 'Acme/todo.md'), 'utf8')
    expect(merged).toContain('first line, from the Mac')
    expect(merged).toContain('third line, from the phone')
    expect(companion.journal.companionJournalRecords()).toEqual([])
  })

  it('a chat turn the companion answered lands in its conversation once, its texts read through the door', async () => {
    const conv = 'conv-acme-away-0001'
    const readStore = async () => JSON.parse(await fsp.readFile(constantsBase.conversationFile('general', conv) as string, 'utf8')) as { entries: Array<Record<string, any>> }
    const turn = (turnId: string, extra: Record<string, unknown> = {}) => ({
      turnId, agentId: 'general', conversationId: conv, userText: 'what is left for acme?', userAt: '2026-10-21T08:00:00.000Z',
      engine: 'cloud:s-lane-0001', answerText: 'Two steps are left: the venue and the vendor.', answeredAt: '2026-10-21T08:00:05.000Z', ...extra,
    })
    const t1 = crypto.randomUUID()
    expect(companion.journal.journalChatTurn(turn(t1))).toMatchObject({ ok: true })
    const rec = companion.journal.companionJournalRecords().find((x) => x.kind === 'chat-turn')!
    expect(rec).toMatchObject({ turnId: t1, opId: `chat-${t1}`, blobs: [rec.userBlob, rec.answerBlob] })
    // The texts ride as bodies, never in the record a drain hands out.
    expect(JSON.stringify(rec)).not.toContain('venue')
    const r = await mac.drain.drainCompanionJournalNow()
    expect(r).toMatchObject({ replayed: 1 })
    const adopted = (await readStore()).entries.filter((e) => e.turnId === t1)
    expect(adopted.map((e) => [e.role, typeof e.content === 'string' ? e.content : e.content[0].text, e.adoptedFrom])).toEqual([
      ['user', 'what is left for acme?', 'cloud:s-lane-0001'], ['assistant', 'Two steps are left: the venue and the vendor.', 'cloud:s-lane-0001'],
    ])
    // The conversation the phone made on the companion is in the Mac's list now.
    const index = JSON.parse(await fsp.readFile(constantsBase.conversationIndexFile('general') as string, 'utf8'))
    expect(index.conversations.find((c: { id: string }) => c.id === conv)).toMatchObject({ title: 'what is left for acme?' })
    expect(companion.journal.companionJournalRecords()).toEqual([])
    await expect(fsp.stat(path.join(HOME, 'cache', 'journal', 'blobs', String(rec.answerBlob)))).rejects.toThrow()

    // The same turn handed over by the outbox first, then its record: once.
    const t2 = crypto.randomUUID()
    const { answerText, answeredAt, ...base } = turn(t2)
    expect(await mac.chatOutbox.handlePrimaryChatAdopt({ v: 1, ...base, answerText, answeredAt })).toMatchObject({ adopted: true })
    expect(companion.journal.journalChatTurn(turn(t2))).toMatchObject({ ok: true })
    expect(await mac.drain.drainCompanionJournalNow()).toMatchObject({ replayed: 0, skipped: 1 })
    expect((await readStore()).entries.filter((e) => e.turnId === t2)).toHaveLength(2)

    // An answer the companion lost: the words land, with the turn as failed.
    const t3 = crypto.randomUUID()
    expect(companion.journal.journalChatTurn(turn(t3, { userText: 'and the budget?', answerText: 'The budget is fine.' }))).toMatchObject({ ok: true })
    const lost = companion.journal.companionJournalRecords().find((x) => x.turnId === t3)!
    await fsp.rm(path.join(HOME, 'cache', 'journal', 'blobs', String(lost.answerBlob)))
    expect(await mac.drain.drainCompanionJournalNow()).toMatchObject({ replayed: 1 })
    const failed = (await readStore()).entries.filter((e) => e.turnId === t3)
    expect(failed.map((e) => [e.role, e.source ?? null])).toEqual([['user', null], ['assistant', 'agent-error']])
    expect(failed[1].content[0].text).toContain('its answer was lost')
    expect(companion.journal.companionJournalRecords()).toEqual([])

    // Words the companion lost: nothing lands, the turn is in the letter.
    const t4 = crypto.randomUUID()
    expect(companion.journal.journalChatTurn(turn(t4, { userText: 'and the venue deposit?', answerText: 'Paid.' }))).toMatchObject({ ok: true })
    const wordless = companion.journal.companionJournalRecords().find((x) => x.turnId === t4)!
    await fsp.rm(path.join(HOME, 'cache', 'journal', 'blobs', String(wordless.userBlob)))
    await mac.drain.drainCompanionJournalNow()
    expect((await readStore()).entries.filter((e) => e.turnId === t4)).toEqual([])
    const logs = fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json')).map((n) => mac.conflicts.readConflictLog(n.slice(0, -5))).filter(Boolean)
    expect(logs.flatMap((l) => l!.entries).find((e) => e.opId === wordless.opId)).toMatchObject({ kind: 'refused', recordKind: 'chat-turn' })
    expect(companion.journal.companionJournalRecords()).toEqual([])
  })

  it('a memory save from the companion lands; a Mac edit elsewhere merges; the same line is lettered with both versions', async () => {
    const file = constantsBase.MEMORY_FILE as string
    const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
    const save = (base: string | null, ours: string) => companion.journal.journalMemory({
      doc: 'global', baseHash: base === null ? null : sha12(base), base: base === null ? null : Buffer.from(base), ours: Buffer.from(ours), oursHash: sha12(ours),
    })
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const base = '# Memory\n\n- first rule\n\n- second rule\n\n- third rule\n'
    await fsp.writeFile(file, base)
    // A plain save over the doc as the Mac has it, then a second one on top of it.
    const one = base.replace('third rule', 'third rule, from the phone')
    expect(save(base, one)).toMatchObject({ ok: true })
    const two = `${one}\n- fourth rule\n`
    expect(save(one, two)).toMatchObject({ ok: true })
    // The Mac changes the first line meanwhile: both changes stay.
    await fsp.writeFile(file, base.replace('first rule', 'first rule, from the Mac'))
    await mac.drain.drainCompanionJournalNow()
    const merged = await fsp.readFile(file, 'utf8')
    expect(merged).toContain('first rule, from the Mac')
    expect(merged).toContain('third rule, from the phone')
    expect(merged).toContain('fourth rule')
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // The same line on both sides: the newer side is the doc, the other is in the letter in full.
    const conflictsBefore = fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json')).length : 0
    const ours = merged.replace('second rule', 'second rule, from the phone')
    expect(save(merged, ours)).toMatchObject({ ok: true })
    const macText = merged.replace('second rule', 'second rule, from the Mac')
    await fsp.writeFile(file, macText)
    const old = new Date(Date.now() - 3_600_000)
    await fsp.utimes(file, old, old)
    await mac.drain.drainCompanionJournalNow()
    expect(await fsp.readFile(file, 'utf8')).toContain('second rule, from the phone')
    const logs = fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json'))
    expect(logs.length).toBe(conflictsBefore + 1)
    const log = logs.map((n) => mac.conflicts.readConflictLog(n.slice(0, -5))).find((l) => l?.entries.some((e) => e.kind === 'memory'))
    expect(log?.entries.find((e) => e.kind === 'memory')).toMatchObject({ field: 'MEMORY.md', kept: 'replica', mac: macText, replica: ours })
    expect(mac.letter.buildConflictLetter(log!)?.markdown).toContain('- MEMORY.md: both sides changed the same lines')
    expect(companion.journal.companionJournalRecords()).toEqual([])
  })

  it('a note moved on the companion is moved where the note is now; a Mac move or a taken path stays and is lettered', async () => {
    const notesDir = constantsBase.NOTES_DIR as string
    const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
    const at = (rel: string) => fsp.readFile(path.join(notesDir, rel), 'utf8').catch(() => null)
    const note = async (rel: string, id: string, title: string) => {
      const text = `---\nid: ${id}\n---\n# ${title}\n\nSome text.\n`
      await fsp.mkdir(path.dirname(path.join(notesDir, rel)), { recursive: true })
      await fsp.writeFile(path.join(notesDir, rel), text)
      await mac.indexer.reconcileNoteNow(rel)
      return text
    }
    mac.notesIndex.getNotesIndexDb()
    const logsBefore = new Set(fs.existsSync(mac.conflicts.conflictDir()) ? fs.readdirSync(mac.conflicts.conflictDir()) : [])
    // A plain move: by its id, to a new folder; its id stays with it.
    const moving = await note('Acme/move-me.md', 'n_movemove001', 'Move me')
    expect(companion.journal.journalNoteMove({ from: 'Acme/move-me.md', to: 'Acme/Moved/me.md', noteId: 'n_movemove001' })).toMatchObject({ ok: true })
    await mac.drain.drainCompanionJournalNow()
    expect(await at('Acme/Moved/me.md')).toBe(moving)
    expect(await at('Acme/move-me.md')).toBeNull()
    expect(mac.notesIndex.getNotePathById('n_movemove001')).toBe('Acme/Moved/me.md')
    expect(companion.journal.companionJournalRecords()).toEqual([])
    // The same move again (a redrain after a crash): nothing.
    expect(companion.journal.journalNoteMove({ from: 'Acme/move-me.md', to: 'Acme/Moved/me.md', noteId: 'n_movemove001' })).toMatchObject({ ok: true })
    // The Mac renamed one meanwhile: found by its id, the Mac's place stays.
    await note('Acme/renamed-here.md', 'n_movemove002', 'Renamed')
    await mac.notesRoute.moveNote('Acme/renamed-here.md', 'Acme/renamed-on-mac.md')
    expect(companion.journal.journalNoteMove({ from: 'Acme/renamed-here.md', to: 'Acme/renamed-away.md', noteId: 'n_movemove002' })).toMatchObject({ ok: true })
    // A move onto a path another note has on the Mac.
    await note('Acme/taken-from.md', 'n_movemove003', 'Taken from')
    await note('Acme/taken-to.md', 'n_movemove004', 'Taken to')
    expect(companion.journal.journalNoteMove({ from: 'Acme/taken-from.md', to: 'Acme/taken-to.md', noteId: 'n_movemove003' })).toMatchObject({ ok: true })
    // A move of a note the Mac deleted: quiet.
    expect(companion.journal.journalNoteMove({ from: 'Acme/deleted-on-mac.md', to: 'Acme/gone.md', noteId: 'n_movemove005' })).toMatchObject({ ok: true })
    // Made on the companion, moved there, then saved at its new path: in that order.
    const made = '# Kiosk\n\nA kiosk at the fair.\n'
    expect(companion.journal.journalNote({ path: 'Acme/kiosk.md', mode: 'create', baseHash: null, base: null, ours: Buffer.from(made), oursHash: sha12(made) })).toMatchObject({ ok: true })
    expect(companion.journal.journalNoteMove({ from: 'Acme/kiosk.md', to: 'Acme/Fair/kiosk.md' })).toMatchObject({ ok: true })
    const saved = `${made}\nTwo of them.\n`
    expect(companion.journal.journalNote({ path: 'Acme/Fair/kiosk.md', mode: 'put', baseHash: sha12(made), base: Buffer.from(made), ours: Buffer.from(saved), oursHash: sha12(saved) }, { coalesce: false })).toMatchObject({ ok: true })
    await mac.drain.drainCompanionJournalNow()
    expect(companion.journal.companionJournalRecords()).toEqual([])
    expect(await at('Acme/Moved/me.md')).toBe(moving)
    expect(await at('Acme/renamed-on-mac.md')).toContain('# Renamed')
    expect(await at('Acme/renamed-away.md')).toBeNull()
    expect(await at('Acme/taken-from.md')).toContain('# Taken from')
    expect(await at('Acme/taken-to.md')).toContain('# Taken to')
    expect(await at('Acme/gone.md')).toBeNull()
    expect(await at('Acme/kiosk.md')).toBeNull()
    expect(await at('Acme/Fair/kiosk.md')).toContain('Two of them.')
    // Lettered: the two moves that were not made, nothing else.
    const logs = fs.readdirSync(mac.conflicts.conflictDir()).filter((n) => n.endsWith('.json') && !logsBefore.has(n))
    const entries = logs.flatMap((n) => mac.conflicts.readConflictLog(n.slice(0, -5))?.entries ?? [])
    expect(entries.map((e) => `${e.recordKind}:${e.why}:${e.notePath}`).sort()).toEqual([
      'note-move:move-kept:Acme/renamed-on-mac.md', 'note-move:move-taken:Acme/taken-from.md',
    ])
    const log = logs.map((n) => mac.conflicts.readConflictLog(n.slice(0, -5))).find((l) => l?.entries.some((e) => e.recordKind === 'note-move'))
    expect(mac.letter.buildConflictLetter(log!)?.markdown).toContain('a move or rename made while away was not made: it was moved to Acme/renamed-away.md while away, and to Acme/renamed-on-mac.md on the Mac')
  })

  it('a drain with nothing waiting is quiet', async () => {
    expect(companion.journal.companionJournalRecords()).toEqual([])
    const r = await mac.drain.drainCompanionJournalNow()
    expect(r).not.toBeNull()
    expect(r).toMatchObject({ replayed: 0 })
  })
})
