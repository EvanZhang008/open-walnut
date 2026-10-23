/**
 * The global notes on a host replica (web/routes/notes.ts readGlobalNotes): read from the
 * daemon's notes copy, never this server's disk. A copy that cannot be read answers
 * `503 needs_leader {why:'copy_unreadable'}`, as every other notes read does
 * (replica/notes-routes.ts), never a 500.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-global-notes', { CLOUD_MODE: false }))

import { GLOBAL_NOTES_FILE, WALNUT_HOME } from '../../src/constants.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createCopyNotesSource, installReplicaNotesSource, notesCopyReaderOver } from '../../src/replica/notes-source.js'
import { notesRouter } from '../../src/web/routes/notes.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'

const HOME = '/fixture/marina-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let dir = ''

const app = express()
app.use(express.json())
app.use('/api/notes', notesRouter)
app.use(errorHandler)

function sourceOver(replica: ReturnType<typeof createHostReplica> | null) {
  const ask = async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!replica) throw new Error('daemon_needs_upgrade: this host\'s daemon has no replica-reads-v1')
    if (cmd === 'replica.list') return { ok: true, ...(replica.list(HOME, 'notes') ?? {}) }
    if (cmd === 'replica.read') { const r = replica.read(HOME, 'notes', params.key); return r ? { ok: true, ...r } : { ok: false, errorKind: 'not_found' } }
    return { ok: true, ...(replica.readMany(HOME, 'notes', params.keys, 4 * 1024 * 1024) ?? {}) }
  }
  return createCopyNotesSource(notesCopyReaderOver(ask), { listTtlMs: 0 })
}

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whgn-'))
  fs.mkdirSync(path.dirname(GLOBAL_NOTES_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_NOTES_FILE, '# DISK notes\n')
})
afterAll(() => {
  installReplicaNotesSource(null)
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

describe('GET /api/notes/global on a host replica', () => {
  it('reads the copy, never the disk', async () => {
    const replica = createHostReplica({ fs, path, dir: path.join(dir, 'a'), now: () => Date.now(), keyOf: sha12, hash: sha12, log: () => {} })
    const body = '# Copy notes\n'
    const { need } = replica.sync(HOME, 'notes', [{ k: 'global-notes.md', h: sha12(body), n: body.length }], Date.now())
    replica.put(HOME, 'notes', need.map((k) => ({ k, body })))
    installReplicaNotesSource(sourceOver(replica))
    const r = await request(app).get('/api/notes/global')
    expect([r.status, r.body.content]).toEqual([200, '# Copy notes\n'])
  })

  it('a copy that cannot be read: 503 copy_unreadable, never a 500', async () => {
    installReplicaNotesSource(sourceOver(null))
    const r = await request(app).get('/api/notes/global')
    expect([r.status, r.body.error?.code, r.body.error?.why]).toEqual([503, 'needs_leader', 'copy_unreadable'])
    expect(r.body.error.message).toMatch(/could not be read/)
  })

  it('notes turned off for this host: not_kept_here; never copied: kind_not_copied', async () => {
    const replica = createHostReplica({ fs, path, dir: path.join(dir, 'b'), now: () => Date.now(), keyOf: sha12, hash: sha12, log: () => {} })
    installReplicaNotesSource(sourceOver(replica))
    expect((await request(app).get('/api/notes/global')).body.error?.why).toBe('kind_not_copied')
    replica.drop(HOME, 'notes')
    expect((await request(app).get('/api/notes/global')).body.error?.why).toBe('not_kept_here')
  })
})
