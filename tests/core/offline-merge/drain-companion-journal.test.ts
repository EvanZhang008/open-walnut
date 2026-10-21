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

  it('a drain with nothing waiting is quiet', async () => {
    expect(companion.journal.companionJournalRecords()).toEqual([])
    const r = await mac.drain.drainCompanionJournalNow()
    expect(r).not.toBeNull()
    expect(r).toMatchObject({ replayed: 0 })
  })
})
