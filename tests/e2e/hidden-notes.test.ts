/**
 * Hidden notes end to end (docs/reference/locked-notes.md, "Hidden notes"): the person hides a note
 * with no password; its text stays plain on disk, the person's Notes page reads it whole, and every
 * other reader (an agent's reads, /api/v1/notes, note_read, the Files panel, search and the indexes)
 * gets its frontmatter and a stub; every agent write, delete, move and copy is refused and leaves
 * the file as it was; the person's editor keeps saving it; Lock seals it and Remove lock gives back
 * the hidden note; Unhide shows it to agents again. Fake data only; the notes are the test's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-hidden-notes-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { notesRoot } from '../../src/core/notes/note-paths.js'
import { HIDDEN_STUB_LEAD, noteProtection } from '../../src/core/notes/locked-note.js'
import { settleLockedNoteResidue } from '../../src/core/notes/locked-note-residue.js'
import { withTestRun } from '../../src/core/test-run.js'
import { isPersonInOwnWindow } from '../../src/web/routes/person-caller.js'
import { getOp } from '../../src/ops/index.js'
import type { OpCall } from '../../src/ops/core.js'

let base = ''
let session = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'a hidden notes master phrase'
const AGENT = { 'x-walnut-caller-sid': 'sess-hidden-agent' }
const AUTOMATION = { 'x-walnut-caller-kind': 'automation' }
const NOTE = 'journal/Quiet week.md'
// Words of the note's text: never in an answer to anyone but the person, never in an index after the hide.
const SECRET = ['wombatlanternhidden', 'pangolinfjordprivate', 'Walked by the river alone']
// Searched for (so the query string in the access log is this word, not one of the scanned ones).
const SEARCH_WORD = 'tapirsearchmarker'
const TEXT = [
  '---', 'tags: [journal]', '---',
  '# Quiet week',
  `Search marker: ${SEARCH_WORD}.`,
  `Monday: ${SECRET[2]}. The word is ${SECRET[0]}.`,
  `Tuesday: ${SECRET[1]}, caf\u00e9 and \u4f60\u597d.`,
  ...Array.from({ length: 120 }, (_, i) => `- entry line ${i} of an ordinary week`),
  '',
].join('\n')

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed, text }
}
const v1 = (method: string, p: string, body?: unknown, headers?: Record<string, string>) => http(method, `/api/v1${p}`, body, headers)
const abs = () => path.join(notesRoot(), NOTE)
const file = () => fsp.readFile(abs(), 'utf8')
const codeOf = (r: { body: Record<string, any> }): string | undefined => r.body.code ?? r.body.error?.code

/** An agent's op call, as its session makes it (the caller sid on every request). */
const agentCall: OpCall = async (method, p, body) => {
  const r = await v1(method, p, body, AGENT)
  if (r.status >= 400) throw new Error(`${r.status} ${codeOf(r) ?? ''} ${JSON.stringify(r.body)}`)
  return r.body
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Every search database file (and its WAL and journal), as bytes, holding any of `words` in the clear. */
function indexHits(words: string[]): string[] {
  const hits: string[] = []
  const walk = (d: string): string[] => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() && e.name.includes('.sqlite') ? [path.join(d, e.name)] : []))
  }
  for (const f of walk(WALNUT_HOME)) {
    let bytes: Buffer
    try { bytes = fs.readFileSync(f) } catch { continue }
    for (const w of words) {
      for (const needle of [Buffer.from(w, 'utf8'), Buffer.from(w.toLowerCase(), 'utf8'), Buffer.from(w, 'utf16le')]) {
        if (bytes.includes(needle)) { hits.push(`${path.relative(WALNUT_HOME, f)}: ${w}`); break }
      }
    }
  }
  return hits
}

function expectStub(content: unknown): void {
  expect(typeof content).toBe('string')
  for (const w of SECRET) expect(content as string).not.toContain(w)
  expect(content as string).toContain(HIDDEN_STUB_LEAD)
  expect(content as string).toContain('walnut_hidden: 1')
  expect(content as string).toContain('tags: [journal]')
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
})

describe('hidden notes', () => {
  let hash = ''

  it('a test run is not the person (the throwaway server ignores the header, so the rule is checked here)', () => {
    const req = { headers: {} } as unknown as Parameters<typeof isPersonInOwnWindow>[0]
    expect(isPersonInOwnWindow(req)).toBe(true)
    expect(withTestRun('t-hidden', () => isPersonInOwnWindow(req))).toBe(false)
  })

  it('starts as a plain note, indexed and found by search', async () => {
    expect((await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: TEXT })).status).toBe(200)
    const found = await waitFor(() => http('GET', `/api/notes-v2/search?q=${SEARCH_WORD}&mode=string`), (r) => r.text.includes('Quiet week'))
    expect(found.text).toContain('Quiet week')
    // The index scan is not blind: the plain note's words are in the index now.
    expect(indexHits([SECRET[0]]).length).toBeGreaterThan(0)
  })

  it('only the person hides it: an agent, automation and a note Walnut writes are refused', async () => {
    const before = await file()
    expect(codeOf(await v1('POST', '/notes/hide', { path: NOTE }, AGENT))).toBe('human_only')
    expect(codeOf(await v1('POST', '/notes/hide', { path: NOTE }, AUTOMATION))).toBe('human_only')
    expect((await v1('POST', '/notes/hide', { path: NOTE }, AGENT)).status).toBe(403)
    expect(codeOf(await v1('POST', '/notes/hide', { path: 'global-notes.md' }))).toBe('not_lockable')
    expect(codeOf(await v1('POST', '/notes/hide', { path: NOTE, expectedHash: 'stale' }))).toBe('conflict')
    expect(await file()).toBe(before)
  })

  it('hides it: the file keeps its text and id, with the mark in its frontmatter', async () => {
    const before = await file()
    const id = /^id: (\S+)$/m.exec(before)?.[1]
    expect(id).toMatch(/^n_/)
    const r = await v1('POST', '/notes/hide', { path: NOTE })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ path: NOTE, hidden: true, changed: true })
    hash = r.body.contentHash
    const disk = await file()
    expect(noteProtection(disk)).toBe('hidden')
    expect(disk).toContain(`id: ${id}`)
    for (const w of SECRET) expect(disk).toContain(w)
    // Hiding it again changes nothing.
    expect((await v1('POST', '/notes/hide', { path: NOTE })).body).toMatchObject({ changed: false, contentHash: hash })
    expect(await file()).toBe(disk)
  })

  it('the person reads it whole on the Notes page; every other reader gets its frontmatter and stub', async () => {
    const mine = await http('GET', `/api/notes-v2/content/${NOTE}`)
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ hidden: true, contentHash: hash })
    expect(mine.body.content).toBe(await file())

    for (const r of [
      await http('GET', `/api/notes-v2/content/${NOTE}`, undefined, AGENT),
      await http('GET', `/api/notes-v2/content/${NOTE}`, undefined, AUTOMATION),
      await v1('GET', `/notes/content/${NOTE}`),
      await v1('GET', `/notes/content/${NOTE}`, undefined, AGENT),
    ]) {
      expect(r.status).toBe(200)
      expect(r.body.hidden).toBe(true)
      expect(r.body.contentHash).toBe(hash)
      expectStub(r.body.content)
    }
    // The Files panel (and the phone's, and a session's `api` call): the stub, and no hash, so it stays read-only.
    const files = await http('GET', `/api/file-content?path=${encodeURIComponent(abs())}`, undefined, AGENT)
    expect(files.status).toBe(200)
    expect(files.body.hidden).toBe(true)
    expect(files.body.contentHash).toBeUndefined()
    expectStub(files.body.content)
    for (const q of ['raw=1', 'raw=1&download=1']) {
      const raw = await http('GET', `/api/file-content?path=${encodeURIComponent(abs())}&${q}`, undefined, AGENT)
      expect(raw.status, q).toBe(200)
      expectStub(raw.text)
    }
  })

  it('note_read answers the stub and says no tool reads it; note_edit is refused', async () => {
    const read = await getOp('note_read')!.handler({ path: NOTE }, agentCall) as Record<string, unknown>
    expect(read).toMatchObject({ hidden: true, contentHash: hash })
    expectStub(read.content)
    expect(String(read.next)).toContain('no Walnut tool reads or changes it')
    await expect(getOp('note_edit')!.handler({ path: NOTE, old_str: 'Quiet', new_str: 'Loud' }, agentCall)).rejects.toThrow(/note_hidden|hidden/)
  })

  it('every agent write, delete, move and copy is refused, and the file stays as it was', async () => {
    const disk = await file()
    const refusals = [
      [423, await v1('PUT', `/notes/content/${NOTE}`, { content: 'overwritten', expectedHash: hash }, AGENT)],
      [423, await v1('PUT', `/notes/content/${NOTE}`, { content: 'overwritten' })],
      [423, await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: 'overwritten', expectedHash: hash }, AGENT)],
      [423, await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: disk, expectedHash: hash }, AUTOMATION)],
      [423, await http('PUT', '/api/file-content', { path: abs(), content: 'overwritten', expectedHash: hash })],
      [423, await http('DELETE', `/api/notes-v2/content/${NOTE}`, undefined, AGENT)],
      [423, await v1('DELETE', `/notes/${NOTE}`, undefined, AGENT)],
      [423, await v1('DELETE', '/notes/folder/journal', undefined, AGENT)],
      [423, await http('POST', '/api/notes-v2/move', { from: NOTE, to: 'journal/Moved.md' }, AGENT)],
      [423, await v1('POST', '/notes/move', { from: NOTE, to: 'journal/Moved.md' }, AGENT)],
      [423, await http('POST', '/api/files/duplicate', { path: abs(), newPath: path.join(notesRoot(), 'journal/Copy.md') }, AGENT)],
      [423, await http('POST', '/api/files/rename', { path: abs(), newPath: path.join(notesRoot(), 'journal/Moved.md') }, AGENT)],
      [423, await http('POST', '/api/files/delete', { path: abs() }, AGENT)],
    ] as const
    for (const [status, r] of refusals) {
      expect(r.status, JSON.stringify(r.body)).toBe(status)
      expect(JSON.stringify(r.body)).toContain('note_hidden')
    }
    expect(await file()).toBe(disk)
    expect(fs.existsSync(path.join(notesRoot(), 'journal/Moved.md'))).toBe(false)
    expect(fs.existsSync(path.join(notesRoot(), 'journal/Copy.md'))).toBe(false)
    // Only the person hides a note: an agent's new note or save carrying the mark is refused.
    const marked = '---\nwalnut_hidden: 1\n---\nnew text\n'
    expect(codeOf(await v1('POST', '/notes', { path: 'journal/Made by agent.md', content: marked }, AGENT))).toBe('hidden_note_text')
    expect(codeOf(await http('PUT', '/api/notes-v2/content/journal/Made by agent.md', { content: marked }, AGENT))).toBe('hidden_note_text')
    expect(codeOf(await http('PUT', '/api/file-content', { path: path.join(notesRoot(), 'journal/Made by agent.md'), content: marked }))).toBe('hidden_note_text')
    expect(fs.existsSync(path.join(notesRoot(), 'journal/Made by agent.md'))).toBe(false)
  })

  it('the person\'s editor keeps saving it, the mark kept; a save that drops the mark is refused', async () => {
    const cur = (await http('GET', `/api/notes-v2/content/${NOTE}`)).body
    const next = `${cur.content}Wednesday: a third private line.\n`
    const saved = await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: next, expectedHash: cur.contentHash })
    expect(saved.status).toBe(200)
    expect(await file()).toBe(next)
    hash = saved.body.contentHash
    const dropped = await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: TEXT, expectedHash: hash })
    expect(dropped.status).toBe(409)
    expect(dropped.body.code).toBe('hidden_mark_kept')
    expect(await file()).toBe(next)
  })

  it('search, the list and the indexes hold only the stub after the hide', async () => {
    const list = await waitFor(() => http('GET', '/api/notes-v2/list'), (r) => (r.body.notes ?? []).some((n: { path: string; hidden?: boolean }) => n.path === NOTE && n.hidden))
    expect(list.body.notes.find((n: { path: string }) => n.path === NOTE)).toMatchObject({ hidden: true })
    const gone = await waitFor(() => http('GET', `/api/notes-v2/search?q=${SEARCH_WORD}&mode=string`), (r) => !r.text.includes('Quiet week'))
    expect(gone.text).not.toContain('Quiet week')
    await settleLockedNoteResidue()
    expect(indexHits([...SECRET, 'a third private line'])).toEqual([])
  })

  it('locked_note_ask on it is refused: no ask opens a hidden note', async () => {
    const r = await v1('POST', '/vault/notes/agent/ask', { path: NOTE, purpose: 'summarise the week' }, AGENT)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('note_hidden')
    expect(r.body.error).toContain('no tool reads a hidden note')
  })

  it('Lock seals it whole, mark and all, and Remove lock gives back the hidden note', async () => {
    const plain = await file()
    const setup = await v1('POST', '/vault/setup', { passwordKey: toB64(await derivePasswordKey(MASTER, kdf)), kdf, agentsWhileAway: false, client: 'test' })
    expect(setup.status).toBe(200)
    session = setup.body.session.token
    const locked = await v1('POST', '/vault/notes/lock', { path: NOTE, expectedHash: hash })
    expect(locked.status).toBe(200)
    const disk = await file()
    expect(noteProtection(disk)).toBe('locked')
    for (const w of SECRET) expect(disk).not.toContain(w)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toBe(plain)
    // A locked note is neither hidden nor unhidden.
    expect(codeOf(await v1('POST', '/notes/hide', { path: NOTE }))).toBe('note_locked')
    expect(codeOf(await v1('POST', '/notes/unhide', { path: NOTE }))).toBe('note_locked')
    const back = await v1('POST', '/vault/notes/remove-lock', { path: NOTE, expectedHash: locked.body.contentHash })
    expect(back.status).toBe(200)
    expect(await file()).toBe(plain)
    expect(noteProtection(await file())).toBe('hidden')
    hash = back.body.contentHash
  })

  it('only the person unhides it, and agents read it again', async () => {
    expect(codeOf(await v1('POST', '/notes/unhide', { path: NOTE }, AGENT))).toBe('human_only')
    const r = await v1('POST', '/notes/unhide', { path: NOTE, expectedHash: hash })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ hidden: false, changed: true })
    const disk = await file()
    expect(noteProtection(disk)).toBeNull()
    expect(disk).not.toContain('walnut_hidden')
    const agent = await v1('GET', `/notes/content/${NOTE}`, undefined, AGENT)
    expect(agent.body.hidden).toBeUndefined()
    expect(agent.body.content).toContain(SECRET[0])
  })
})
