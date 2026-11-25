/**
 * What counts as a locked note's file, through the real routes (docs/reference/locked-notes.md):
 *  - no create or save writes one as new text, made up, copied or bent (400 locked_note_text);
 *  - a file an outside editor bent (text after its envelope line, a BOM) refuses every ordinary
 *    write, so its ciphertext is never lost;
 *  - a plain note that quotes the format (the doc page itself) stays plain: created, saved and
 *    listed as any other note.
 * Fake data only; the notes are the test's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-locked-notes-text-guards'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { notesRoot } from '../../src/core/notes/note-paths.js'
import { buildLockedNoteText, LOCKED_NOTE_STUB } from '../../src/core/notes/locked-note.js'
import { reconcileNote } from '../../src/core/notes-indexer.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const envelope = { key: 'item-guards', iv: 'AAAAAAAAAAAAAAAA', ct: 'Y2lwaGVydGV4dGd1YXJk' }
const LINE = `<!-- walnut-locked-note v1 ${JSON.stringify(envelope)} -->`
const LOCKED = buildLockedNoteText({ id: 'n_guarded', envelope })
const AGENT = { 'x-walnut-caller-sid': 'sess-guards-agent' }

/** Texts no ordinary write may put in a note: a locked note's file, made up, copied or bent. */
const LOCKED_TEXTS: Record<string, string> = {
  copied: LOCKED,
  'made up, mark only': '---\nwalnut_locked: 1\n---\nHello\n',
  'a BOM': `\uFEFF${LOCKED}`,
  'quoted mark': LOCKED.replace('walnut_locked: 1', 'walnut_locked: "1"'),
  'text after the envelope': `${LOCKED.trimEnd()} trailing\n`,
  CRLF: LOCKED.replace(/\n/g, '\r\n'),
}

let base = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}
const abs = (rel: string) => path.join(notesRoot(), rel)
const readDisk = (rel: string) => fsp.readFile(abs(rel), 'utf8').catch(() => null)
async function writeDisk(rel: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs(rel)), { recursive: true })
  await fsp.writeFile(abs(rel), text, 'utf8')
}
const errorCode = (b: Record<string, any>) => b.code ?? b.error?.code ?? b.error

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
})

describe('locked-note text through the note routes', () => {
  it('a create never makes a locked note\'s file (S5), for a person or an agent', async () => {
    for (const [what, content] of Object.entries(LOCKED_TEXTS)) {
      for (const headers of [{}, AGENT]) {
        const rel = `guards/create ${what}.md`
        const r = await http('POST', '/api/v1/notes', { path: rel, content }, headers)
        expect({ what, status: r.status, code: errorCode(r.body) }).toEqual({ what, status: 400, code: 'locked_note_text' })
        expect(await readDisk(rel)).toBeNull()
      }
    }
  })

  it('a save never writes one over a plain note, on either notes route', async () => {
    const rel = 'guards/plain.md'
    expect((await http('POST', '/api/v1/notes', { path: rel, content: '# Plain\n' })).status).toBe(201)
    const before = await readDisk(rel)
    for (const [what, content] of Object.entries(LOCKED_TEXTS)) {
      for (const r of [
        await http('PUT', `/api/v1/notes/content/${rel}`, { content }, AGENT),
        await http('PUT', `/api/notes-v2/content/${rel}`, { content }),
      ]) {
        expect({ what, status: r.status, text: JSON.stringify(r.body) }).toMatchObject({ what, status: 400 })
        expect(JSON.stringify(r.body)).toContain('locked_note_text')
      }
    }
    expect(await readDisk(rel)).toBe(before)
  })

  it('a locked file an outside editor bent refuses every ordinary write, so its ciphertext stays (S6)', async () => {
    for (const [what, text] of [
      ['after-arrow', `${LOCKED.trimEnd()} trailing\n`],
      ['line-after', `${LOCKED}Typed later in another editor.\n`],
      ['bom', `\uFEFF${LOCKED}`],
      ['indented', LOCKED.replace(LINE, `    ${LINE}`)],
    ]) {
      const rel = `guards/bent ${what}.md`
      await writeDisk(rel, text)
      const tries = [
        await http('PUT', `/api/v1/notes/content/${rel}`, { content: 'overwritten' }, AGENT),
        await http('PUT', `/api/notes-v2/content/${rel}`, { content: 'overwritten' }),
      ]
      for (const t of tries) {
        expect({ what, status: t.status }).toEqual({ what, status: 423 })
        expect(JSON.stringify(t.body)).toContain('note_locked')
      }
      expect(await readDisk(rel)).toBe(text)
    }
    // A BOM or an indented envelope line is still a locked note to readers: the stub, no envelope.
    for (const rel of ['guards/bent bom.md', 'guards/bent indented.md']) {
      const r = await http('GET', `/api/v1/notes/content/${rel}`, undefined, AGENT)
      expect(r.body.locked).toBe(true)
      expect(r.body.content).toContain(LOCKED_NOTE_STUB)
      expect(r.body.content).not.toContain('walnut-locked-note')
    }
  })

  it('a plain note that quotes the format, the doc page itself, is created, saved and listed as plain (X2)', async () => {
    const doc = await fsp.readFile(path.join(root, 'docs/reference/locked-notes.md'), 'utf8')
    const rel = 'guards/About locking.md'
    const made = await http('POST', '/api/v1/notes', { path: rel, content: doc }, AGENT)
    expect(made.status).toBe(201)
    const saved = await http('PUT', `/api/v1/notes/content/${rel}`, { content: `${doc}\nOne more line.\n`, expectedHash: made.body.contentHash }, AGENT)
    expect(saved.status).toBe(200)
    const v2 = await http('PUT', `/api/notes-v2/content/${rel}`, { content: `${doc}\nA person's line.\n`, expectedHash: saved.body.contentHash })
    expect(v2.status).toBe(200)
    const read = await http('GET', `/api/notes-v2/content/${rel}`)
    expect(read.body.locked).toBeUndefined()
    expect(read.body.content).toContain("A person's line.")
    // Locked notes on disk beside it: the list marks those only, by the one mark rule (N5).
    await writeDisk('guards/Sealed.md', LOCKED)
    await writeDisk('guards/Sealed quoted.md', buildLockedNoteText({ id: 'n_quoted', envelope }).replace('walnut_locked: 1', 'walnut_locked: "1"'))
    // Another value of the key, with a body that opens like the stub, is no mark.
    await writeDisk('guards/Ten.md', `---\nid: n_ten\nwalnut_locked: 10\n---\n${LOCKED_NOTE_STUB}\n`)
    for (const p of ['guards/Sealed.md', 'guards/Sealed quoted.md', 'guards/Ten.md', rel]) await reconcileNote(p)
    const list = (await http('GET', '/api/notes-v2/list')).body.notes as Array<{ path: string; locked?: boolean }>
    const lockedOf = (p: string) => { const n = list.find((x) => x.path === p); expect(n, p).toBeDefined(); return n!.locked }
    expect(lockedOf(rel)).toBeUndefined()
    expect(lockedOf('guards/Ten.md')).toBeUndefined()
    expect(lockedOf('guards/Sealed.md')).toBe(true)
    expect(lockedOf('guards/Sealed quoted.md')).toBe(true)
  })
})
