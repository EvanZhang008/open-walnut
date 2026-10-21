/**
 * Stage 4a of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: the Mac's notes, memory and skills round (core/host-replica.ts
 * syncCompanionHostReplica, the round a host daemon gets) reaches the companion
 * over the real client (cloud-ingest.ts postToCloudHostReplica: machine token,
 * gzip) and the real door (web/routes/bridge-host-replica.ts), into the box's
 * copy store (core/companion-host-replica.ts, `cache/replica/host/`).
 *
 * Pinned:
 *   - the door: only the Mac's machine credential passes; a bad command is a 400;
 *   - a first round brings every note, MEMORY.md and USER.md, and the skills, with
 *     each note's title; the copy answers the reads a host answers from it
 *     (note_read, note_search, memory_read);
 *   - the box's own files are not touched by a round (the notes git sync wrote);
 *   - a note changed on the Mac goes again alone; a removed one leaves the copy;
 *     an unchanged round sends nothing;
 *   - the memo ends when the box says a kind never arrived whole (a new box);
 *   - an older companion without the door rests the lane for 10 minutes, and a
 *     changed build ends that rest.
 *
 * Both sides share one data dir: the "Mac's" notes are the files under NOTES_DIR,
 * which on the box are also what git sync wrote; the copy lives apart from them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-host-replica-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { MEMORY_FILE, NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, cloudHostReplicaAvailable, forgetCloudHostReplicaRest, postToCloudHostReplica } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, syncCompanionHostReplica, forgetCompanionHostReplica } from '../../../src/core/host-replica.js'
import {
  COMPANION_REPLICA_HOME, _resetCompanionHostReplicaForTesting, companionCopyHolds, companionHostReplica, companionHostReplicaDir,
} from '../../../src/core/companion-host-replica.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const HOME = COMPANION_REPLICA_HOME

async function door(body: unknown, token = T.local): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}/bridge/host-replica`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}

async function writeNote(rel: string, text: string): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const sentOf = (results: Array<{ kind: string; sent?: number; action: string }>, kind: string) => results.find((r) => r.kind === kind)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer.\n')
  await writeNote('journal/2026-10-21.md', '# Tuesday\n\nNotes from the standup: caf\u00e9 budget approved (non-ASCII text).\n')
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
  await fs.writeFile(MEMORY_FILE, '# Memory\n\n- Acme launch is on Friday\n')
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the door', () => {
  it('only the Mac\'s machine credential passes; a bad command is a 400', async () => {
    expect((await door({ cmd: 'replica.status' }, '')).status).toBe(401)
    expect((await door({ cmd: 'replica.status' }, tok())).status).toBe(401)
    expect((await door({ cmd: 'replica.status' }, T.phone)).status).toBe(403)
    expect((await door({ cmd: 'replica.nope' })).status).toBe(400)
    expect(await door({ cmd: 'replica.status' })).toMatchObject({ status: 200, body: { ok: true, kinds: { notes: { entries: 0, asOf: null } } } })
  })
})

describe('the Mac\'s rounds', () => {
  it('a first round brings every note with its title, the memory docs and the skills', async () => {
    expect(companionCopyHolds('notes')).toBe(false)
    const before = await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', entries: 3, sent: 3 })
    expect(sentOf(results, 'memory')).toMatchObject({ action: 'synced', sent: 1 }) // MEMORY.md (no USER.md here)
    expect(sentOf(results, 'skills')?.action).toBe('synced')
    expect(companionCopyHolds('notes')).toBe(true)
    const r = companionHostReplica()!
    const list = r.list(HOME, 'notes')!
    expect(list.entries.map((e) => e.k).sort()).toEqual(['Acme/launch-plan.md', 'Acme/vendors.md', 'journal/2026-10-21.md'])
    expect(list.entries.find((e) => e.k === 'Acme/launch-plan.md')?.m).toMatchObject({ title: 'Acme launch plan' })
    expect(r.read(HOME, 'notes', 'journal/2026-10-21.md')?.body).toContain('caf\u00e9 budget')
    // The reads a host answers from its copy.
    const read = r.answer(HOME, 'note_read', { path: 'Acme/vendors.md' }, 'test')
    expect(read).toMatchObject({ ok: true })
    const search = r.answer(HOME, 'note_search', { q: 'printer' }, 'test') as { ok: true; result: { results: Array<{ path: string }> } }
    expect(search.ok).toBe(true)
    expect(JSON.stringify(search.result)).toContain('Acme/vendors')
    const memory = r.answer(HOME, 'memory_read', { doc: 'global' }, 'test')
    expect(JSON.stringify(memory)).toContain('Acme launch is on Friday')
    // The copy is apart from the box's own files.
    expect(await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')).toBe(before)
    expect((await fs.stat(companionHostReplicaDir())).isDirectory()).toBe(true)
  })

  it('an unchanged round sends nothing; a changed note goes alone; a removed one leaves the copy', async () => {
    const quiet = await syncCompanionHostReplica()
    expect(quiet.every((r) => r.action === 'unchanged')).toBe(true)
    await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer, then the caterer.\n')
    await fs.rm(path.join(NOTES_DIR, 'journal/2026-10-21.md'))
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', entries: 2, sent: 1 })
    const r = companionHostReplica()!
    expect(r.read(HOME, 'notes', 'Acme/vendors.md')?.body).toContain('the caterer')
    expect(r.read(HOME, 'notes', 'journal/2026-10-21.md')).toBeNull()
  })

  it('a copy that never arrived whole (a new box) gets its rounds again, memo or not', async () => {
    await fs.rm(companionHostReplicaDir(), { recursive: true, force: true })
    _resetCompanionHostReplicaForTesting()
    expect(companionCopyHolds('notes')).toBe(false)
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', sent: 2 })
    expect(companionCopyHolds('notes')).toBe(true)
    expect(companionCopyHolds('memory')).toBe(true)
  })

  it('the copy is read back from disk by a new process', async () => {
    _resetCompanionHostReplicaForTesting()
    expect(companionHostReplica()!.read(HOME, 'notes', 'Acme/launch-plan.md')?.body).toContain('Ship the beta')
  })
})

describe('an older companion', () => {
  it('a box without the door rests the lane for 10 minutes; a changed build ends the rest', async () => {
    const realUrl = bridgeCfg.url
    // A server that answers every path with an app shell, as an old build's SPA fallback does.
    const http = await import('node:http')
    const old = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>app</title>') })
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', r))
    const oldPort = (old.address() as { port: number }).port
    try {
      _resetCloudIngestForTesting()
      bridgeCfg = { ...bridgeCfg, url: `ws://127.0.0.1:${oldPort}/bridge` }
      expect(await postToCloudHostReplica('replica.status', {})).toMatchObject({ ok: false, errorKind: 'unsupported' })
      expect(await cloudHostReplicaAvailable()).toBe(false)
      expect(await syncCompanionHostReplica()).toEqual([])
      // The companion updated (companion-build/mac.ts companionBuildChanged): asked again at once.
      bridgeCfg = { ...bridgeCfg, url: realUrl }
      _resetCloudIngestForTesting()
      forgetCloudHostReplicaRest()
      forgetCompanionHostReplica()
      expect(await cloudHostReplicaAvailable()).toBe(true)
      const results = await syncCompanionHostReplica()
      expect(results.map((r) => r.action)).not.toContain('failed')
    } finally {
      bridgeCfg = { ...bridgeCfg, url: realUrl }
      await new Promise<void>((r) => old.close(() => r()))
    }
  })
})
