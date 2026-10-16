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
import { runCopyRound, syncCopyKinds, type CopyKind } from '../../../../src/core/replication/kinds/copy-kind.js'
import { INBOX_BODIES_KIND, INBOX_KIND, leaderBodies, _resetInboxCopyForTesting, type LetterBodyRow } from '../../../../src/core/replication/kinds/inbox.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests } from '../../../../src/core/replication/replica-status.js'
import type { LetterRecord } from '../../../../src/core/human-inbox/types.js'

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

async function round<R>(kind: CopyKind<R>) {
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
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
})

describe('letter bodies', () => {
  it('are not copied unless the host chose them (default off)', async () => {
    const results = await syncCopyKinds([index, bodies], { targets: () => [h.target] })
    expect(results.map((r) => [r.kind, r.action, r.error ?? null])).toEqual([['inbox', 'synced', null], ['inbox-bodies', 'unsupported', 'kind_not_copied']])
    expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox', 'bodies'))).toBe(false)
  })

  it('go by {k, h} when chosen: a body the replica holds is never sent again', async () => {
    const chosen = await startCopyHarness({ id: 'host:bodies', copies: async () => ({ inbox_bodies: true }) })
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
      await syncCopyKinds([index, bodies], { targets: () => [h.target] }) // the default: index only
      const away = await fetch(`${base}/${letters[0].id}`)
      expect(away.status).toBe(503)
      expect(away.headers.get('retry-after')).toBe('5')
      expect(await away.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied', retryAfter: 5 } })
      // A letter the index does not have is still a plain 404.
      expect((await fetch(`${base}/lt-zzzzzz-b0000`)).status).toBe(404)
      const chosen = await startCopyHarness({ id: 'host:bodies-served', copies: async () => ({ inbox_bodies: true }) })
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

      choice = {}
      from = host.calls.length
      await syncCopyKinds([index, bodies], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['sync:inbox', 'put:inbox:6'])
      expect(await copiedIds()).toEqual(letters.map((l) => l.id))
      expect(stateOf('inbox').off).toBeUndefined()
    } finally {
      await host.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
