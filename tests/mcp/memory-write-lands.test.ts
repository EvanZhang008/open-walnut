/**
 * A memory save either lands or fails loudly (2026-11-06).
 *
 * The Walnut VP changed one line of USER.md with a read-modify-write script: it read memory_read's
 * result as a top-level `content`, found none, printed the read's own JSON and exited without
 * calling memory_write, and the VP took that output for "saved". USER.md stayed a day old.
 *
 * Pinned here, against the live server through the op executor:
 *   - memory_write takes `edits` (no read, no script), and an edit whose old text is not there
 *     refuses the whole save with the file untouched;
 *   - every answer says what the file holds now (`changed`, `size`), and a save that changed
 *     nothing says so in its outcome;
 *   - memory_read's outcome names where the text is (memory.content);
 *   - expectedHash refuses a save on a file that moved on, and two concurrent edits both land.
 * And the class: every op that replaces a whole stored document has a way to change part of it,
 * so no agent needs a read-modify-write script to change one line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-memory-write-lands'))

import { USER_FILE, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { executeOp, listOps, getOp } from '../../src/ops/index.js'

const USER = '---\nname: User Profile\n---\n\n## Rules\n- One.\n- Two.\n'

/**
 * Whole-document write ops and the op that changes part of the same document. An op listed
 * here takes the whole text; the named sibling takes a part. A new op that replaces a stored
 * document needs `edits` (or `mode`) of its own, or a sibling named here.
 */
const PARTIAL_SIBLING: Record<string, string> = {
  note_write: 'note_edit',
  board_set: 'board_edit',
}

/** Input keys that carry a whole stored document. */
const WHOLE_DOC_KEYS = ['content', 'html', 'markdown']
/** Input keys through which the same op changes part of it. */
const PARTIAL_KEYS = ['edits', 'mode', 'old_str']
/** Write ops whose `content`/`html`/`markdown` is a message or a request body, not a stored document. */
const NOT_A_DOCUMENT = new Set(['api', 'host_http', 'human_inbox_send', 'human_inbox_reply'])

describe('every whole-document write op has a partial path', () => {
  it('no op makes an agent rewrite a whole document to change one line', () => {
    const missing: string[] = []
    for (const op of listOps()) {
      if (op.tags.readonly || NOT_A_DOCUMENT.has(op.name)) continue
      const keys = Object.keys(op.input ?? {})
      if (!keys.some((k) => WHOLE_DOC_KEYS.includes(k))) continue
      if (keys.some((k) => PARTIAL_KEYS.includes(k))) continue
      const sibling = PARTIAL_SIBLING[op.name]
      if (sibling && getOp(sibling)) continue
      missing.push(op.name)
    }
    expect(missing, `whole-document write ops with no partial edit: ${missing.join(', ')}`).toEqual([])
  })

  it('the exemptions still name real ops', () => {
    for (const [op, sibling] of Object.entries(PARTIAL_SIBLING)) {
      expect(getOp(op), op).toBeDefined()
      expect(getOp(sibling), sibling).toBeDefined()
    }
    for (const name of NOT_A_DOCUMENT) expect(getOp(name), name).toBeDefined()
  })
})

describe('memory_write against the live server', () => {
  let server: HttpServer
  let stop: (() => Promise<void>) | undefined
  let apiBase = ''

  beforeAll(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    const { startServer, stopServer } = await import('../../src/web/server.js')
    server = await startServer({ port: 0, dev: true })
    stop = stopServer
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 120_000)

  afterAll(async () => {
    await stop?.()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(async () => {
    await fs.mkdir(path.dirname(USER_FILE), { recursive: true })
    await fs.writeFile(USER_FILE, USER, 'utf-8')
  })

  const disk = () => fs.readFile(USER_FILE, 'utf-8')
  const call = (name: string, args: Record<string, unknown>) => executeOp(name, args, { apiBase })

  it('edits land on disk with no read, and the answer says so', async () => {
    const r = await call('memory_write', { doc: 'user', edits: [{ old: '- Two.\n', new: '- Two.\n- Three.\n' }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as Record<string, unknown>
    expect(await disk()).toBe(USER.replace('- Two.\n', '- Two.\n- Three.\n'))
    expect(res.changed).toBe(true)
    expect(res.size).toBe((await disk()).length)
    expect(res.previousSize).toBe(USER.length)
    expect(String(res.outcome)).toMatch(/^USER\.md saved: \d+ characters \(was \d+\)/)
  })

  it('an edit whose old text is not there refuses the whole save and writes nothing', async () => {
    const r = await call('memory_write', {
      doc: 'user',
      edits: [{ old: '- One.', new: '- Uno.' }, { old: '- Not in the file.', new: 'x' }],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(JSON.stringify(r)).toMatch(/edits\[1\]\.old does not occur in USER\.md, so nothing was written/)
    expect(await disk()).toBe(USER)
  })

  it('an old text found twice is refused too', async () => {
    const r = await call('memory_write', { doc: 'user', edits: [{ old: '- ', new: '* ' }] })
    expect(r.ok).toBe(false)
    expect(await disk()).toBe(USER)
  })

  it('a save that changes nothing says so', async () => {
    const r = await call('memory_write', { doc: 'user', content: USER })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as Record<string, unknown>
    expect(res.changed).toBe(false)
    expect(String(res.outcome)).toBe('Nothing changed: USER.md already held exactly this text.')
  })

  it('a whole-content save still works, for MEMORY.md too', async () => {
    const r = await call('memory_write', { doc: 'global', content: '# Memory\n\n- fact\n' })
    expect(r.ok).toBe(true)
    expect(await fs.readFile(MEMORY_FILE, 'utf-8')).toBe('# Memory\n\n- fact\n')
    if (r.ok) expect(String((r.result as { outcome?: unknown }).outcome)).toMatch(/^MEMORY\.md saved: /)
  })

  it('neither content nor edits, or both, is refused', async () => {
    expect((await call('memory_write', { doc: 'user' })).ok).toBe(false)
    expect((await call('memory_write', { doc: 'user', content: 'x', edits: [{ old: '- One.', new: 'y' }] })).ok).toBe(false)
    expect(await disk()).toBe(USER)
  })

  it('a stale expectedHash refuses the save', async () => {
    const read = await call('memory_read', { doc: 'user' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const hash = (read.result as { memory: { contentHash: string } }).memory.contentHash
    await fs.writeFile(USER_FILE, USER + '- Someone else.\n', 'utf-8')
    const r = await call('memory_write', { doc: 'user', content: 'mine', expectedHash: hash })
    expect(r.ok).toBe(false)
    expect(await disk()).toBe(USER + '- Someone else.\n')
    const fresh = await call('memory_write', { doc: 'user', edits: [{ old: '- One.', new: '- 1.' }], expectedHash: 'not-the-hash' })
    expect(fresh.ok).toBe(false)
  })

  it('memory_read says where the text is', async () => {
    const r = await call('memory_read', { doc: 'user' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as { memory: { content: string }; outcome?: string; next?: string }
    expect(res.memory.content).toBe(USER)
    expect(res.outcome).toContain('Its text is memory.content')
    expect(res.next).toContain('"edits"')
  })

  it('concurrent edits of different lines both land', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- line ${i}.`)
    await fs.writeFile(USER_FILE, `## Rules\n${lines.join('\n')}\n`, 'utf-8')
    const results = await Promise.all(lines.map((line, i) =>
      call('memory_write', { doc: 'user', edits: [{ old: line, new: `- LINE ${i}.` }] })))
    expect(results.every((r) => r.ok)).toBe(true)
    const after = await disk()
    for (let i = 0; i < lines.length; i++) expect(after).toContain(`- LINE ${i}.`)
  })
})
