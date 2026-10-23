/**
 * The `conversations` copy kind (docs/plan/walnut-replica-servers-impl.md, WP5): each
 * agent's conversation list (the Ask history list, conversations/<agent>/_index.json)
 * to a host replica, index only, one row per conversation. On the replica the list,
 * the active id and the main id read the copy and never write it; a list write
 * answers needs_leader. A list the Mac lost (an emptied, empty or missing index, a
 * missing dir) never removes the host's copy below the half rule. Real files, real
 * route, real follower, real conversations module.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-conversations', { CLOUD_MODE: false }))

import { CONVERSATIONS_DIR, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound, syncCopyKinds } from '../../../../src/core/replication/kinds/copy-kind.js'
import { CONVERSATIONS_KIND, WITHHELD_TITLE, agentSegmentOk, readConversationRows } from '../../../../src/core/replication/kinds/conversations.js'
import { _resetConversationsCopyForTesting } from '../../../../src/core/replication/kinds/conversations-follower.js'
import { buildCopyManifest } from '../../../../src/core/replication/kinds/copy-kind.js'
import { confirmKindRemoval } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests, peekKindState } from '../../../../src/core/replication/replica-status.js'
import * as conv from '../../../../src/core/conversations.js'
import type { ConversationMeta } from '../../../../src/core/types.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let macRoot = ''
const kind = { ...CONVERSATIONS_KIND, rows: () => readConversationRows(macRoot), watch: () => () => {} }

function meta(agent: string, i: number, over: Partial<ConversationMeta> = {}): ConversationMeta {
  const day = String(10 + i).padStart(2, '0')
  return {
    id: `conv-${agent}-${String(i).padStart(4, '0')}`, agentId: agent, title: `Ask ${i} about acme`, createdAt: `2026-09-${day}T08:00:00.000Z`,
    lastMessageAt: `2026-10-${day}T08:00:00.000Z`, messageCount: i, lastDistilledAt: null, lastDistilledMessageCount: 0, ...over,
  }
}

async function writeMacIndex(agent: string, list: ConversationMeta[], active: string | null = list[0]?.id ?? null): Promise<void> {
  await fsp.mkdir(path.join(macRoot, agent), { recursive: true })
  await fsp.writeFile(path.join(macRoot, agent, '_index.json'), JSON.stringify({ version: 1, activeConversationId: active, conversations: list }))
}

async function round() {
  return runCopyRound(kind, await buildCopyManifest(kind), h.target, { asOf: Date.now() })
}

function setReplica(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  else for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  setReplica(true)
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  setReplica(true)
  _resetConversationsCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  macRoot = path.join(WALNUT_HOME, 'mac-side', 'conversations')
  await fsp.mkdir(macRoot, { recursive: true })
  h.calls.length = 0
  await writeMacIndex('general', [meta('general', 1, { isMain: true }), meta('general', 2, { pinned: true }), meta('general', 3, { askTaskId: 'task-acme-3' })], meta('general', 3).id)
  await writeMacIndex('mentor', [meta('mentor', 1), meta('mentor', 2, { title: 'Ask \u4f60\u597d marina' })])
  // A body the Mac keeps: never copied.
  await fsp.writeFile(path.join(macRoot, 'general', `${meta('general', 1).id}.json`), JSON.stringify({ entries: [{ role: 'user', content: 'body-text-acme' }] }))
})

describe('a host replica keeps the conversation lists', () => {
  it('writes each index as the Mac sent it, at 0600 in 0700 dirs, and never a body', async () => {
    // One row per conversation: three of general, two of mentor.
    expect(await round()).toMatchObject({ action: 'synced', entries: 5, sent: 5 })
    expect(stepsSince(h.calls)).toEqual(['sync:conversations', 'put:conversations:5'])
    const file = path.join(CONVERSATIONS_DIR, 'general', '_index.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(path.join(CONVERSATIONS_DIR, 'general'))).toEqual(['_index.json'])
    const mentor = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, 'mentor', '_index.json'), 'utf8')) as { conversations: ConversationMeta[] }
    expect(mentor.conversations[1]!.title).toBe('Ask \u4f60\u597d marina')
    forgetKindManifests(['conversations'])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:conversations'])
  })

  it('the Ask list, the active id and the main id read the copy, and reading writes nothing', async () => {
    await round()
    const before = fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')
    const list = await conv.listConversations('general')
    expect(list.map((c) => c.id)).toEqual([meta('general', 1).id, meta('general', 2).id, meta('general', 3).id]) // main, pinned, then newest
    expect(list[2]!.askTaskId).toBe('task-acme-3')
    expect(await conv.getActiveConversationId('general')).toBe(meta('general', 3).id)
    expect(await conv.getMainConversationId('general')).toBe(meta('general', 1).id)
    // No main mark on the mentor list: the oldest one is main, and the copy is not back-filled.
    expect(await conv.getMainConversationId('mentor')).toBe(meta('mentor', 1).id)
    expect(fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')).toBe(before)
    expect(fs.readdirSync(path.join(CONVERSATIONS_DIR, 'mentor'))).toEqual(['_index.json'])
    // An agent with no copied list: an empty list, and the ids need the Mac (making one is a write).
    expect(await conv.listConversations('notes')).toEqual([])
    await expect(conv.getActiveConversationId('notes')).rejects.toMatchObject({ code: 'needs_leader' })
    expect(fs.existsSync(path.join(CONVERSATIONS_DIR, 'notes'))).toBe(false)
  })

  it('a list write on the replica answers needs_leader and leaves the copy as it was', async () => {
    await round()
    const before = fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')
    await expect(conv.renameConversation('general', meta('general', 2).id, 'Renamed')).rejects.toMatchObject({ code: 'needs_leader', why: 'conversation_writes_need_mac' })
    await expect(conv.setPinned('general', meta('general', 3).id, true)).rejects.toMatchObject({ code: 'needs_leader' })
    expect(fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')).toBe(before)
  })

  it('an index the Mac cannot read rides in keep: the host keeps its copy of it', async () => {
    await round()
    await fsp.writeFile(path.join(macRoot, 'mentor', '_index.json'), '{ not json')
    const m = await buildCopyManifest(kind)
    expect(m.keep).toEqual(['mentor'])
    await runCopyRound(kind, m, h.target, { asOf: Date.now() })
    expect((await conv.listConversations('mentor')).length).toBe(2)
  })

  it('a conversations dir the Mac cannot list skips the round', async () => {
    await round()
    await fsp.rm(macRoot, { recursive: true })
    await fsp.symlink('conversations', macRoot)
    await expect(kind.rows()).rejects.toThrow(/ELOOP/)
    h.calls.length = 0
    expect(await syncCopyKinds([kind], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
    expect((await conv.listConversations('general')).length).toBe(3)
  })

  it('a conversations dir missing on the Mac skips the round too (not "no chats")', async () => {
    await round()
    await fsp.rm(macRoot, { recursive: true })
    h.calls.length = 0
    expect(await syncCopyKinds([kind], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
    expect((await conv.listConversations('general')).length).toBe(3)
    expect((await conv.listConversations('mentor')).length).toBe(2)
  })

  it('an empty index, or one missing from its agent dir, rides in keep: the host keeps every conversation of that agent', async () => {
    await round()
    // A truncated write (zero bytes) reads as no list on the Mac: never as an empty one here.
    await fsp.writeFile(path.join(macRoot, 'general', '_index.json'), '')
    // The mentor dir is still there, its index is not (removed by hand, or not written back yet).
    await fsp.rm(path.join(macRoot, 'mentor', '_index.json'))
    const m = await buildCopyManifest(kind)
    expect(m.keep).toEqual(['general', 'mentor'])
    expect(m.entries).toEqual([])
    expect(await runCopyRound(kind, m, h.target, { asOf: Date.now() })).toMatchObject({ action: 'synced', removed: 0 })
    expect((await conv.listConversations('general')).map((c) => c.id)).toEqual([meta('general', 1).id, meta('general', 2).id, meta('general', 3).id])
    expect((await conv.listConversations('mentor')).length).toBe(2)
    expect(await conv.getActiveConversationId('general')).toBe(meta('general', 3).id)
  })

  it('agent dir names that walk out are never copied or written', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) expect([bad, agentSegmentOk(bad)]).toEqual([bad, false])
    expect(agentSegmentOk('general')).toBe(true)
  })

  it('on the leader the same reads use the Mac files as before', async () => {
    setReplica(false)
    await fsp.mkdir(CONVERSATIONS_DIR, { recursive: true })
    await fsp.cp(path.join(macRoot, 'general'), path.join(CONVERSATIONS_DIR, 'general'), { recursive: true })
    expect((await conv.listConversations('general')).length).toBe(3)
  })
})

describe('the half rule counts conversations', () => {
  it('an index the Mac emptied by accident is refused once the host holds 50; a few go; the user may confirm a real prune', async () => {
    const general = Array.from({ length: 40 }, (_, i) => meta('general', i + 1, i === 0 ? { isMain: true } : {}))
    const mentor = Array.from({ length: 20 }, (_, i) => meta('mentor', i + 1))
    await writeMacIndex('general', general)
    await writeMacIndex('mentor', mentor)
    expect(await round()).toMatchObject({ action: 'synced', entries: 60, sent: 60 })
    // A valid but empty list (a Mac that rewrote its index from nothing): 40 of the 60 would go.
    await writeMacIndex('general', [], null)
    for (let i = 0; i < 3; i++) await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await conv.listConversations('general')).length).toBe(40)
    expect((await conv.listConversations('mentor')).length).toBe(20)
    // The list comes back on the Mac and a few really go: those few go here.
    await writeMacIndex('general', general.slice(0, 37))
    expect(await round()).toMatchObject({ action: 'synced', removed: 3 })
    expect((await conv.listConversations('general')).length).toBe(37)
    // A real prune of most of them, confirmed by the user after three refused rounds.
    await writeMacIndex('general', general.slice(0, 2))
    await writeMacIndex('mentor', mentor.slice(0, 2))
    for (let i = 0; i < 3; i++) await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect(peekKindState(h.target.id, 'conversations')!.refusals).toBe(3)
    expect(confirmKindRemoval(h.target, 'conversations', { entries: 4 })).toBe(true)
    expect(await round()).toMatchObject({ action: 'synced', removed: 53 })
    expect((await conv.listConversations('general')).map((c) => c.id)).toEqual([general[0]!.id, general[1]!.id])
  })
})

describe('the host turned the conversations copy off', () => {
  it('drops the lists and keeps an off marker; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:conversations-off', copies: async () => choice })
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      choice = { conversations: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:conversations'])
      expect(fs.existsSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'))).toBe(false)
      // Turned off is not "no chats": kept only on the Mac (4f).
      await expect(conv.listConversations('general')).rejects.toMatchObject({ code: 'needs_leader', why: 'not_kept_here' })
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:conversations')
      expect((await conv.listConversations('general')).length).toBe(3)
    } finally { await host.close() }
  })
})

describe('a replica with no copy of the lists', () => {
  it('answers needs_leader kind_not_copied before the first round; after it, an agent with no list is an empty list', async () => {
    await expect(conv.listConversations('general')).rejects.toMatchObject({ code: 'needs_leader', why: 'kind_not_copied' })
    await writeMacIndex('general', [meta('general', 1)])
    await round()
    expect((await conv.listConversations('general')).map((c) => c.id)).toEqual(['conv-general-0001'])
    expect(await conv.listConversations('acme-agent')).toEqual([])
  })
})

describe('a title that looks like a secret never reaches a host', () => {
  const KEY = 'sk-acmePastedKey0123456789abcdefghij'

  it('the Mac withholds it (the conversation stays listed, untitled); the copy holds no trace of it', async () => {
    await writeMacIndex('general', [meta('general', 1), meta('general', 2, { title: `use ${KEY} for the build` }), meta('general', 3)])
    const rows = await kind.rows()
    const listed = rows.filter((r) => r.agent === 'general').map((r) => r.meta)
    expect(listed.map((c) => c.title)).toEqual(['Ask 1 about acme', WITHHELD_TITLE, 'Ask 3 about acme'])
    expect(await round()).toMatchObject({ action: 'synced' })
    const text = fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')
    expect(text).not.toContain('acmePastedKey')
    // Nor did any step that crossed the link (the host withholds it again, which would hide a leak from the file).
    expect(h.calls.length).toBeGreaterThan(0)
    for (const c of h.calls) expect([c.op, c.text.includes('acmePastedKey')]).toEqual([c.op, false])
    expect((await conv.listConversations('general')).map((c) => c.id)).toContain('conv-general-0002')
  })

  it('the host withholds one sent anyway (an older Mac)', async () => {
    const { followerStep } = await import('../../../../src/core/replication/kind-follower.js')
    const r = await followerStep({ op: 'put', kind: 'conversations', schemaVersion: 2, rows: [{ agent: 'general', meta: meta('general', 1, { title: `token ${KEY}` }) }], last: true })
    expect(r).toMatchObject({ ok: true })
    const text = fs.readFileSync(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')
    expect(text).not.toContain('acmePastedKey')
    expect(JSON.parse(text).conversations[0].title).toBe(WITHHELD_TITLE)
  })
})

describe('the leader starts a round when a conversation list changes', () => {
  it('every write of a list calls the kind watch (create, rename, pin, delete); after the stop it does not', async () => {
    // No bus event in here: the real routes tell only the browser sockets (broadcastEvent).
    setReplica(false)
    let n = 0
    const stop = CONVERSATIONS_KIND.watch(() => { n++ })
    try {
      const made = await conv.createConversation('marina-agent', 'Acme plans')
      expect(n).toBeGreaterThan(0)
      let seen = n
      await conv.renameConversation('marina-agent', made.id, 'Acme plans, renamed')
      expect(n).toBeGreaterThan(seen)
      seen = n
      await conv.setPinned('marina-agent', made.id, true)
      expect(n).toBeGreaterThan(seen)
      stop()
      seen = n
      await conv.deleteConversation('marina-agent', made.id)
      expect(n).toBe(seen)
    } finally {
      stop()
      setReplica(true)
    }
  })
})
