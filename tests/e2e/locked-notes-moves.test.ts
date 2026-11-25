/**
 * A locked note moves, goes or is copied only as the person wants (docs/reference/locked-notes.md),
 * through every route that moves vault files: the notes routes (move, folder delete) and the Files
 * panel (rename, duplicate, delete, here and through this machine's own daemon alias). An agent
 * (a caller with `x-walnut-caller-sid`) never moves, renames or deletes a locked note; nobody copies
 * one; and the person never moves one onto a note Walnut writes itself, whose writers would replace
 * it. Plain notes move as before. Fake files only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-locked-notes-moves-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { notesRoot } from '../../src/core/notes/note-paths.js'
import { buildLockedNoteText } from '../../src/core/notes/locked-note.js'

let base = ''
const AGENT = { 'x-walnut-caller-sid': 'sess-agent-moves' }
const LOCKED = buildLockedNoteText({ id: 'n_lockmove', envelope: { key: 'k1', iv: 'AAAA', ct: 'BBBB' } })
const at = (...p: string[]) => path.join(notesRoot(), ...p)
const exists = (abs: string) => fsp.stat(abs).then(() => true, () => false)

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}

async function put(rel: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(at(rel)), { recursive: true })
  await fsp.writeFile(at(rel), text)
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
})

beforeEach(async () => {
  for (const d of ['Private', 'Moved', 'Elsewhere', 'Stuff', 'Walnut', 'projects', 'Open']) await fsp.rm(at(d), { recursive: true, force: true })
  await put('Private/Diary.md', LOCKED)
  await put('Open/plain.md', '# plain\n')
})

describe('the notes routes', () => {
  it('refuse an agent\'s move or rename of a locked note, through either move route', async () => {
    for (const route of ['/api/notes-v2/move', '/api/v1/notes/move']) {
      const r = await post(route, { from: 'Private/Diary', to: 'Elsewhere/Diary' }, AGENT)
      expect(r.status, route).toBe(423)
      expect(JSON.stringify(r.body)).toContain('locked')
    }
    expect(await fsp.readFile(at('Private/Diary.md'), 'utf8')).toBe(LOCKED)
    expect(await exists(at('Elsewhere/Diary.md'))).toBe(false)
  })

  it('let the person move it, but never onto a memory folder or Inbox Triage\'s notes', async () => {
    for (const to of ['projects/acme/memory/t1/Diary', 'Walnut/Triage/State']) {
      const r = await post('/api/notes-v2/move', { from: 'Private/Diary', to })
      expect(r.status, to).toBe(400)
      expect(r.body.code, to).toBe('not_lockable')
    }
    const ok = await post('/api/notes-v2/move', { from: 'Private/Diary', to: 'Elsewhere/Diary' })
    expect(ok.status).toBe(200)
    expect(await fsp.readFile(at('Elsewhere/Diary.md'), 'utf8')).toBe(LOCKED)
  })

  it('still move an agent\'s plain note as before', async () => {
    const r = await post('/api/notes-v2/move', { from: 'Open/plain', to: 'Moved/plain' }, AGENT)
    expect(r.status).toBe(200)
    expect(await exists(at('Moved/plain.md'))).toBe(true)
  })

  it('refuse an agent\'s delete of a folder holding a locked note', async () => {
    const res = await fetch(`${base}/api/notes-v2/folder/Private`, { method: 'DELETE', headers: AGENT })
    expect(res.status).toBe(423)
    expect(await exists(at('Private/Diary.md'))).toBe(true)
  })
})

describe('the Files panel', () => {
  it('refuses an agent\'s delete, rename or move of a locked note or a folder holding one, here or through this machine\'s daemon', async () => {
    for (const [op, body] of [
      ['delete', { path: at('Private/Diary.md') }],
      ['delete', { path: at('Private'), recursive: true }],
      ['delete', { path: at('Private/Diary.md'), host: '__local__' }],
      ['rename', { path: at('Private/Diary.md'), newPath: at('Private/Renamed.md') }],
      ['rename', { path: at('Private'), newPath: at('Moved') }],
    ] as const) {
      const r = await post(`/api/files/${op}`, body, AGENT)
      expect(r.status, `${op} ${JSON.stringify(body)}`).toBe(423)
      expect(r.body.code).toBe('note_locked')
    }
    expect(await fsp.readFile(at('Private/Diary.md'), 'utf8')).toBe(LOCKED)
  })

  it('refuses a copy of a locked note or of its folder, the person\'s too', async () => {
    for (const [from, to] of [[at('Private/Diary.md'), at('Private/Diary copy.md')], [at('Private'), at('Private copy')]]) {
      const r = await post('/api/files/duplicate', { path: from, newPath: to })
      expect(r.status, from).toBe(423)
      expect(r.body.code).toBe('note_locked')
      expect(await exists(to)).toBe(false)
    }
  })

  it('lets the person rename or delete it, but not move it onto a note Walnut writes itself', async () => {
    await put('Stuff/State.md', LOCKED)
    await fsp.mkdir(at('Walnut'), { recursive: true })
    const intoTriage = await post('/api/files/rename', { path: at('Stuff'), newPath: at('Walnut/Triage') })
    expect(intoTriage.status).toBe(400)
    expect(intoTriage.body.code).toBe('not_lockable')
    expect(await exists(at('Stuff/State.md'))).toBe(true)

    const renamed = await post('/api/files/rename', { path: at('Private/Diary.md'), newPath: at('Private/Journal.md') })
    expect(renamed.status).toBe(200)
    expect(await fsp.readFile(at('Private/Journal.md'), 'utf8')).toBe(LOCKED)
    const gone = await post('/api/files/delete', { path: at('Private/Journal.md') })
    expect(gone.status).toBe(200)
    expect(await exists(at('Private/Journal.md'))).toBe(false)
  })

  it('still lets an agent rename, copy and delete plain files in the vault', async () => {
    expect((await post('/api/files/duplicate', { path: at('Open'), newPath: at('Open copy') }, AGENT)).status).toBe(200)
    expect((await post('/api/files/rename', { path: at('Open/plain.md'), newPath: at('Open/renamed.md') }, AGENT)).status).toBe(200)
    expect((await post('/api/files/delete', { path: at('Open copy'), recursive: true }, AGENT)).status).toBe(200)
  })
})
