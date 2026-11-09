/**
 * Who wrote a Brief, on a real server (PUT/GET /api/v1/tasks/:id/brief, brief.text_sources): the
 * writer is the request's caller (`x-walnut-caller-sid`), never anything the body says; a person's
 * write is the primary's; an edit keeps the old words' writer. Only the Claude CLI would be mocked
 * (none runs here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-brief-sources'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { briefPathWriters } from '../../src/core/sessions/brief-source.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'

const SID = '11111111-2222-4333-8444-555555555555'
const REMOTE_SID = '22222222-2222-4333-8444-555555555555'
let base = ''
let leadId = ''
let workerId = ''
let otherId = ''

async function put(payload: unknown, sid?: string): Promise<Record<string, any>> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/brief`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(payload),
  })
  expect(res.status).toBe(200)
  return res.json()
}

async function get(): Promise<Record<string, any>> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/brief`)
  expect(res.status).toBe(200)
  return res.json()
}

const letter = (path: string) => `### Needs you\n- None\n### Working\n- None\n### Waiting / snoozed\n- <task-ref id="${workerId}" label="Garden job"/>: log at ${path}`
const twoLines = (a: string, b: string) => `${letter(a)}\n- <task-ref id="${otherId}" label="Garden other"/>: notes at ${b}`

/** Start the next test from a stored letter that shares no character with any test letter. */
async function reset(): Promise<void> {
  await updateTaskRaw(leadId, () => ({ brief: { text: '\u00a7', at: new Date().toISOString() } }), { emitEvent: false, source: 'test' })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Garden job', project: 'Garden' })).task.id
  otherId = (await addTask({ title: 'Garden other', project: 'Garden' })).task.id
  leadId = (await ensureProjectLead('Garden')).id
  await createSessionRecord(REMOTE_SID, workerId, 'Garden', '/home/me/garden', { host: 'devbox' })
  await updateSessionRecord(REMOTE_SID, { process_status: 'stopped' })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Brief text sources over HTTP', () => {
  it('a header naming no known session is an unknown agent with no session, and sources in the body are ignored', async () => {
    await reset()
    const forged = [{ start: 0, end: 5, by: 'human' }]
    const out = await put({ content: letter('/home/me/a.log'), text_sources: forged, by: 'human', sessionId: 'forged' }, SID)
    expect(briefPathWriters(out.brief.text, out.brief.text_sources, '/home/me/a.log')).toEqual([{ by: 'agent' }])
    const read = await get()
    expect(read.brief.text_sources).toEqual(out.brief.text_sources)
  })

  it('a person\'s edit is the primary\'s, and the old path keeps its writer', async () => {
    await reset()
    await put({ content: letter('/home/me/a.log') }, SID)
    const before = (await get()).brief.text as string
    const out = await put({ edits: [{ old: 'log at /home/me/a.log', new: 'log at /home/me/a.log, notes at /Users/me/n.md' }] })
    expect(out.brief.text).not.toBe(before)
    expect(briefPathWriters(out.brief.text, out.brief.text_sources, '/home/me/a.log')).toEqual([{ by: 'agent' }])
    expect(briefPathWriters(out.brief.text, out.brief.text_sources, '/Users/me/n.md')).toEqual([{ by: 'human' }])
  })

  it('the same words sent whole by another writer keep their writers', async () => {
    await reset()
    const mine = await put({ content: letter('/home/me/b.log') })
    expect(briefPathWriters(mine.brief.text, mine.brief.text_sources, '/home/me/b.log')).toEqual([{ by: 'human' }])
    const again = await put({ content: mine.brief.text }, SID)
    expect(again.brief.text).toBe(mine.brief.text)
    expect(again.brief.text_sources).toEqual(mine.brief.text_sources)
  })

  it('a verified remote writer survives a whole-text echo by a person', async () => {
    const writer = REMOTE_SID
    await reset()
    const first = await put({ content: letter('/home/me/written.log') }, writer)
    expect(briefPathWriters(first.brief.text, first.brief.text_sources, '/home/me/written.log')).toEqual([{ by: `task:${workerId}`, sessionId: writer }])
    const echo = await put({ content: first.brief.text })
    expect(echo.brief.text_sources).toEqual(first.brief.text_sources)
    // The person changed the path, not every character of it: the shared ones keep the remote writer.
    const changed = await put({ content: echo.brief.text.replace('/home/me/written.log', '/Users/me/rewritten.log') })
    const writers = briefPathWriters(changed.brief.text, changed.brief.text_sources, '/Users/me/rewritten.log')
    expect(writers).toHaveLength(2)
    expect(writers).toEqual(expect.arrayContaining([{ by: 'human' }, { by: `task:${workerId}`, sessionId: writer }]))
  })

  it('a person rewriting the whole letter but changing only another line leaves the remote path remote', async () => {
    await reset()
    const remote = { by: `task:${workerId}`, sessionId: REMOTE_SID }
    const first = await put({ content: twoLines('/home/me/remote.log', '/home/me/second.md') }, REMOTE_SID)
    expect(first.brief.text).toContain('/home/me/second.md')
    expect(briefPathWriters(first.brief.text, first.brief.text_sources, '/home/me/remote.log')).toEqual([remote])
    const changed = await put({ content: first.brief.text.replace('notes at /home/me/second.md', 'notes at /Users/me/mine.md') })
    expect(changed.brief.text).toContain('/Users/me/mine.md')
    expect(briefPathWriters(changed.brief.text, changed.brief.text_sources, '/home/me/remote.log')).toEqual([remote])
    expect(briefPathWriters(changed.brief.text, changed.brief.text_sources, '/Users/me/mine.md')).toEqual(expect.arrayContaining([{ by: 'human' }]))
  })

  for (const exact of [false, true]) {
    it(`a ${exact ? 'exact edit' : 'whole rewrite'} deleting a path segment keeps the editor among its writers`, async () => {
      await reset()
      const first = await put({ content: twoLines('/home/me/old/written.log', '/home/me/keep.md') }, REMOTE_SID)
      const before = first.brief.text as string
      const out = await put(exact
        ? { edits: [{ old: '/home/me/old/written.log', new: '/home/me/written.log' }] }
        : { content: before.replace('/home/me/old/written.log', '/home/me/written.log') })
      const writers = briefPathWriters(out.brief.text, out.brief.text_sources, '/home/me/written.log')
      expect(writers).toEqual(expect.arrayContaining([{ by: 'human' }, { by: `task:${workerId}`, sessionId: REMOTE_SID }]))
      expect(writers).toHaveLength(2)
      expect(briefPathWriters(out.brief.text, out.brief.text_sources, '/home/me/keep.md')).toEqual([{ by: `task:${workerId}`, sessionId: REMOTE_SID }])
      expect((await get()).brief.text_sources).toEqual(out.brief.text_sources)
    })
  }

  it('identical exact edits retain recorded writers even with an exhausted source clock', async () => {
    await reset()
    const first = await put({ content: letter('/home/me/remote.log') }, REMOTE_SID)
    let ticks = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (ticks += 26))
    let out: Record<string, any>
    try {
      out = await put({ edits: [{ old: '/home/me/remote.log', new: '/home/me/remote.log' }] })
    } finally {
      clock.mockRestore()
    }
    expect(out!.brief.text).toBe(first.brief.text)
    expect(out!.brief.text_sources).toEqual(first.brief.text_sources)
  })

  it('an exact edit exceeding the source budget preserves every text change with unknown writers', async () => {
    await reset()
    await put({ content: twoLines('/home/me/old/written.log', '/home/me/keep.md') }, REMOTE_SID)
    let ticks = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (ticks += 26))
    let out: Record<string, any>
    try {
      out = await put({ edits: [
        { old: '/home/me/old/written.log', new: '/home/me/written.log' },
        { old: '/home/me/keep.md', new: '/home/me/next.md' },
      ] })
    } finally {
      clock.mockRestore()
    }
    expect(out!.brief.text).toContain('/home/me/written.log')
    expect(out!.brief.text).toContain('/home/me/next.md')
    expect(out!.brief.text).not.toContain('/home/me/old/written.log')
    for (const p of ['/home/me/written.log', '/home/me/next.md']) {
      expect(briefPathWriters(out!.brief.text, out!.brief.text_sources, p)).toEqual([{ by: 'agent' }])
    }
    expect((await get()).brief.text_sources).toEqual(out!.brief.text_sources)
  })

  it('an older letter with no writers stays unknown when the same words are sent whole', async () => {
    await reset()
    await put({ content: letter('/home/me/older.log') })
    const text = (await getTask(leadId)).brief!.text
    await updateTaskRaw(leadId, (t) => ({ brief: { text, at: t.brief!.at } }), { emitEvent: false, source: 'test' })
    const out = await put({ content: text })
    expect(out.brief.text).toBe(text)
    expect(briefPathWriters(out.brief.text, out.brief.text_sources, '/home/me/older.log')).toEqual([{ by: 'agent' }])
  })
})
