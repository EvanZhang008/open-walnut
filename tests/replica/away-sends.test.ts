/**
 * The follower's own rules for a message from this host (replica/away-sends.ts, away-replies.ts),
 * beside the daemon parity (away-sends-parity.test.ts): a daemon without `follower.peer` hands the
 * call back; the message id comes from the call id, as the daemon's and the Mac's do; a note that
 * asks nothing opens no request; an ambiguous prefix is refused; one answer to several askers
 * holds nothing once the first is sent; a plugin job's plain note keeps its path (it moved here
 * from away-starts.ts unchanged).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { awaySends, callIdOfOpId, sendMessageIdOf, type AwaySendsDeps } from '../../src/replica/away-sends.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import type { PortAnswer, WriteActor, WritePort } from '../../src/replica/write-port.js'
import { writeOpId } from '../../src/lib/op-call-id.js'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme', job: 'sync' }
const OP = writeOpId('oc-feedfacefeedface', 'POST', '/messages', 0)

function harness(over: Partial<AwaySendsDeps> = {}, o: { actor?: WriteActor; peer?: (p: Record<string, unknown>) => ReplicaWriteResult; pending?: unknown[] } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const sends: Array<{ sid: string; text: string }> = []
  const tasks: Record<string, Record<string, unknown>> = {
    ta: { id: 'ta', title: 'Lead' }, tb: { id: 'tb', title: 'Worker', parent_task_id: 'ta' }, tc: { id: 'tc', title: 'Other worker', parent_task_id: 'ta' },
    t3: { id: 't3', title: 'Has a session here' },
  }
  const deps: AwaySendsDeps = {
    port: { send: async (_w: ReplicaWrite, sid: string, text: string): Promise<PortAnswer> => { sends.push({ sid, text }); return { answered: false, status: 202, body: { delivered: true, messageId: 'qm-1', offline: true } } } } as unknown as WritePort,
    actorOf: () => o.actor ?? { kind: 'session', sid: B },
    task: async (id) => (tasks[id] ? { ...tasks[id], id } as never : null),
    findTask: async (ref) => (tasks[ref] ? { task: { ...tasks[ref], id: ref } as never } : ref === 'tamb' ? { ambiguous: true } : {}),
    session: async () => null,
    requestCopy: async () => null,
    goesUp: async (from, to) => tasks[from ?? '']?.parent_task_id === to,
    retiredLead: async () => null,
    hostKey: 'devbox',
    capabilities: () => ['journal-v2', 'follower-peer-v1'],
    request: async (cmd) => (cmd === 'follower.pending'
      ? { records: o.pending ?? [] }
      : { host: 'devbox', sessions: [{ sid: A, taskId: 'ta', taskTitle: 'Lead', state: 'idle' }, { sid: B, taskId: 'tb', taskTitle: 'Worker', state: 'working' }, { sid: C, taskId: 'tc', taskTitle: 'Other worker', state: 'idle' }] }),
    leaderAnswers: () => false,
    frame: async (text) => `[framed] ${text}`,
    sessionsOfTask: async (id) => (id === 't3' ? [{ sid: 'sid-3', host: 'devbox', startedAt: '2026-11-18T00:00:00Z' }] : []),
    log: () => {},
    ...over,
  }
  const handler = awaySends(deps)
  async function post(body: Record<string, unknown>, opId = OP): Promise<{ status: number; body: any }> {
    const w: ReplicaWrite = {
      opId, away: 'host-write', raw: Buffer.from(''), submit: vi.fn(),
      call: async (cmd, params) => {
        calls.push({ cmd, ...params })
        return o.peer ? o.peer(params) : { kind: 'applied', reply: { delivered: true, messageId: params.messageId, targetSessionId: params.toSessionId, ...(params.ask ? { requestId: (params.ask as { id: string }).id } : {}) } }
      },
    }
    return new Promise((resolve, reject) => {
      const req = { method: 'POST', path: '/v1/messages', body, replicaWrite: w, headers: {} } as unknown as Request
      let status = 0
      const res = {
        headersSent: false, setHeader: () => {},
        status(s: number) { status = s; return this },
        json(b: unknown) { resolve({ status, body: b }); return this },
      } as unknown as Response
      handler(req, res, () => reject(new Error('passed on')))
    })
  }
  return { post, calls, sends }
}

describe('a message from this host, the follower\'s own rules', () => {
  it('the message id is the call\'s, as the daemon and the Mac pick it; the caller\'s own wins', () => {
    expect(callIdOfOpId(OP)).toBe('oc-feedfacefeedface')
    expect(callIdOfOpId('oc-feedfacefeedface-0a1b2c3d-0')).toBeNull()
    expect(sendMessageIdOf(undefined, OP)).toBe('qm-host-feedfacefeedface')
    expect(sendMessageIdOf('qm-mine-1', OP)).toBe('qm-mine-1')
    expect(sendMessageIdOf(undefined, 'op-minted-1')).toBe('qm-op-minted-1')
  })

  it('an implicit ask across the team opens a request; a note that asks nothing (wake false) or reports up opens none', async () => {
    const h = harness()
    expect((await h.post({ to: 'tc', text: 'take this' })).body).toMatchObject({ delivery: 'queued', requestId: expect.stringMatching(/^rq-[a-f0-9]{12}$/), messageId: 'qm-host-feedfacefeedface' })
    await h.post({ to: 'tc', text: 'fyi', wake: false })
    await h.post({ to: 'ta', text: 'done here' })
    expect(h.calls.map((c) => [c.toSessionId, !!c.ask])).toEqual([[C, true], [C, false], [A, false]])
    expect(h.calls[0]).toMatchObject({ cmd: 'follower.peer', kind: 'send', online: false, fromSessionId: B, toTaskId: 'tc', ask: { secs: 6 * 3600, preview: 'take this' } })
    expect(String(h.calls[0]!.text)).toContain('request="')
    expect((await h.post({ to: 'tc', text: 'x', wake: false, expect_reply: true })).body.error).toMatchObject({ code: 'bad_request' })
  })

  it('an ambiguous prefix is refused; an answer for the user is the Mac\'s', async () => {
    const h = harness()
    expect((await h.post({ to: 'tamb', text: 'x' })).body.error).toMatchObject({ code: 'ambiguous_peer' })
    expect((await h.post({ to: 'tc', text: 'x', answers_ask: true })).body.error).toMatchObject({ code: 'needs_leader', why: 'server_delivers' })
    expect((await h.post({ to: 'tc', text: 'x', withdraw_ask: true })).body.error).toMatchObject({ code: 'bad_request' })
    expect(h.calls).toEqual([])
  })

  it('a daemon without follower.peer: the call goes back, the daemon answers it itself as before', async () => {
    const h = harness({ capabilities: () => ['journal-v2', 'follower-gateway-v1'] })
    expect((await h.post({ to: 'tc', text: 'x' })).body.error).toMatchObject({ code: 'needs_leader', why: 'daemon_needs_upgrade' })
    expect(h.calls).toEqual([])
  })

  it('the daemon\'s refusal is the route\'s (a full journal, the brake)', async () => {
    const h = harness({}, { peer: () => ({ kind: 'refused', code: 'queue_full', message: 'full', retryAfterMs: 60_000 }) })
    const r = await h.post({ to: 'tc', text: 'x' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'queue_full', retryAfter: 60 })
  })

  it('one answer to two askers: the second asker not running here is told as not settled, never held once the first went', async () => {
    const row = (id: string, from: string) => ({ kind: 'row', seq: 1, row: { id, fromSessionId: from, toSessionId: B, toTaskId: 'tb', preview: 'p', status: 'pending' } })
    const h = harness({}, { pending: [row('rq-aaaaaa000001', A), row('rq-aaaaaa000002', 'ffffffff-0000-4000-8000-000000000000')] })
    const r = await h.post({ in_reply_to: ['rq-aaaaaa000001', 'rq-aaaaaa000002'], text: 'both done' })
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ repliedTo: 'rq-aaaaaa000001', answered: ['rq-aaaaaa000001'], notAnswered: ['rq-aaaaaa000002'] })
    expect(h.calls.map((c) => c.kind)).toEqual(['reply'])
    expect(h.calls[0]).toMatchObject({ toSessionId: A, requestId: 'rq-aaaaaa000001', messageId: 'qm-host-feedfacefeedface' })
  })

  it('an answer to a request this host does not hold is held for the Mac, the whole call', async () => {
    const h = harness()
    await h.post({ in_reply_to: 'rq-abcdef000000', text: 'late answer' })
    expect(h.calls).toEqual([expect.objectContaining({ kind: 'hold', fromSessionId: B, callId: 'oc-feedfacefeedface', args: { in_reply_to: 'rq-abcdef000000', text: 'late answer', messageId: 'qm-host-feedfacefeedface' } })])
  })
})

describe('a plugin job\'s message keeps its path (moved from away-starts.ts)', () => {
  it('a message to a task whose session runs here is delivered, framed as its sender\'s', async () => {
    const h = harness({}, { actor: JOB })
    const r = await h.post({ to: 't3', text: 'tags changed' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ delivered: true, targetTaskId: 't3', targetSessionId: 'sid-3' })
    expect(h.sends).toEqual([{ sid: 'sid-3', text: '[framed] tags changed' }])
  })

  it('a message to a task with no session here, or one that asks for a reply, needs the Mac', async () => {
    const h = harness({}, { actor: JOB })
    expect((await h.post({ to: 'ta', text: 'hi' })).body.error).toMatchObject({ code: 'needs_leader', why: 'session_on_mac' })
    expect((await h.post({ to: 't3', text: 'hi', expect_reply: true })).body.error).toMatchObject({ why: 'reply_needs_mac' })
    expect((await h.post({ to: 't3', text: 'hi', in_reply_to: 'rq-abcdef' })).body.error).toMatchObject({ why: 'message_needs_mac' })
    expect(h.sends).toEqual([])
  })

  it('a device never sends here', async () => {
    const h = harness({}, { actor: { kind: 'device', deviceId: 'd1' } })
    expect((await h.post({ to: 't3', text: 'x' })).body.error).toMatchObject({ code: 'needs_leader' })
    expect(h.sends).toEqual([])
  })
})
