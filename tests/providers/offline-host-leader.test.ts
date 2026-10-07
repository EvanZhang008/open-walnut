/**
 * The offline host while the cloud companion leads (src/providers/offline-host-core.ts,
 * docs/plan/walnut-control-plane.md): messages between hosts that the leader
 * routes here (`deliverFromLeader`), and answers this host sends back through
 * the leader (`relay`) for an asker that runs on another host.
 *
 * Real files in a temp dir, delivery into a FIFO is a recorder, the leader is
 * a recorder too. Envelopes are compared with the SERVER's own builders.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice, type OfflineHostDeps, type OfflineRecord } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { buildPeerWrapper } from '../../src/core/peers/peer-wrapper.js'
import { buildReplyDeliveryText, type SessionRequest } from '../../src/core/session-requests.js'

const HOME = '/fixture/walnut-home'
const LEADER = 'aaaaaaaa-1111-4111-8111-111111111111' // on another host
const WORKER = 'bbbbbbbb-2222-4222-8222-222222222222' // here
const IDLE = 'cccccccc-3333-4333-8333-333333333333' // here, not running

function slice(over: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.parse('2026-10-05T10:00:00Z'), host: 'oldbox',
    sessions: [
      { sid: WORKER, taskId: 'mworker0-0002', title: 'Worker: fix the build' },
      { sid: IDLE, taskId: 'midle000-0003', title: 'Idle sibling' },
    ],
    tasks: [
      { id: 'mlead000-0001', title: 'Leader', phase: 'IN_PROGRESS', project: 'Acme' },
      { id: 'mworker0-0002', title: 'Worker: fix the build', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: 'mlead000-0001' },
      { id: 'midle000-0003', title: 'Idle sibling', phase: 'TODO', project: 'Acme', parent_task_id: 'mlead000-0001' },
    ],
    requests: [],
    ...over,
  }
}

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })

function harness(opts: { relay?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-leader-'))
  dirs.push(dir)
  const delivered: Array<{ sid: string; text: string; messageId: string }> = []
  const relayed: Array<Record<string, unknown>> = []
  const relayFail = { reason: null as string | null }
  const live = new Set([WORKER])
  const clock = { now: Date.parse('2026-10-05T12:00:00Z') }
  const deps: OfflineHostDeps = {
    fs, path, dir,
    now: () => clock.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf: (home) => createHash('sha1').update(home).digest('hex').slice(0, 12),
    kit: createEnvelopeKit(),
    log: () => {},
    isLive: (sid) => live.has(sid),
    turnActive: () => false,
    streamOffset: () => 100,
    deliver: async (sid, text, messageId) => { delivered.push({ sid, text, messageId }); return { ok: true } },
    ...(opts.relay === false ? {} : {
      relay: async (_home: string, req: Record<string, unknown>) => {
        if (relayFail.reason) return { ok: false as const, reason: relayFail.reason }
        relayed.push(req)
        return { ok: true as const }
      },
    }),
  }
  const host = createOfflineHost(deps)
  host.configure(slice())
  return { host, delivered, relayed, relayFail, live, clock, deps }
}

function records(h: ReturnType<typeof harness>): OfflineRecord[] {
  return h.host.drain(HOME).records
}

const FROM = { sid: LEADER, taskId: 'mlead000-0001', title: 'Leader', host: 'devbox' }

describe('a peer message the leader routes here', () => {
  it('is delivered with the envelope the server builds, naming the sender\'s host, and its reply request is owned here', async () => {
    const h = harness()
    const r = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: 'mworker0-0002', text: 'Is the build green?', messageId: 'qm-route-1' })
    expect(r.ok).toBe(true)
    const result = (r as { result: Record<string, unknown> }).result
    expect(result).toMatchObject({ targetSessionId: WORKER, targetTaskId: 'mworker0-0002', messageId: 'qm-route-1', targetHost: 'oldbox' })
    const requestId = result.requestId as string
    expect(requestId).toMatch(/^rq-[a-f0-9]{12}$/)
    const expected = buildPeerWrapper('Is the build green?', {
      title: 'Leader', shortId: LEADER.slice(0, 8), sessionId: LEADER, taskId: 'mlead000-0001', host: 'devbox', requestId,
    })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].sid).toBe(WORKER)
    expect(h.delivered[0].text.startsWith(expected)).toBe(true)
    const recs = records(h)
    expect(recs.map((x) => x.kind)).toEqual(['row', 'delivery'])
    expect((recs[0] as Extract<OfflineRecord, { kind: 'row' }>).row).toMatchObject({ id: requestId, fromSessionId: LEADER, toSessionId: WORKER, fromHost: 'devbox', status: 'pending', afterV: 100 })
  })

  it('without expect_reply opens no request', async () => {
    const h = harness()
    const r = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: WORKER, text: 'FYI', expect_reply: false })
    expect(r.ok).toBe(true)
    expect((r as { result: Record<string, unknown> }).result.requestId).toBeUndefined()
    expect(records(h).map((x) => x.kind)).toEqual(['delivery'])
  })

  it('refuses a target that does not run here, and a sender messaging its COMPLETE parent', async () => {
    const h = harness()
    const idle = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: IDLE, text: 'hi' })
    expect(idle).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    h.host.configure(slice({ hash: 'h2', tasks: slice().tasks.map((t) => t.id === 'mworker0-0002' ? { ...t, phase: 'COMPLETE' } : t) }))
    // A subtask of the worker (on the leader's host) writing to its complete parent.
    h.host.configure(slice({
      hash: 'h3',
      tasks: [...slice().tasks.map((t) => t.id === 'mworker0-0002' ? { ...t, phase: 'COMPLETE' } : t),
        { id: 'msub0000-0009', title: 'Sub', phase: 'IN_PROGRESS', parent_task_id: 'mworker0-0002' }],
    }))
    const closed = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: { ...FROM, taskId: 'msub0000-0009' }, to: 'mworker0-0002', text: 'done' })
    expect(closed).toMatchObject({ ok: false, error: { code: 'parent_complete' } })
    expect(h.delivered).toHaveLength(0)
  })

  it('refuses malformed deliveries without writing anything', async () => {
    const h = harness()
    expect(await h.host.deliverFromLeader(HOME, { kind: 'peer', from: { sid: '', host: '' }, to: WORKER, text: 'x' } as never)).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: WORKER, text: '   ' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(await h.host.deliverFromLeader('/other', { kind: 'peer', from: FROM, to: WORKER, text: 'x' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(h.delivered).toHaveLength(0)
  })
})

describe('the answer goes back through the leader', () => {
  // No drain here: while the companion leads nobody drains, and a drain would
  // mark the row as being handed over (the notice then waits for the server).
  async function asked() {
    const h = harness()
    const r = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: WORKER, text: 'Is the build green?' })
    const requestId = (r as { result: Record<string, unknown> }).result.requestId as string
    const got = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'request_get', args: { id: requestId } })
    const row = (got as { result: { request: SessionRequest } }).result.request
    return { h, requestId, row }
  }

  it('a reply to a request from another host is relayed with the reply envelope and settles the row here', async () => {
    const { h, requestId, row } = await asked()
    const r = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'task_send', args: { in_reply_to: requestId, text: 'Green on main.' } })
    expect(r.ok).toBe(true)
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]).toMatchObject({ toHost: 'devbox', toSid: LEADER, requestId, reply: true, fromSessionId: WORKER })
    const expected = buildReplyDeliveryText(row,
      { title: 'Worker: fix the build', shortId: WORKER.slice(0, 8), host: 'oldbox', sessionId: WORKER, taskId: 'mworker0-0002' },
      'Green on main.',
    )
    expect(h.relayed[0].text).toBe(expected)
    expect(h.delivered).toHaveLength(1) // only the question, nothing written here for the answer
    // The settle is journaled here; the delivery is the asker's host's to journal.
    const recs = records(h).slice(2)
    expect(recs.map((x) => x.kind)).toEqual(['row'])
    expect((recs[0] as Extract<OfflineRecord, { kind: 'row' }>).row.status).toBe('replied')
  })

  it('a turn end without a reply relays the usual notice, quoting the turn\'s result', async () => {
    const { h, requestId } = await asked()
    await h.host.onResult(WORKER, JSON.stringify({ type: 'result', is_error: false, result: 'Built it, tests pass.' }), 200)
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]).toMatchObject({ toHost: 'devbox', toSid: LEADER, requestId, fromSessionId: WORKER })
    expect(String(h.relayed[0].text)).toContain('Built it, tests pass.')
    const recs = records(h).slice(2)
    expect(recs.map((x) => x.kind)).toEqual(['row'])
    expect((recs[0] as Extract<OfflineRecord, { kind: 'row' }>).row.status).toBe('notified')
  })

  it('a turn end at or before the delivery offset is an old turn, not an answer', async () => {
    const { h } = await asked()
    await h.host.onResult(WORKER, JSON.stringify({ type: 'result', result: 'old turn' }), 100)
    expect(h.relayed).toHaveLength(0)
  })

  it('with nobody leading, a reply to a remote asker says it needs the server and settles nothing', async () => {
    const { h, requestId } = await asked()
    h.relayFail.reason = 'no server leads this Walnut right now'
    const r = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'task_send', args: { in_reply_to: requestId, text: 'Green.' } })
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(records(h).slice(2)).toHaveLength(0)
  })

  it('a reply to a server-owned request whose asker runs elsewhere (a copy naming its host) travels the same way', async () => {
    const h = harness()
    h.host.configure(slice({
      hash: 'h9',
      requests: [{ id: 'rq-0a0b0c0d0e0f', fromSessionId: LEADER, toSessionId: WORKER, toTaskId: 'mworker0-0002', preview: 'status?', status: 'pending', createdAt: '2026-10-05T09:00:00Z', deadlineAt: Date.parse('2026-10-05T15:00:00Z'), fromHost: 'devbox' }],
    }))
    const r = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'task_send', args: { in_reply_to: 'rq-0a0b0c0d0e0f', text: 'All good.' } })
    expect(r.ok).toBe(true)
    expect(h.relayed[0]).toMatchObject({ toHost: 'devbox', toSid: LEADER, requestId: 'rq-0a0b0c0d0e0f' })
    expect(records(h)).toEqual([expect.objectContaining({ kind: 'settle', requestId: 'rq-0a0b0c0d0e0f' })])
  })

  it('a daemon with no leader relay keeps the old answer for a remote asker', async () => {
    const h = harness({ relay: false })
    const r = await h.host.deliverFromLeader(HOME, { kind: 'peer', from: FROM, to: WORKER, text: 'ping' })
    const requestId = (r as { result: Record<string, unknown> }).result.requestId as string
    const reply = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'task_send', args: { in_reply_to: requestId, text: 'pong' } })
    expect(reply).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
  })
})

describe('text the leader routes here', () => {
  it('is written as it is into a live session of this Walnut and journaled as a delivery', async () => {
    const h = harness()
    const text = '<walnut-message kind="reply">answer</walnut-message>'
    const r = await h.host.deliverFromLeader(HOME, { kind: 'text', toSid: WORKER, text, messageId: 'qm-t-1', requestId: 'rq-123456789abc', reply: true, fromSessionId: LEADER })
    expect(r.ok).toBe(true)
    expect(h.delivered).toEqual([{ sid: WORKER, text, messageId: 'qm-t-1' }])
    expect(records(h)).toEqual([expect.objectContaining({ kind: 'delivery', fromSessionId: LEADER, toSessionId: WORKER, requestId: 'rq-123456789abc', reply: true })])
  })

  it('refuses a session that is not this Walnut\'s, or not running', async () => {
    const h = harness()
    expect(await h.host.deliverFromLeader(HOME, { kind: 'text', toSid: 'eeeeeeee-0000-4000-8000-000000000000', text: 'x' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await h.host.deliverFromLeader(HOME, { kind: 'text', toSid: IDLE, text: 'x' })).toMatchObject({ ok: false, error: { code: 'not_running' } })
    expect(h.delivered).toHaveLength(0)
  })
})

describe('a send this host cannot deliver itself', () => {
  it('to a session on another host says it needs the server, so the daemon hands it to the leader', async () => {
    const h = harness()
    const r = await h.host.handle(HOME, WORKER, 'tools.call', { name: 'task_send', args: { to: 'mlead000-0001', text: 'done' } })
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
  })

  it('callerOf names the caller the way the copy does, for the leader\'s envelope', () => {
    const h = harness()
    expect(h.host.callerOf(HOME, WORKER)).toEqual({ taskId: 'mworker0-0002', title: 'Worker: fix the build', host: 'oldbox' })
  })
})
