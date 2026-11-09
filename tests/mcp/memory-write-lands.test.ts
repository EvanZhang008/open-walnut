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
 * And the class: every write op that takes text is classified, and a new op that replaces a whole
 * stored document needs a line edit (`edits`), so no agent needs a read-modify-write script.
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

/** Input keys that carry text a write op stores or sends. Every write op with one is classified below. */
const TEXT_KEYS = ['content', 'html', 'markdown', 'instructions', 'body', 'text', 'description', 'note', 'summary', 'prompt', 'reply']
/** Input keys through which an op changes part of a stored document by exact text. */
const PARTIAL_KEYS = ['edits', 'old_str']
/** A whole-document write whose part-edit is another op. */
const PARTIAL_SIBLING: Record<string, string> = {
  note_write: 'note_edit',
  board_set: 'board_edit',
}
/**
 * Whole-document writes with no exact-text edit yet (`mode: append` adds, it does not change a
 * line). The ratchet: this list may only shrink; a new op that replaces a stored document needs
 * `edits` or a sibling instead.
 */
const WHOLE_REPLACE_KNOWN: Record<string, string> = {
  task_update: 'description is a task field, usually set whole',
  task_note_write: 'replace or append; no line edit yet',
  agent_memory_write: 'replace or append; no line edit yet',
  org_node_edit: 'instructions replace whole, at most 4000 characters',
}
/** Creates, or short fields set whole: nothing a script would edit one line of. */
const CREATE_OR_SHORT = new Set([
  'task_create', 'org_node_create', 'trigger_create', 'task_not_done_settle', 'board_project_set',
  'board_card_set', 'board_remind', 'thread_update', 'hint_set', 'triage_rule_set',
])
/** Messages and request bodies: sent, not stored as a document. */
const MESSAGE = new Set([
  'api', 'host_http', 'browser', 'task_send', 'board_post', 'org_send', 'thread_create', 'thread_file',
  'human_inbox_send', 'human_inbox_reply', 'human_inbox_answer', 'task_switch_engine', 'task_move',
  'triage_route',
])

describe('every whole-document write op has a partial path', () => {
  it('every write op that takes text is classified, and only the known ones lack a line edit', () => {
    const unclassified: string[] = []
    for (const op of listOps()) {
      if (op.tags.readonly) continue
      const keys = Object.keys(op.input ?? {})
      if (!keys.some((k) => TEXT_KEYS.includes(k))) continue
      if (keys.some((k) => PARTIAL_KEYS.includes(k))) {
        expect(WHOLE_REPLACE_KNOWN[op.name], `${op.name} has a line edit now: drop it from WHOLE_REPLACE_KNOWN`).toBeUndefined()
        continue
      }
      if (PARTIAL_SIBLING[op.name] && getOp(PARTIAL_SIBLING[op.name])) continue
      if (WHOLE_REPLACE_KNOWN[op.name] || CREATE_OR_SHORT.has(op.name) || MESSAGE.has(op.name)) continue
      unclassified.push(`${op.name} (${keys.filter((k) => TEXT_KEYS.includes(k)).join(', ')})`)
    }
    expect(unclassified, `write ops that take text with no line edit and no class: ${unclassified.join('; ')}. `
      + 'Give a stored document `edits`, or classify the op here').toEqual([])
  })

  it('memory_write is no longer among the whole-replace writes', () => {
    expect(Object.keys(getOp('memory_write')?.input ?? {})).toContain('edits')
    expect(WHOLE_REPLACE_KNOWN.memory_write).toBeUndefined()
  })

  it('every name in the tables is a real write op that takes text', () => {
    const names = [...Object.keys(PARTIAL_SIBLING), ...Object.values(PARTIAL_SIBLING), ...Object.keys(WHOLE_REPLACE_KNOWN), ...CREATE_OR_SHORT, ...MESSAGE]
    for (const name of names) expect(getOp(name), name).toBeDefined()
    for (const name of [...Object.keys(WHOLE_REPLACE_KNOWN), ...CREATE_OR_SHORT, ...MESSAGE]) {
      expect(Object.keys(getOp(name)?.input ?? {}).some((k) => TEXT_KEYS.includes(k)), `${name} takes no text any more`).toBe(true)
    }
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

  it('a save waits for the file lock every memory writer takes, and edits the text it finds then', async () => {
    const { withFileLock } = await import('../../src/utils/file-lock.js')
    let pending: Promise<unknown> | undefined
    await withFileLock(USER_FILE, async () => {
      // Another writer (memory_manage's bounded store) holds the lock: the save may not read yet.
      pending = call('memory_write', { doc: 'user', edits: [{ old: '- One.', new: '- 1.' }] })
      await new Promise((r) => setTimeout(r, 400))
      expect(await disk()).toBe(USER)
      await fs.writeFile(USER_FILE, `${USER}- Three, by the other writer.\n`, 'utf-8')
    })
    const r = (await pending) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await disk()).toBe(USER.replace('- One.', '- 1.') + '- Three, by the other writer.\n')
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

describe('memory_write against a server that ignores expectedHash', () => {
  it('a stale expectedHash is refused before any PUT, so an older server cannot overwrite', async () => {
    const http = await import('node:http')
    const puts: string[] = []
    const stub = http.createServer((req, res) => {
      if (req.method === 'PUT') puts.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.method === 'GET'
        ? { memory: { path: 'USER.md', content: 'now', contentHash: 'current-hash' } }
        : { ok: true, updatedAt: new Date().toISOString() }))
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    try {
      const apiBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
      const stale = await executeOp('memory_write', { doc: 'user', content: 'mine', expectedHash: 'old-hash' }, { apiBase })
      expect(stale.ok).toBe(false)
      expect(JSON.stringify(stale)).toMatch(/changed since you read it .*nothing was written/)
      expect(puts).toEqual([])
      const fresh = await executeOp('memory_write', { doc: 'user', content: 'mine', expectedHash: 'current-hash' }, { apiBase })
      expect(fresh.ok).toBe(true)
      expect(puts).toHaveLength(1)
    } finally {
      await new Promise<void>((r) => stub.close(() => r()))
    }
  })
})
