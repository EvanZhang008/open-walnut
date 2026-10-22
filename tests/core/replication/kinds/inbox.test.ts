/**
 * The inbox copy kinds (docs/plan/walnut-replica-servers-impl.md, WP4): the
 * letter index on a host replica in the index's order (digest kind), letters
 * never removed past the half rule, and bodies by `{k, h}` only for a host
 * whose Settings choice turned them on (default: index only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-inbox', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { buildCopyManifest, manifestDigest, runCopyRound, syncCopyKinds, type CopyKind } from '../../../../src/core/replication/kinds/copy-kind.js'
import type { RowSetState } from '../../../../src/core/replication/kind-follower.js'
import { INBOX_BODIES_KIND, INBOX_KIND, leaderBodies, _resetInboxCopyForTesting, type LetterBodyRow } from '../../../../src/core/replication/kinds/inbox.js'
import { _resetReplicaStatusForTesting, forgetKindManifests } from '../../../../src/core/replication/replica-status.js'
import { mergeLetterItemFacts } from '../../../../src/core/human-inbox/item-merge.js'
import { normalizeItems } from '../../../../src/core/human-inbox/item-schema.js'
import type { InboxItemReceipt, InboxLetterItem, LetterRecord } from '../../../../src/core/human-inbox/types.js'

const T0 = '2026-10-15T08:00:00.000Z'
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let letters: LetterRecord[] = []
let bodyDir = ''
const index: CopyKind<LetterRecord> = { ...INBOX_KIND, rows: async () => letters.map((l) => ({ ...l })), watch: () => () => {} }
const bodies: CopyKind<LetterBodyRow> = { ...INBOX_BODIES_KIND, rows: () => leaderBodies(bodyDir), watch: () => () => {} }
const indexFile = () => path.join(WALNUT_HOME, 'human-inbox', 'index.json')
const copiedIds = async () => (JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as { letters: LetterRecord[] }).letters.map((l) => l.id)

function letter(i: number, over: Partial<LetterRecord> = {}): LetterRecord {
  return { id: `lt-${(1_700_000 + i).toString(36)}-a${String(i).padStart(4, '0')}`, type: 'report', title: `Weekly report ${i}`, createdAt: T0, read: false, bodyFile: `lt-${(1_700_000 + i).toString(36)}-a${String(i).padStart(4, '0')}.md`, bodyFormat: 'md', ...over } as unknown as LetterRecord
}

function itemLetter(revision: number): LetterRecord {
  const item = (id: string): InboxLetterItem => {
    const source = { kind: 'mail' as const, account: 'demo-account', message: `message-${id}` }
    const receipt: InboxItemReceipt = {
      actionId: `mark-${id}`, requestId: `request-${id}`, planId: `plan-${id}`, planVersion: 1,
      revision, updatedAt: T0, status: revision >= 9 ? 'success' : 'pending', intent: 'mark_read',
      source, input: {}, stage: revision >= 9 ? 'finished' : 'accepted', recovery: [],
    }
    return { id, subject: `Message ${id}`, summary: 'A message to review', source,
      actions: [{ id: receipt.actionId, kind: 'op', intent: 'mark_read' }], receipts: [receipt] }
  }
  return {
    id: 'lt-maildemo-0001', subject: 'Mail review', type: 'review', bodyFormat: 'markdown',
    textPreview: 'Two messages to review', sender: { sessionId: 'external', host: 'local' },
    createdAt: Date.parse(T0), read: false, pinned: false, archived: false,
    items: [item('envelope-item')],
    thread: [{ from: 'agent', text: 'Another message', at: Date.parse(T0), items: [item('thread-item')] }],
  }
}

/** One round as syncCopyKinds runs it (the bodies it could not read in `keep`). */
async function round<R>(kind: CopyKind<R>) {
  return runCopyRound(kind, await buildCopyManifest(kind), h.target, { asOf: Date.now() })
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(bodyDir, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  _resetInboxCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  if (bodyDir) await fsp.rm(bodyDir, { recursive: true, force: true })
  bodyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-leader-bodies-'))
  h.calls.length = 0
  letters = Array.from({ length: 6 }, (_, i) => letter(i))
  for (const l of letters) await fsp.writeFile(path.join(bodyDir, l.bodyFile as string), `# Report\nBody of ${l.id}\n`)
})

describe('the inbox index copy', () => {
  it('keeps the index order, and a digest ends an unchanged round', async () => {
    expect(await round(index)).toMatchObject({ action: 'synced', entries: 6 })
    expect(await copiedIds()).toEqual(letters.map((l) => l.id))
    letters = [letters[5], ...letters.slice(0, 5)] // a newer letter moved to the top
    expect(await round(index)).toMatchObject({ action: 'synced' })
    expect(await copiedIds()).toEqual(letters.map((l) => l.id))
    forgetKindManifests(['inbox'])
    const from = h.calls.length
    expect((await round(index)).action).toBe('unchanged')
    expect(stepsSince(h.calls, from)).toEqual(['status:inbox'])
  })

  it('keeps newer local receipts without changing the leader row hash or requesting it again', async () => {
    const local = itemLetter(9)
    const incoming = itemLetter(3)
    const localBefore = structuredClone(local)
    const incomingBefore = structuredClone(incoming)
    // Exercise the real receipt schema, not a receipt silently discarded by normalization.
    for (const row of [local, incoming]) {
      expect(normalizeItems(row.items)).toEqual(row.items)
      expect(normalizeItems(row.thread[0].items)).toEqual(row.thread[0].items)
    }
    await fsp.mkdir(path.dirname(indexFile()), { recursive: true })
    await fsp.writeFile(indexFile(), JSON.stringify({ version: 1, copiedAt: T0, letters: [local] }))
    letters = [incoming]
    const manifest = await buildCopyManifest(index)
    const leaderHash = INBOX_KIND.hash(incoming)
    const digest = manifestDigest(manifest, index.ordered)
    expect(manifest.entries).toEqual([{ k: incoming.id, h: leaderHash }])

    expect(await runCopyRound(index, manifest, h.target, { asOf: Date.now() })).toMatchObject({ action: 'synced', sent: 1, held: 0 })
    expect(stepsSince(h.calls)).toEqual(['status:inbox', 'sync:inbox', 'put:inbox:1'])
    const stored = (JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as { letters: LetterRecord[] }).letters[0]
    expect(stored.items?.[0].receipts).toEqual(local.items?.[0].receipts)
    expect(stored.thread[0].items?.[0].receipts).toEqual(local.thread[0].items?.[0].receipts)
    expect(INBOX_KIND.hash(stored)).not.toBe(leaderHash)
    const state = JSON.parse(await fsp.readFile(path.join(WALNUT_HOME, 'cache', 'replica', 'inbox.json'), 'utf8')) as RowSetState & { v: number }
    expect(state).toMatchObject({ v: 1, order: [incoming.id], hashes: { [incoming.id]: leaderHash } })
    const status = await h.target.post({ op: 'status', kind: index.kind, schemaVersion: index.schemaVersion, digest })
    expect(status).toMatchObject({ ok: true, reply: { ok: true, inSync: true, digest } })

    for (let i = 0; i < 2; i++) {
      // Forget the leader's shortcut so each sweep actually asks the follower's digest.
      forgetKindManifests(['inbox'])
      const from = h.calls.length
      expect(await round(index)).toMatchObject({ action: 'unchanged' })
      expect(stepsSince(h.calls, from)).toEqual(['status:inbox'])
    }
    expect(incoming).toEqual(incomingBefore)
    expect(local).toEqual(localBefore)
  })

  it('a letter read on the Mac goes as one put with the digest; the order stays', async () => {
    await round(index)
    letters[2] = { ...letters[2], read: true } as LetterRecord
    const from = h.calls.length
    expect(await round(index)).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['put:inbox:1+digest'])
    expect(await copiedIds()).toEqual(letters.map((l) => l.id))
    expect(fs.statSync(indexFile()).mode & 0o777).toBe(0o600)
  })

  it('never stamps the Mac\'s index clock with its own (lastUpdated is the Mac\'s, replica-state.ts reads it so)', async () => {
    await round(index)
    const file = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, unknown>
    expect(file).not.toHaveProperty('lastUpdated')
    expect(typeof file.copiedAt).toBe('string')
    const { readLetterIndexForReplica } = await import('../../../../src/core/human-inbox/store.js')
    expect((await readLetterIndexForReplica()).map((l) => l.id)).toEqual(letters.map((l) => l.id))
  })

  it('never removes most letters past the floor of 50', async () => {
    letters = Array.from({ length: 80 }, (_, i) => letter(i))
    await round(index)
    letters = letters.slice(0, 20)
    await expect(round(index)).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await copiedIds()).length).toBe(80)
  })

  it('an index the Mac fails to read is not an empty inbox: the round skips the kind and sends nothing', async () => {
    const { readLetterIndexForReplica } = await import('../../../../src/core/human-inbox/store.js')
    const real: CopyKind<LetterRecord> = { ...INBOX_KIND, watch: () => () => {} }
    // No index yet: no letters.
    expect(await real.rows()).toEqual([])
    // A file that does not open (a link to itself: ELOOP, as root too), standing in for EACCES or EMFILE.
    await fsp.mkdir(path.dirname(indexFile()), { recursive: true })
    await fsp.symlink('index.json', indexFile())
    await expect(real.rows()).rejects.toThrow(/ELOOP/)
    // The replica's own reads of its copy keep their fallback.
    expect(await readLetterIndexForReplica()).toEqual([])
    expect(await syncCopyKinds([real], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
  })
})

describe('letter item fact merge', () => {
  it.each([3, 9, 12])('merges revision %i into new envelope and thread items without changing either input', (revision) => {
    const previous = itemLetter(9)
    const incoming = itemLetter(revision)
    const previousBefore = structuredClone(previous)
    const incomingBefore = structuredClone(incoming)
    const merged = mergeLetterItemFacts(previous, incoming)
    const expected = revision > 9 ? incoming : previous
    expect(merged).not.toBe(incoming)
    expect(merged.items).not.toBe(incoming.items)
    expect(merged.items?.[0]).not.toBe(incoming.items?.[0])
    expect(merged.items?.[0].receipts).toEqual(expected.items?.[0].receipts)
    expect(merged.thread).not.toBe(incoming.thread)
    expect(merged.thread[0]).not.toBe(incoming.thread[0])
    expect(merged.thread[0].items?.[0]).not.toBe(incoming.thread[0].items?.[0])
    expect(merged.thread[0].items?.[0].receipts).toEqual(expected.thread[0].items?.[0].receipts)
    expect(previous).toEqual(previousBefore)
    expect(incoming).toEqual(incomingBefore)
  })

  it.each(['account', 'message', 'id'] as const)('does not carry receipts into an item with a changed %s', (field) => {
    const previous = itemLetter(9)
    const incoming = itemLetter(3)
    for (const item of [incoming.items![0], incoming.thread[0].items![0]]) {
      if (field === 'id') item.id = `other-${item.id}`
      else item.source = { ...item.source, [field]: `other-${item.source[field]}` }
      item.receipts = item.receipts?.map(receipt => ({ ...receipt, source: item.source }))
    }
    const previousBefore = structuredClone(previous)
    const incomingBefore = structuredClone(incoming)
    const merged = mergeLetterItemFacts(previous, incoming)
    expect(merged).toEqual(incomingBefore)
    expect(merged.items?.[0]).toBe(incoming.items?.[0])
    expect(merged.thread[0].items?.[0]).toBe(incoming.thread[0].items?.[0])
    expect(previous).toEqual(previousBefore)
    expect(incoming).toEqual(incomingBefore)
  })

  it('keeps a first copy unchanged and preserves local receipts missing from a later copy', () => {
    const previous = itemLetter(9)
    const incoming = itemLetter(3)
    delete incoming.items![0].receipts
    delete incoming.thread[0].items![0].receipts
    const incomingBefore = structuredClone(incoming)
    expect(mergeLetterItemFacts(undefined, incoming)).toBe(incoming)
    const merged = mergeLetterItemFacts(previous, incoming)
    expect(merged.items?.[0].receipts).toEqual(previous.items?.[0].receipts)
    expect(merged.thread[0].items?.[0].receipts).toEqual(previous.thread[0].items?.[0].receipts)
    expect(incoming).toEqual(incomingBefore)
  })
})

describe('letter bodies', () => {
  it('are not copied to a host that turned them off', async () => {
    const off = await startCopyHarness({ id: 'host:no-bodies', copies: async () => ({ inbox_bodies: false }) })
    try {
      const results = await syncCopyKinds([index, bodies], { targets: () => [off.target] })
      expect(results.map((r) => [r.kind, r.action, r.error ?? null])).toEqual([['inbox', 'synced', null], ['inbox-bodies', 'unsupported', 'kind_not_copied']])
      expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox', 'bodies'))).toBe(false)
    } finally { await off.close() }
  })

  it('go by {k, h} by default, as to every replica: a body the replica holds is never sent again', async () => {
    const chosen = await startCopyHarness({ id: 'host:bodies' })
    try {
      const results = await syncCopyKinds([index, bodies], { targets: () => [chosen.target] })
      expect(results.map((r) => [r.kind, r.action, r.sent])).toEqual([['inbox', 'synced', 6], ['inbox-bodies', 'synced', 6]])
      const name = letters[0].bodyFile as string
      const copied = path.join(WALNUT_HOME, 'human-inbox', 'bodies', name)
      expect(await fsp.readFile(copied, 'utf8')).toBe(`# Report\nBody of ${letters[0].id}\n`)
      expect(fs.statSync(copied).mode & 0o777).toBe(0o600)
      forgetKindManifests(['inbox-bodies'])
      const from = chosen.calls.length
      await syncCopyKinds([bodies], { targets: () => [chosen.target] })
      expect(stepsSince(chosen.calls, from)).toEqual(['sync:inbox-bodies'])
    } finally { await chosen.close() }
  })

  it('a body copy is replaced whole: a temp file and a rename at 0600, never written in place', async () => {
    expect(await round(bodies)).toMatchObject({ action: 'synced', sent: 6 })
    const name = letters[0].bodyFile as string
    const copied = path.join(WALNUT_HOME, 'human-inbox', 'bodies', name)
    fs.chmodSync(copied, 0o644)
    const ino = fs.statSync(copied).ino
    await fsp.writeFile(path.join(bodyDir, name), '# Report\nBody, revised\n')
    expect(await round(bodies)).toMatchObject({ action: 'synced', sent: 1 })
    const st = fs.statSync(copied)
    expect([st.ino === ino, st.mode & 0o777]).toEqual([false, 0o600])
    expect(await fsp.readFile(copied, 'utf8')).toBe('# Report\nBody, revised\n')
    expect(fs.readdirSync(path.dirname(copied)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('a body the Mac lists but cannot read stays on the host; once the Mac deletes it, it goes', async () => {
    await round(bodies)
    const name = letters[1].bodyFile as string
    const leaderFile = path.join(bodyDir, name)
    const copied = path.join(WALNUT_HOME, 'human-inbox', 'bodies', name)
    await fsp.rm(leaderFile)
    await fsp.symlink(name, leaderFile) // ELOOP: stands in for EACCES or EMFILE, as root too
    const manifest = await buildCopyManifest(bodies)
    expect([manifest.entries.length, manifest.keep]).toEqual([5, [name]])
    expect(await round(bodies)).toMatchObject({ action: 'synced', removed: 0 })
    expect(fs.existsSync(copied)).toBe(true)
    await fsp.rm(leaderFile)
    expect(await round(bodies)).toMatchObject({ action: 'synced', removed: 1 })
    expect(fs.existsSync(copied)).toBe(false)
  })

  it('the Mac holds no body text between rounds: a manifest row has the hash, a put reads the file', async () => {
    const { sha12 } = await import('../../../../src/core/replication/kind.js')
    const rows = await leaderBodies(bodyDir)
    expect(rows.length).toBe(6)
    expect(rows.filter((r) => 'body' in r)).toEqual([])
    const first = rows.find((r) => r.name === letters[0].bodyFile)!
    expect(INBOX_BODIES_KIND.hash(first)).toBe(sha12(`# Report\nBody of ${letters[0].id}\n`))
    expect(await INBOX_BODIES_KIND.loadRow!(first)).toEqual({ name: first.name, body: `# Report\nBody of ${letters[0].id}\n` })
    // A row sent without its text is refused whole, never stored as an empty body.
    const raw = await h.target.post({ op: 'put', kind: 'inbox-bodies', schemaVersion: 1, rows: [first], last: true })
    expect(raw).toMatchObject({ ok: false, status: 400, error: 'bad_rows' })
    expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox', 'bodies', first.name))).toBe(false)
    // Changed on the Mac after the manifest: the put sends the text as it is now.
    await fsp.writeFile(path.join(bodyDir, first.name), 'Edited body')
    expect(await INBOX_BODIES_KIND.loadRow!(first)).toEqual({ name: first.name, body: 'Edited body' })
  })

  it('a body not kept here needs the Mac while away (503 needs_leader); a kept one is served from the copy', async () => {
    const { serveLetterBody } = await import('../../../../src/web/routes/human-inbox-body.js')
    const app = express()
    app.get('/body/:id', (req, res, next) => { serveLetterBody(req, res, req.params.id).catch(next) })
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/body`
    try {
      const off = await startCopyHarness({ id: 'host:bodies-off', copies: async () => ({ inbox_bodies: false }) })
      try {
        await syncCopyKinds([index, bodies], { targets: () => [off.target] }) // bodies turned off: index only
      } finally { await off.close() }
      const away = await fetch(`${base}/${letters[0].id}`)
      expect(away.status).toBe(503)
      expect(away.headers.get('retry-after')).toBe('5')
      expect(await away.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied', retryAfter: 5 } })
      // A letter the index does not have is still a plain 404.
      expect((await fetch(`${base}/lt-zzzzzz-b0000`)).status).toBe(404)
      const chosen = await startCopyHarness({ id: 'host:bodies-served' }) // the default: bodies too
      try {
        await syncCopyKinds([index, bodies], { targets: () => [chosen.target] })
      } finally { await chosen.close() }
      const kept = await fetch(`${base}/${letters[0].id}`)
      expect(kept.status).toBe(200)
      expect(await kept.text()).toBe(`# Report\nBody of ${letters[0].id}\n`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('turned off on the Mac, the host drops what it kept and the body needs the Mac again; on again, it copies', async () => {
    const { serveLetterBody } = await import('../../../../src/web/routes/human-inbox-body.js')
    const app = express()
    app.get('/body/:id', (req, res, next) => { serveLetterBody(req, res, req.params.id).catch(next) })
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/body`
    let choice: Record<string, boolean> = { inbox_bodies: true }
    const host = await startCopyHarness({ id: 'host:purge', copies: async () => choice })
    const kept = () => fs.readdirSync(path.join(WALNUT_HOME, 'human-inbox', 'bodies'))
    const stateOf = (kind: string) => JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', `${kind}.json`), 'utf8')) as Record<string, unknown>
    try {
      await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(kept().length).toBe(6)
      expect((await fetch(`${base}/${letters[0].id}`)).status).toBe(200)

      choice = { inbox_bodies: false }
      let from = host.calls.length
      const off = await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:inbox-bodies'])
      expect(off.find((r) => r.kind === 'inbox-bodies')).toMatchObject({ action: 'unsupported', error: 'kind_not_copied', removed: 6 })
      expect(kept()).toEqual([])
      expect(stateOf('inbox-bodies')).toMatchObject({ v: 1, off: true })
      const away = await fetch(`${base}/${letters[0].id}`)
      expect(away.status).toBe(503)
      expect(await away.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied' } })
      from = host.calls.length
      await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual([]) // purged once

      choice = { inbox: false }
      from = host.calls.length
      await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:inbox'])
      expect(fs.existsSync(indexFile())).toBe(false)
      expect(stateOf('inbox')).toMatchObject({ v: 1, off: true })
      // No index here any more: every letter needs the Mac while away, none is a 404.
      expect((await fetch(`${base}/${letters[0].id}`)).status).toBe(503)

      // Back to the defaults: the index and its bodies, as every replica keeps them.
      choice = {}
      from = host.calls.length
      await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['sync:inbox', 'put:inbox:6', 'sync:inbox-bodies', 'put:inbox-bodies:6'])
      expect(await copiedIds()).toEqual(letters.map((l) => l.id))
      expect(stateOf('inbox').off).toBeUndefined()
      expect(kept().length).toBe(6)
    } finally {
      await host.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
