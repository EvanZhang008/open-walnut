/**
 * Walnut's record of a session's own carded calls (src/core/sessions/op-call-log.ts),
 * end to end from the CLI's recorder (src/ops/executor.ts recordSessionOpCall) through
 * the route to the lookup a chat card makes. 2026-11-09: a lead sent every message
 * with `@/tmp/x.json` and its cards read "Payload from file"; the record carries the
 * words, tied to the Bash row that ran the call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-op-call-log'))

import express from 'express'
import request from 'supertest'
import { ClaudeCodeSession, sessionRunner } from '../../../src/providers/claude-code-session.js'
import { sessionOpCallsV1Router } from '../../../src/web/routes/session-op-calls-v1.js'
import { recordSessionOpCall } from '../../../src/ops/executor.js'
import { MAX_ENTRIES, recordOpCall } from '../../../src/core/sessions/op-call-log.js'

const SID = 'bbbbbbbb-1111-4222-8333-444444444444'

/** A runner whose Bash calls are the given ones, read by the real matcher. */
function fakeRunner(open: Array<[string, string]>, closed: Array<{ id: string; command: string; closedAt: number }> = []) {
  const self = { _openBashCalls: new Map(open), _closedBashCalls: closed }
  return { bashCallMatching: (m: (c: string) => boolean, taken?: ReadonlySet<string>) => ClaudeCodeSession.prototype.bashCallMatching.call(self, m, taken) }
}

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/api/v1', sessionOpCallsV1Router)
let server: Server
let base = ''

beforeAll(async () => {
  server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})
afterAll(() => { server.close() })
beforeEach(() => { vi.restoreAllMocks() })

const lookup = async (tools: string[]) => (await request(app).post(`/api/v1/sessions/${SID}/op-calls/lookup`).send({ tools })).body.calls

describe('the CLI records a call, the card finds it by its row', () => {
  it('ties an @file send to the Bash row that named the file, words included', async () => {
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(fakeRunner([
      ['toolu_other', 'ls -la'],
      ['toolu_send', "cat > /tmp/vp-x.json <<'EOF'\n{}\nEOF\nwalnut tools call task_send @/tmp/vp-x.json | grep -o requestId"],
    ]) as never)
    const prevSid = process.env.WALNUT_SESSION_ID
    const prevUrl = process.env.OPEN_WALNUT_API_URL
    process.env.WALNUT_SESSION_ID = SID
    process.env.OPEN_WALNUT_API_URL = base
    try {
      await recordSessionOpCall({
        op: 'task_send', args: { to: 'mw0abcde-1234', title: 'Tabs out of sync', text: 'The card lists two tabs. Chrome holds nine.' },
        result: { delivery: 'queued' }, ok: true, form: 'file', path: '/tmp/vp-x.json',
      })
    } finally {
      process.env.WALNUT_SESSION_ID = prevSid
      if (prevUrl === undefined) delete process.env.OPEN_WALNUT_API_URL; else process.env.OPEN_WALNUT_API_URL = prevUrl
    }
    const calls = await lookup(['toolu_send', 'toolu_other'])
    expect(Object.keys(calls)).toEqual(['toolu_send'])
    expect(calls.toolu_send[0]).toMatchObject({ op: 'task_send', form: 'file', path: '/tmp/vp-x.json', ok: true })
    expect(calls.toolu_send[0].fields).toMatchObject({ to: ['mw0abcde-1234'], title: 'Tabs out of sync', detail: 'The card lists two tabs. Chrome holds nine.' })
  })

  it("a background command's call finds its row after the row returned", async () => {
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(fakeRunner([], [
      { id: 'toolu_bg', command: 'echo x | walnut tools call thread_update -', closedAt: Date.now() - 60_000 },
    ]) as never)
    const entry = await recordOpCall(SID, { op: 'thread_update', form: 'stdin', ok: true, fields: { op: 'thread_update', kind: 'thread', to: [], summary: 'Handed on.' } })
    expect(entry?.toolUseId).toBe('toolu_bg')
  })

  it('two rows sending at once each get their own call', async () => {
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(fakeRunner([
      ['toolu_a', "echo '{}' | walnut tools call task_send -"],
      ['toolu_b', "echo '{}' | walnut tools call task_send -"],
    ]) as never)
    const f = { op: 'task_send', kind: 'send', to: [], detail: 'x' }
    const one = await recordOpCall(SID, { op: 'task_send', form: 'stdin', ok: true, fields: f })
    const two = await recordOpCall(SID, { op: 'task_send', form: 'stdin', ok: true, fields: f })
    expect(new Set([one?.toolUseId, two?.toolUseId])).toEqual(new Set(['toolu_a', 'toolu_b']))
  })

  it('keeps a refusal with its error', async () => {
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(fakeRunner([['toolu_r', 'walnut tools call human_inbox_send @/tmp/l.json']]) as never)
    await recordOpCall(SID, { op: 'human_inbox_send', form: 'file', path: '/tmp/l.json', ok: false, error: '409 user_kind', fields: { op: 'human_inbox_send', kind: 'letter', to: [], title: 'Pick a plan' } })
    expect((await lookup(['toolu_r'])).toolu_r[0]).toMatchObject({ ok: false, error: '409 user_kind' })
  })
})

describe('what is kept', () => {
  it('only a session writes, only carded ops, only the card fields, cut to size', async () => {
    expect((await request(app).post('/api/v1/sessions/op-calls').send({ op: 'task_send', fields: {} })).status).toBe(400)
    const notCarded = await request(app).post('/api/v1/sessions/op-calls').set('x-walnut-caller-sid', SID).send({ op: 'task_get', fields: { op: 'task_get', to: [] } })
    expect(notCarded.status).toBe(204)
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(fakeRunner([['toolu_big', 'walnut tools call board_post -']]) as never)
    const big = await request(app).post('/api/v1/sessions/op-calls').set('x-walnut-caller-sid', SID)
      .send({ op: 'board_post', form: 'stdin', ok: true, fields: { kind: 'board', to: ['ok-id-1', '<script>'], detail: 'y'.repeat(50_000), secret: 'nope' } })
    expect(big.status).toBe(200)
    const kept = (await lookup(['toolu_big'])).toolu_big[0]
    expect(kept.fields.to).toEqual(['ok-id-1'])
    expect(kept.fields.detail.length).toBeLessThanOrEqual(20_000)
    expect(kept.fields).not.toHaveProperty('secret')
  })

  it('keeps the newest entries only', async () => {
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(undefined as never)
    const sid = 'cccccccc-1111-4222-8333-444444444444'
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await recordOpCall(sid, { op: 'task_send', form: 'inline', ok: true, fields: { op: 'task_send', kind: 'send', to: [], detail: `n${i}` } })
    }
    const fs = await import('node:fs/promises')
    const { WALNUT_HOME } = await import('../../../src/constants.js')
    const file = JSON.parse(await fs.readFile(`${WALNUT_HOME}/op-calls/${sid}.json`, 'utf-8'))
    expect(file.calls).toHaveLength(MAX_ENTRIES)
    expect(file.calls.at(-1).fields.detail).toBe(`n${MAX_ENTRIES + 4}`)
  }, 60_000)
})
