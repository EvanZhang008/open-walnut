/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md, the Mac's side of the chat
 * list: a chat made, renamed, pinned or deleted on the companion is a `conversation-edit`
 * record in its journal (core/companion-journal.ts journalConversationEdit), drained by
 * the Mac's handover over the real door (web/routes/bridge-journal.ts, machine credential)
 * and applied with the Mac's own conversation calls (offline-merge/apply-conversation-edit.ts).
 *
 * Pinned:
 *   - a chat made on the companion is listed on the Mac under the id the box minted, never
 *     made the active one; a create the Mac already lists (the chat relay ensured it) is
 *     nothing, so a redrain never makes a second;
 *   - a rename made on the title the box showed lands, stamped with the box's moment, with
 *     no letter (also over an automatic title, or over a name a person gave on the Mac that
 *     the box showed); when a person renamed it on the Mac after the box's copy, the newer
 *     rename is kept and the other is in the letter, either way;
 *   - a pin lands; a pin already there is nothing;
 *   - a delete wins: the chat goes, and a later rename of it is nothing (no letter); the
 *     main chat is never deleted, and that refusal is lettered by the chat's title;
 *   - a malformed record is refused into the letter.
 *
 * CLOUD_MODE is read at import, so the companion and the Mac are two module graphs
 * (vi.resetModules + doMock) over one temp home. The companion side only writes records
 * here (its own list writers are pinned by companion-conversation-edits-cloud.test.ts):
 * both graphs share the home, so the box's list writers would write the Mac's list.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constantsBase = createMockConstants('walnut-drain-companion-conversations')

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
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
    conv: await import('../../../src/core/conversations.js'),
    drain: await import('../../../src/core/companion-journal-drain.js'),
    handover: await import('../../../src/core/offline-handover.js'),
    conflicts: await import('../../../src/core/offline-merge/conflict-log.js'),
    letter: await import('../../../src/core/offline-merge/letter.js'),
    ingest: await import('../../../src/core/cloud-ingest.js'),
    clock: await import('../../../src/core/offline-merge/host-clock.js'),
  }
}

const HOME = constantsBase.WALNUT_HOME as string
const token = crypto.randomBytes(16).toString('hex')
let companion: Awaited<ReturnType<typeof loadCompanion>>
let mac: Awaited<ReturnType<typeof loadMac>>
let server: Server

beforeAll(async () => {
  await fsp.rm(HOME, { recursive: true, force: true })
  await fsp.mkdir(HOME, { recursive: true })
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
  // One machine, one clock: a tight reading so the drain never shifts a record's time.
  mac.clock._setHostClockForTesting('companion', 0)
  // The Mac drains once with nothing waiting: the companion learns it takes chat changes.
  await mac.drain.drainCompanionJournalNow()
  expect(companion.journal.macDrains('conversation-edit')).toBe(true)
}, 60_000)

afterAll(async () => {
  mac?.handover._setHandoverBackoffForTesting(null)
  companion?.journal._resetCompanionJournalForTesting()
  await new Promise<void>((r) => server?.close(() => r()))
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {})
})

const edit = (input: Parameters<typeof companion.journal.journalConversationEdit>[0]) => {
  const r = companion.journal.journalConversationEdit(input)
  expect(r).toMatchObject({ ok: true })
  return r as { opId: string; seq: number }
}
const row = async (id: string) => (await mac.conv.listConversations('general')).find((c) => c.id === id)
const boxId = () => `conv-${crypto.randomUUID()}`
const drain = async () => {
  await mac.drain.drainCompanionJournalNow()
  expect(companion.journal.companionJournalRecords()).toEqual([])
}
/** The conflict log entries of the companion's drains, with their logs. */
function entriesOf(opId: string) {
  const dir = mac.conflicts.conflictDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => mac.conflicts.readConflictLog(n.slice(0, -5)))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .flatMap((l) => l.entries.map((e) => ({ l, e }))).filter(({ e }) => e.opId === opId)
}

let main = ''

describe('the Mac takes the chat list changes made on the companion', () => {
  it('a chat made there is listed here under its id, not active; a second create is nothing', async () => {
    main = await mac.conv.getMainConversationId('general')
    const active = await mac.conv.getActiveConversationId('general')
    const id = boxId()
    edit({ agentId: 'general', conversationId: id, op: 'create', title: 'Acme launch' })
    await drain()
    expect(await row(id)).toMatchObject({ id, title: 'Acme launch', messageCount: 0 })
    expect((await row(id))?.isMain).toBeUndefined()
    expect(await mac.conv.getActiveConversationId('general')).toBe(active)
    // The chat relay made it already, or a redrain: nothing new.
    edit({ agentId: 'general', conversationId: id, op: 'create', title: 'Acme launch, again' })
    await drain()
    expect((await mac.conv.listConversations('general')).filter((c) => c.id === id)).toHaveLength(1)
    expect((await row(id))?.title).toBe('Acme launch')
  })

  it('a rename on the title the box showed lands with its moment; one over an automatic title too, unlettered', async () => {
    const c = await mac.conv.createConversation('general', 'Acme budget')
    const r = edit({ agentId: 'general', conversationId: c.id, op: 'rename', title: 'Acme budget, Q3', base: { title: 'Acme budget' } })
    const before = Date.now()
    await drain()
    expect((await row(c.id))?.title).toBe('Acme budget, Q3')
    expect(Date.parse((await row(c.id))!.titleSetAt!)).toBeLessThanOrEqual(before + 1_000)
    expect(entriesOf(r.opId)).toEqual([])
    // The Mac's auto-titler named it since (no person did): the box's rename wins, quietly.
    const d = await mac.conv.createConversation('general')
    await mac.conv.renameConversation('general', d.id, 'Vendor contract', { auto: true })
    const r2 = edit({ agentId: 'general', conversationId: d.id, op: 'rename', title: 'Acme vendor', base: { title: 'New Conversation' } })
    await drain()
    expect((await row(d.id))?.title).toBe('Acme vendor')
    expect(entriesOf(r2.opId)).toEqual([])
    // A person named it on the Mac, and the box showed that name: no conflict either.
    const e = await mac.conv.createConversation('general', 'Acme legal')
    await mac.conv.renameConversation('general', e.id, 'Acme legal, Mac')
    const r3 = edit({ agentId: 'general', conversationId: e.id, op: 'rename', title: 'Acme legal, phone', base: { title: 'Acme legal, Mac' } })
    await drain()
    expect((await row(e.id))?.title).toBe('Acme legal, phone')
    expect(entriesOf(r3.opId)).toEqual([])
  })

  it('a person renamed it on the Mac after the box did: the Mac\'s name stays, the box\'s is in the letter', async () => {
    const c = await mac.conv.createConversation('general', 'Acme hiring')
    const r = edit({ agentId: 'general', conversationId: c.id, op: 'rename', title: 'Acme hiring, from the phone', base: { title: 'Acme hiring' } })
    await new Promise((res) => setTimeout(res, 50))
    await mac.conv.renameConversation('general', c.id, 'Acme hiring, from the Mac')
    await drain()
    expect((await row(c.id))?.title).toBe('Acme hiring, from the Mac')
    const [hit] = entriesOf(r.opId)
    expect(hit?.e).toMatchObject({ kind: 'conversation', recordKind: 'conversation-edit', kept: 'mac', mac: 'Acme hiring, from the Mac', replica: 'Acme hiring, from the phone' })
    const letter = mac.letter.buildConflictLetter(hit.l)!.markdown
    expect(letter).toContain('both sides renamed it; kept the Mac\'s name')
    expect(letter).toContain('your cloud companion')
  })

  it('a person renamed it on the Mac before the box did (its copy was behind): the box\'s name wins, lettered', async () => {
    const c = await mac.conv.createConversation('general', 'Acme travel')
    await mac.conv.renameConversation('general', c.id, 'Acme travel, Mac')
    await new Promise((res) => setTimeout(res, 50))
    const r = edit({ agentId: 'general', conversationId: c.id, op: 'rename', title: 'Acme travel, phone', base: { title: 'Acme travel' } })
    await drain()
    expect((await row(c.id))?.title).toBe('Acme travel, phone')
    expect(entriesOf(r.opId)[0]?.e).toMatchObject({ kind: 'conversation', kept: 'replica', mac: 'Acme travel, Mac' })
  })

  it('a pin lands; a pin already there is nothing', async () => {
    const c = await mac.conv.createConversation('general', 'Acme board')
    edit({ agentId: 'general', conversationId: c.id, op: 'pin', pinned: true, base: { pinned: false } })
    await drain()
    expect((await row(c.id))?.pinned).toBe(true)
    const r = edit({ agentId: 'general', conversationId: c.id, op: 'pin', pinned: true, base: { pinned: false } })
    await drain()
    expect((await row(c.id))?.pinned).toBe(true)
    expect(entriesOf(r.opId)).toEqual([])
  })

  it('a delete wins: the chat goes and a later rename of it is nothing; the main chat stays, lettered', async () => {
    const c = await mac.conv.createConversation('general', 'Acme archive')
    await mac.conv.renameConversation('general', c.id, 'Acme archive, renamed on the Mac')
    edit({ agentId: 'general', conversationId: c.id, op: 'delete' })
    const late = edit({ agentId: 'general', conversationId: c.id, op: 'rename', title: 'Acme archive, late', base: { title: 'Acme archive' } })
    await drain()
    expect(await row(c.id)).toBeUndefined()
    expect(entriesOf(late.opId)).toEqual([])
    const refused = edit({ agentId: 'general', conversationId: main, op: 'delete' })
    await drain()
    expect(await row(main)).toBeTruthy()
    const [hit] = entriesOf(refused.opId)
    expect(hit?.e).toMatchObject({ kind: 'refused', recordKind: 'conversation-edit' })
    expect(mac.letter.buildConflictLetter(hit.l)!.markdown).toContain('is the main chat on your Mac, which is never deleted')
  })

  it('a record that names no chat is refused into the letter', async () => {
    const r = edit({ agentId: 'general', conversationId: 'not-a-conv', op: 'rename', title: 'x' })
    await drain()
    expect(entriesOf(r.opId)[0]?.e).toMatchObject({ kind: 'refused', recordKind: 'conversation-edit' })
  })
})
