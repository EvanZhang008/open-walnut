/**
 * What the cloud companion answers for a host while it leads
 * (src/core/leader/backup-gateway.ts): the edges of one frame. The full story
 * across two hosts is tests/core/leader-cluster-sim.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { createBackupGateway, bridgeAliasOf, LEADER_OPS, type BackupGatewayDeps, type GatewayRequestFrame } from '../../src/core/leader/backup-gateway.js'
import type { BackupLeader } from '../../src/core/leader/backup-leader.js'

const W = 'wprimary0001'
const CALLER = 'aaaaaaaa-1111-4111-8111-111111111111'

function harness(over: Partial<BackupGatewayDeps> = {}, leads: Record<string, number> = { devbox: 2, oldbox: 2 }) {
  const lost: string[] = []
  const leader = {
    leadFor: (h: string) => (leads[h] ? { walnutId: W, epoch: leads[h] } : null),
    lostHost: (h: string) => { lost.push(h); delete leads[h] },
  } as unknown as BackupLeader
  const sent: Array<{ host: string; cmd: string; params: Record<string, any> }> = []
  const delivers: Array<Record<string, any>> = []
  let deliverAnswer: Record<string, unknown> = { ok: true, result: { requestId: 'rq-0123456789ab', targetSessionId: 'x' } }
  const gw = createBackupGateway({
    leader,
    request: async (host, cmd, params) => {
      sent.push({ host, cmd, params })
      if (cmd === 'leader.deliver') { delivers.push({ host, ...params }); return deliverAnswer }
      return { ok: true }
    },
    sessions: async () => [
      { id: 'bbbbbbbb-0000-4000-8000-000000000001', host: 'oldbox', task_id: 'mtaskbbb-0002', title: 'Older', process_status: 'idle', last_active_at: '2026-10-05T08:00:00Z' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', host: 'oldbox', task_id: 'mtaskbbb-0002', title: 'Newer', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000003', host: 'oldbox', task_id: 'mtaskbbb-0002', title: 'Newest but stopped', process_status: 'stopped', last_active_at: '2026-10-05T11:30:00Z' },
      { id: CALLER, host: 'devbox', task_id: 'mtaskaaa-0001', title: 'Me', process_status: 'running' },
      { id: 'cccccccc-0000-4000-8000-000000000001', host: 'local', task_id: 'mtaskmac-0003', title: 'On the Mac', process_status: 'idle' },
    ],
    findTask: async (ref) => {
      const tasks = [{ id: 'mtaskaaa-0001', title: 'Me' }, { id: 'mtaskbbb-0002', title: 'Fix the build' }, { id: 'mtaskmac-0003', title: 'Mac work' }, { id: 'mtaskdup-0004', title: 'Dup 1' }, { id: 'mtaskdup-0005', title: 'Dup 2' }]
      const hits = tasks.filter((t) => t.id === ref || t.id.startsWith(ref))
      return hits.length === 1 ? hits[0] : hits.length > 1 ? { ambiguous: hits.length } : null
    },
    executeOp: async (name, args) => ({ ok: true, result: { name, args } }),
    ...over,
  })
  const frame = (payload: Record<string, unknown>, extra: Partial<GatewayRequestFrame> = {}): GatewayRequestFrame => ({
    relayId: 7, capability: 'tools.call', callerSid: CALLER, payload, walnutId: W, epoch: 2,
    caller: { taskId: 'mtaskaaa-0001', title: 'Me', host: 'devbox' }, ...extra,
  })
  const answer = () => sent.filter((s) => s.cmd === 'gateway-result').at(-1)?.params
  return { gw, sent, delivers, lost, frame, answer, setDeliverAnswer: (a: Record<string, unknown>) => { deliverAnswer = a } }
}

describe('backup gateway', () => {
  it('routes a send to the newest live session of the task, naming the sender and its host', async () => {
    const h = harness()
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb', text: 'status?', expect_reply: true, reply_timeout: 600 } }))
    expect(h.delivers).toHaveLength(1)
    expect(h.delivers[0]).toMatchObject({
      host: 'oldbox', walnutId: W, epoch: 2,
      delivery: { kind: 'peer', to: 'bbbbbbbb-0000-4000-8000-000000000002', text: 'status?', expect_reply: true, reply_timeout: 600, from: { sid: CALLER, taskId: 'mtaskaaa-0001', title: 'Me', host: 'devbox' } },
    })
    expect(h.answer()).toMatchObject({ relayId: 7, result: { viaLeader: true, requestId: 'rq-0123456789ab' } })
    expect(h.answer()!.result.outcome).toContain('"Fix the build" on oldbox')
  })

  it('a task\'s current session gets the message over a newer one, as on the server, unless it is stopped', async () => {
    const withSlot = (sessionId: string) => harness({
      findTask: async (ref) => (ref === 'mtaskbbb-0002' ? { id: 'mtaskbbb-0002', title: 'Fix the build', sessionId } : null),
    })
    const h = withSlot('bbbbbbbb-0000-4000-8000-000000000001')
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb-0002', text: 'status?' } }))
    expect(h.delivers[0].delivery.to).toBe('bbbbbbbb-0000-4000-8000-000000000001')
    // A current session that is stopped: the newest live one.
    const stopped = withSlot('bbbbbbbb-0000-4000-8000-000000000003')
    await stopped.gw.handle('devbox', stopped.frame({ name: 'task_send', args: { to: 'mtaskbbb-0002', text: 'status?' } }))
    expect(stopped.delivers[0].delivery.to).toBe('bbbbbbbb-0000-4000-8000-000000000002')
  })

  it('answers every refusal back to the host with gateway-result, never silence', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: 'task_send', args: { to: 'mtaskdup', text: 'x' } }, 'ambiguous_peer'],
      [{ name: 'task_send', args: { to: 'mnothing-0000', text: 'x' } }, 'unknown_peer'],
      [{ name: 'task_send', args: { to: 'mtaskaaa-0001', text: 'x' } }, 'self_send'],
      [{ name: 'task_send', args: { text: 'x' } }, 'bad_request'],
      [{ name: 'task_send', args: { to: 'mtaskbbb-0002', text: '  ' } }, 'bad_request'],
      [{ name: 'task_send', args: { in_reply_to: 'rq-0123456789ab', text: 'x' } }, 'hub_unreachable'],
      [{ name: 'session_start', args: {} }, 'hub_unreachable'],
      [{ name: 'task_get', argsFile: '/tmp/x' }, 'hub_unreachable'],
    ]
    for (const [payload, code] of cases) {
      const h = harness()
      await h.gw.handle('devbox', h.frame(payload))
      expect(h.answer(), JSON.stringify(payload)).toMatchObject({ relayId: 7, errorCode: code })
      expect(h.delivers).toHaveLength(0)
    }
  })

  it('a task whose sessions are all stopped, or that runs on the Mac, needs the Mac', async () => {
    const h = harness({
      sessions: async () => [{ id: 'bbbbbbbb-0000-4000-8000-000000000003', host: 'oldbox', task_id: 'mtaskbbb-0002', process_status: 'stopped' }],
    })
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb-0002', text: 'x' } }))
    expect(h.answer()).toMatchObject({ errorCode: 'hub_unreachable' })
    const mac = harness()
    await mac.gw.handle('devbox', mac.frame({ name: 'task_send', args: { to: 'mtaskmac-0003', text: 'x' } }))
    expect(mac.answer()).toMatchObject({ errorCode: 'hub_unreachable' })
    expect(mac.answer()!.error).toContain('Walnut server')
  })

  it('refuses a frame from a host it does not lead, or at another epoch or Walnut', async () => {
    for (const extra of [{ epoch: 1 }, { epoch: 3 }, { walnutId: 'wsomeoneelse' }]) {
      const h = harness()
      await h.gw.handle('devbox', h.frame({ name: 'task_get', args: { id: 'x' } }, extra))
      expect(h.answer()).toMatchObject({ errorCode: 'hub_unreachable' })
    }
    const notLed = harness({}, { oldbox: 2 })
    await notLed.gw.handle('devbox', notLed.frame({ name: 'task_get', args: { id: 'x' } }))
    expect(notLed.answer()).toMatchObject({ errorCode: 'hub_unreachable' })
  })

  it('a target host that answers stale or not-leader is let go, and the sender hears the server is needed', async () => {
    for (const kind of ['stale_epoch', 'not_leader']) {
      const h = harness()
      h.setDeliverAnswer({ ok: false, error: 'not the leader', errorKind: kind })
      await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb-0002', text: 'x' } }))
      expect(h.lost).toEqual(['oldbox'])
      expect(h.answer()).toMatchObject({ errorCode: 'hub_unreachable' })
    }
    // Any other refusal is the target host's own answer, passed through.
    const h = harness()
    h.setDeliverAnswer({ ok: false, error: 'parent is complete', errorKind: 'parent_complete', detail: { parentTaskId: 'p' } })
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb-0002', text: 'x' } }))
    expect(h.lost).toEqual([])
    expect(h.answer()).toMatchObject({ errorCode: 'parent_complete', error: 'parent is complete', detail: { parentTaskId: 'p' } })
  })

  it('leader.deliverText goes to the asker\'s host as text', async () => {
    const h = harness()
    await h.gw.handle('oldbox', h.frame({ toHost: 'devbox', toSid: CALLER, text: 'the answer', messageId: 'qm-1', requestId: 'rq-1', reply: true, fromSessionId: 'b' }, { capability: 'leader.deliverText' }))
    expect(h.delivers[0]).toMatchObject({ host: 'devbox', delivery: { kind: 'text', toSid: CALLER, text: 'the answer', messageId: 'qm-1', requestId: 'rq-1', reply: true, fromSessionId: 'b' } })
    const bad = harness()
    await bad.gw.handle('oldbox', bad.frame({ toSid: CALLER, text: 'x' }, { capability: 'leader.deliverText' }))
    expect(bad.answer()).toMatchObject({ errorCode: 'bad_request' })
  })

  it('runs the replica ops (and only those) with the caller and its host', async () => {
    const calls: Array<[string, Record<string, unknown>, { callerSid: string; callerHost: string }]> = []
    const h = harness({ executeOp: async (name, args, ctx) => { calls.push([name, args, ctx]); return name === 'task_complete' ? { ok: false, message: 'refused: no such task' } : { ok: true, result: [1, 2] } } })
    await h.gw.handle('devbox', h.frame({ name: 'note_read', args: { path: 'x.md' } }))
    expect(calls).toEqual([['note_read', { path: 'x.md' }, { callerSid: CALLER, callerHost: 'devbox' }]])
    expect(h.answer()).toMatchObject({ result: { value: [1, 2], viaLeader: true } })
    await h.gw.handle('devbox', h.frame({ name: 'task_complete', args: { id: 'x' } }))
    expect(h.answer()).toMatchObject({ errorCode: 'internal', error: 'refused: no such task' })
    expect(LEADER_OPS).not.toContain('session_start')
  })

  it('a frame without a relay id is dropped (nothing to answer), and a throwing dependency still answers', async () => {
    const h = harness({ sessions: async () => { throw new Error('projection unreadable') } })
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'x', text: 'y' } }, { relayId: undefined }))
    expect(h.sent).toHaveLength(0)
    await h.gw.handle('devbox', h.frame({ name: 'task_send', args: { to: 'mtaskbbb', text: 'y' } }))
    expect(h.answer()).toMatchObject({ errorCode: 'internal', error: 'projection unreadable' })
  })

  it('names the primary\'s own host by its bridge alias', () => {
    expect(bridgeAliasOf('local')).toBe('__local__')
    expect(bridgeAliasOf('')).toBe('__local__')
    expect(bridgeAliasOf('devbox')).toBe('devbox')
  })
})
