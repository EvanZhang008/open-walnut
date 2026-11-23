/**
 * An op whose write this host's own server only journaled while the Walnut server is away
 * (src/replica/write-port.ts answers `{ queued: true, offline: true, opId }`) says so in its
 * outcome, whatever the op would have read from an online answer (src/ops/executor.ts
 * awayWrites, src/ops/outcome.ts heldAwayResult).
 *
 * 2026-11-23, real use: board_project_set on clouddev's host service, the Mac away for a moment,
 * answered `Project "hosts" removed from ...'s board.` for a project it had just written: the
 * journaled answer carries no `project`, and the op reads a missing project as a removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-away-held-outcome-test'))

import { executeOp } from '../../src/ops/executor.js'
import { heldAwayResult, isBareAwayQueued } from '../../src/ops/outcome.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import '../../src/ops/index.js'
import { defineOp } from '../../src/ops/registry.js'

defineOp({
  name: 'test_probe_two_writes', title: 'probe', description: 'probe', input: {},
  handler: async (_args, call) => { await call('POST', '/probe-a', {}); await call('POST', '/probe-b', {}); return { outcome: 'Wrote a and b.', next: 'none' } },
  tags: { readonly: false, remote: 'allow' },
})
defineOp({
  name: 'test_probe_read_post', title: 'probe', description: 'probe', input: {},
  handler: async (_args, call) => { await call('POST', '/probe-search', {}); return { outcome: 'Read it.', next: 'none' } },
  tags: { readonly: true, remote: 'allow' },
})

let server: http.Server
let answer: (method: string, url: string) => unknown
const seen: string[] = []
let base = ''

beforeEach(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`)
      const body = answer(req.method ?? 'GET', req.url ?? '')
      res.setHeader('Content-Type', 'application/json')
      if (body && typeof body === 'object' && 'status' in body && 'error' in body) {
        res.statusCode = (body as { status: number }).status
        res.end(JSON.stringify({ error: (body as { error: unknown }).error }))
        return
      }
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => { server.close(); seen.length = 0; vi.restoreAllMocks() })

const run = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: base, origin: LOCAL_ORIGIN, callerSid: 'eeeeeeee-1111-4111-8111-111111111111' })

const JOURNALED = { queued: true, offline: true, opId: 'oc-b6da0ceb86624b44b8da195583df7b32-62738c3e-0' }

describe('a write journaled on this host while the server is away', () => {
  it('board_project_set says it was saved here, never that the project was removed', async () => {
    answer = () => JOURNALED
    const out = await run('board_project_set', { task: 'lead01', id: 'hosts', latest: 'clouddev runs one service', next: 'watch the drain' })
    expect(out.ok).toBe(true)
    const r = out.result as Record<string, unknown>
    expect(String(r.outcome)).not.toMatch(/removed/i)
    expect(String(r.outcome)).toMatch(/Saved on this host while the Walnut server is away/)
    expect(r).toMatchObject({ queued: true, offline: true })
    expect(String(r.next)).toMatch(/Do not repeat the call/)
  })

  it('a board write and a note write that were journaled say the same', async () => {
    answer = () => JOURNALED
    for (const [name, args] of [
      ['board_edit', { task: 'lead01', edits: [{ old: 'a', new: 'b' }] }],
      ['board_post', { task: 'lead01', thread: 'hosts', text: 'the drain ran once' }],
      ['task_note_write', { id: 'mtaskaaa-0001', content: 'held while away' }],
    ] as const) {
      const out = await run(name, args as Record<string, unknown>)
      expect(out.ok, `${name}: ${out.ok ? '' : out.message}`).toBe(true)
      expect(String((out.result as Record<string, unknown>).outcome), name).toMatch(/Saved on this host while the Walnut server is away/)
    }
  })

  it('a journaled create whose start is refused keeps the op\'s "did not start" words', async () => {
    // The create is journaled; the start needs the Mac and is refused: not every write was only journaled.
    answer = (method, url) => {
      if (method === 'POST' && /\/tasks(\?|$)/.test(url)) return { ...JOURNALED, task: { id: 'mtaskbbb-0002', title: 'Plan', phase: 'TODO', project: 'Walnut' } }
      if (method === 'POST') return { status: 409, error: { code: 'needs_leader', message: 'starting it needs your Mac.' } }
      return {}
    }
    const out = await run('task_create', { title: 'Plan', description: 'write the plan', project: 'Walnut', project_reason: 'test' })
    expect(seen.some((l) => l.startsWith('POST') && !/\/tasks(\?|$)/.test(l.split(' ')[1] ?? '')), seen.join('\n')).toBe(true)
    // A start that did not start is said as an error (2026-11-06), in the op's own words.
    const words = out.ok ? String((out.result as Record<string, unknown>).outcome) : out.message
    expect(words).toMatch(/was created and is kept on this host for your Mac, but it did not start/)
    expect(words).not.toMatch(/Saved on this host while the Walnut server is away/)
  })

  it('a call with one write applied and one journaled keeps the op\'s own words (guard)', async () => {
    answer = (_m, url) => url.includes('/probe-a') ? { ok: true } : JOURNALED
    const out = await run('test_probe_two_writes', {})
    expect(out.ok, out.ok ? '' : out.message).toBe(true)
    expect(seen).toEqual(['POST /api/v1/probe-a', 'POST /api/v1/probe-b'])
    expect((out.result as Record<string, unknown>).outcome).toBe('Wrote a and b.')
    // Both only journaled: then it says so.
    answer = () => JOURNALED
    const held = await run('test_probe_two_writes', {})
    expect(String((held.result as Record<string, unknown>).outcome)).toMatch(/2 writes are journaled here/)
  })

  it('a read op that posts is never rewritten (guard)', async () => {
    answer = () => JOURNALED
    const out = await run('test_probe_read_post', {})
    expect((out.result as Record<string, unknown>).outcome).toBe('Read it.')
  })

  it('an answer journaled with more than the bare receipt is the op\'s to read', () => {
    expect(isBareAwayQueued(JOURNALED)).toBe(true)
    expect(isBareAwayQueued({ ...JOURNALED, task: { id: 't' } })).toBe(false)
    expect(isBareAwayQueued({ queued: true, offline: true, outcome: 'x', next: 'y' })).toBe(false)
    expect(isBareAwayQueued({ queued: true })).toBe(false)
    expect(isBareAwayQueued([JOURNALED])).toBe(false)
    expect(heldAwayResult('text', 1)).toBe('text')
    expect(heldAwayResult(null, 1)).toBe(null)
    expect(String((heldAwayResult({ a: 1 }, 2) as { outcome: string }).outcome)).toMatch(/2 writes are journaled/)
  })

  it('an online answer keeps the op\'s own words (guard)', async () => {
    answer = () => ({ project: { title: 'Hosts', status: 'wip', tasks: ['t1'] } })
    const out = await run('board_project_set', { task: 'lead01', id: 'hosts', latest: 'x' })
    expect(String((out.result as Record<string, unknown>).outcome)).toBe('Project "hosts" of lead01\'s board: wip, 1 task.')
  })

  it('an away answer with its own words (the host daemon\'s) is passed on as it came (guard)', async () => {
    const own = { queued: true, offline: true, outcome: 'Applied to this host\'s copy of the Board of lead01 (now version 4); Walnut applies it when the server reconnects.', next: 'Nothing else is required.' }
    answer = () => own
    const out = await run('agent_memory_write', { task: 'lead01', content: 'x' })
    expect(out.ok, out.ok ? '' : out.message).toBe(true)
    expect((out.result as Record<string, unknown>).outcome).toBe(own.outcome)
  })
})
