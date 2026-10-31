/**
 * Message hints through a REAL server (startServer({ port: 0, dev: true })): the
 * /api/v1/hints routes a person's Settings uses, and the same rules through the
 * agent ops (hint_list / hint_set / hint_reset, real registry: zod args, HTTP
 * binding), with what lands in config.yaml and what a session's next message
 * would carry.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

let server: HttpServer
let port: number
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH
const url = (p: string) => `http://localhost:${port}/api/v1${p}`
const apiBase = () => `http://localhost:${port}/api/v1`

async function json(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url(p), {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
})

describe('message hints through a real server', () => {
  it('lists the five built-ins with their default schedule', async () => {
    const r = await json('GET', '/hints')
    expect(r.status).toBe(200)
    const kinds = r.body.hints.map((h: { kind: string }) => h.kind)
    expect(kinds).toEqual(['question', 'rich-output', 'reply-language', 'voice-reply', 'user-away'])
    const rich = r.body.hints.find((h: { kind: string }) => h.kind === 'rich-output')
    expect(rich).toMatchObject({ enabled: true, every_turns: 5, placement: 'after', overridden: false })
    expect(rich.triggers).toEqual(['session_start', 'after_compaction', 'on_change', 'every_n_turns'])
    expect(r.body.triggers).toContain('on_drift')
  })

  it('a person changes a built-in; config.yaml keeps only the change; reset removes it', async () => {
    const put = await json('PUT', '/hints/rich-output', { every_turns: 3 })
    expect(put.status).toBe(200)
    expect(put.body.hint).toMatchObject({ kind: 'rich-output', every_turns: 3, overridden: true })
    const yaml = await fsp.readFile(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')
    expect(yaml).toMatch(/hints:\s*\n\s*rich-output:\s*\n\s*every_turns: 3/)
    const del = await json('DELETE', '/hints/rich-output')
    expect(del.body.hint).toMatchObject({ every_turns: 5, overridden: false })
    expect(await fsp.readFile(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).not.toMatch(/rich-output/)
  })

  it('refuses settings that cannot work, and an unknown kind without text', async () => {
    expect((await json('PUT', '/hints/question', { triggers: ['every_turn'] })).status).toBe(400)
    expect((await json('PUT', '/hints/reply-language', { text: 'x' })).status).toBe(400)
    expect((await json('PUT', '/hints/tone', { enabled: true })).status).toBe(400)
    expect((await json('DELETE', '/hints/nothing-here')).status).toBe(404)
  })

  it('an agent adds, edits and removes a custom hint through the ops', async () => {
    const opts = { apiBase: apiBase(), origin: LOCAL_ORIGIN }
    const add = await executeOp('hint_set', { kind: 'tone', text: 'Keep answers short.', audience: { roles: ['main'] } }, opts)
    expect(add.ok).toBe(true)
    expect((add as any).result.hint).toMatchObject({ kind: 'tone', built_in: false, text: 'Keep answers short.' })
    // A later edit keeps the text it did not mention.
    const edit = await executeOp('hint_set', { kind: 'tone', placement: 'before' }, opts)
    expect((edit as any).result.hint).toMatchObject({ placement: 'before', text: 'Keep answers short.', audience: { roles: ['main'] } })
    const list = await executeOp('hint_list', {}, opts)
    expect((list as any).result.outcome).toMatch(/tone: session_start, after_compaction, on_change, before the message/)
    const gone = await executeOp('hint_reset', { kind: 'tone' }, opts)
    expect((gone as any).result.outcome).toMatch(/removed/)
    expect((await json('GET', '/hints')).body.hints.map((h: { kind: string }) => h.kind)).not.toContain('tone')
  })

  it('shows what a session was told and what its next message carries', async () => {
    const sid = 'aaaaaaaa-1111-2222-3333-000000000001'
    await createSessionRecord(sid, 'task-hints-e2e', '', '/tmp/hints-e2e')
    const r = await json('GET', `/hints?session=${sid}`)
    expect(r.status).toBe(200)
    expect(r.body.session).toMatchObject({ session_id: sid, sends: 0 })
    // A fresh session on the default rich mode hears the full rich instruction first.
    expect(r.body.session.next_message_carries).toEqual(['rich-output'])
    expect((await json('GET', '/hints?session=nope')).status).toBe(404)
  })
})
