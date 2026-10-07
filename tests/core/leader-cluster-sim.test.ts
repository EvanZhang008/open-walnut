/**
 * "The Mac is gone and the cloud companion takes over", simulated in one
 * process with every piece of logic real:
 *
 *   session A (devbox) ──gateway──► devbox daemon ─┐                ┌─► oldbox daemon ──► session B
 *                                    offline host   │   companion     │    offline host
 *                                    leader book    └─► backup leader ┘    leader book
 *                                                       backup gateway
 *
 * Real: the offline hosts (offline-host-core.ts), the leader books
 * (leader-core.ts), the companion's decision loop (backup-leader.ts) and its
 * gateway (backup-gateway.ts), the envelope builders. Simulated: the sockets
 * (direct calls), the FIFO write into a session (a recorder), the clock (one
 * number), and the daemon's glue, which mirrors daemon-standalone.ts
 * (sendGatewayRequest / forwardToBackup / cmdLeaderDeliver / cmdGatewayResult)
 * in a few lines. tests/integration/leader-takeover-twins.test.ts runs the same
 * story on the real daemon processes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineHost, type HostSlice, type LeaderDelivery, type OfflineRecord } from '../../src/providers/offline-host-core.js'
import { createLeaderBook } from '../../src/providers/leader-core.js'
import { createBoardOffline } from '../../src/providers/offline-board-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createBackupLeader } from '../../src/core/leader/backup-leader.js'
import { createBackupGateway, type GatewayRequestFrame } from '../../src/core/leader/backup-gateway.js'

const HOME = '/fixture/walnut-home'
const WALNUT = 'wprimary0001'
const T = 60_000
const A = 'aaaaaaaa-1111-4111-8111-111111111111' // leader session, devbox
const B = 'bbbbbbbb-2222-4222-8222-222222222222' // worker session, oldbox
const M = 'dddddddd-4444-4444-8444-444444444444' // a session on the Mac itself
const TASK_A = 'mleadaaa-0001'
const TASK_B = 'mworkbbb-0002'
const TASK_M = 'mmacmmm0-0003'
const TASK_FAR = 'mfarfar0-0009' // in no host's copy

const TASKS = [
  { id: TASK_A, title: 'Leader: ship the release', phase: 'IN_PROGRESS', project: 'Acme' },
  { id: TASK_B, title: 'Worker: fix the build', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
]

type GatewayResult = { ok: true; result: Record<string, any> } | { ok: false; error: { code: string; message: string; detail?: unknown } }

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sim-')); dirs.push(d); return d }

function simulate() {
  const clock = { now: Date.parse('2026-10-05T12:00:00Z') }
  const keyOf = (h: string) => createHash('sha1').update(h).digest('hex').slice(0, 12)
  type Daemon = ReturnType<typeof makeDaemon>
  const daemons = new Map<string, Daemon>()
  const executed: Array<{ name: string; args: Record<string, unknown>; ctx: { callerSid: string; callerHost: string } }> = []

  function makeDaemon(name: string, live: string[], sessions: HostSlice['sessions']) {
    const delivered: Array<{ sid: string; text: string; messageId: string }> = []
    const pending = new Map<number, (r: GatewayResult) => void>()
    let relayCounter = 0
    let bridgeUp = true
    const book = createLeaderBook({ fs, path, dir: tmp(), now: () => clock.now, keyOf, log: () => {}, takeoverMs: T, bootAt: clock.now })
    // daemon-standalone.ts forwardToBackup: only while the companion leads this home.
    function forwardToBackup(capability: string, callerSid: string, payload: Record<string, unknown>, respond: (r: GatewayResult) => void): boolean {
      const lead = book.backupLead(HOME)
      if (!lead || !bridgeUp) return false
      const relayId = ++relayCounter
      pending.set(relayId, respond)
      const frame: GatewayRequestFrame = {
        relayId, capability, callerSid, payload, walnutId: lead.walnutId, epoch: lead.epoch,
        caller: callerSid ? host.callerOf(HOME, callerSid) : undefined,
      }
      void gateway.handle(name, frame)
      return true
    }
    const host = createOfflineHost({
      fs, path, dir: tmp(), now: () => clock.now,
      randomHex: (n) => randomBytes(n).toString('hex'), keyOf,
      kit: createEnvelopeKit(), log: () => {},
      isLive: (sid) => live.includes(sid),
      turnActive: () => false,
      streamOffset: () => 0,
      deliver: async (sid, text, messageId) => { delivered.push({ sid, text, messageId }); return { ok: true } },
      boards: createBoardOffline(),
      relay: (_home, req) => new Promise((resolve) => {
        const sent = forwardToBackup('leader.deliverText', req.fromSessionId ?? '', req as unknown as Record<string, unknown>, (r) => resolve(r.ok ? { ok: true } : { ok: false, reason: r.error.message }))
        if (!sent) resolve({ ok: false, reason: 'no server leads this Walnut right now' })
      }),
    })
    host.configure({
      v: 1, home: HOME, hash: 'h1', asOf: clock.now, host: name, sessions, tasks: TASKS, requests: [],
      // The team's Board rides every host's copy (host-slice.ts teamBoards).
      boards: [{ taskId: TASK_A, html: '<h1>Release</h1><p id="build">Build: red</p>', version: 1 }],
      boardOf: { [TASK_A]: TASK_A, [TASK_B]: TASK_A },
    })
    book.configure({ home: HOME, walnutId: WALNUT, backup: true })
    return {
      name, book, host, delivered, live,
      setBridge(up: boolean) { bridgeUp = up },
      /** A session's `walnut tools call` on this host (the Mac is away: no trusted target). */
      gatewayCall(sid: string, op: string, args: Record<string, unknown>): Promise<GatewayResult> {
        return new Promise((resolve) => {
          void host.handle(HOME, sid, 'tools.call', { name: op, args }).then((r) => {
            if (!r.ok && r.error.code === 'hub_unreachable' && forwardToBackup('tools.call', sid, { name: op, args }, resolve)) return
            resolve(r as GatewayResult)
          })
        })
      },
      /** A command arriving over this host's bridge, answered in the daemon's shape. */
      async bridge(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (!bridgeUp) throw new Error(`bridge to ${name} is down`)
        if (cmd === 'leader.witness') return { ok: true, walnuts: book.witness(() => true), takeoverMs: T }
        if (cmd === 'leader.claim') {
          const r = book.backupClaim(params.walnutId, params.epoch)
          return r.ok ? { ok: true, epoch: r.record.epoch, holder: r.record.holder } : { ok: false, error: r.message, errorKind: r.code, epoch: r.epoch }
        }
        if (cmd === 'leader.deliver') {
          const f = book.fence(params.walnutId, params.epoch)
          if (!f.ok) return { ok: false, error: f.message, errorKind: f.code, epoch: f.epoch }
          const r = await host.deliverFromLeader(f.home, params.delivery as LeaderDelivery)
          return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error.message, errorKind: r.error.code, detail: r.error.detail }
        }
        if (cmd === 'gateway-result') {
          const respond = pending.get(params.relayId as number)
          if (!respond) return { ok: true, stale: true }
          pending.delete(params.relayId as number)
          respond(params.error ? { ok: false, error: { code: String(params.errorCode ?? 'internal'), message: String(params.error), ...(params.detail !== undefined ? { detail: params.detail } : {}) } } : { ok: true, result: params.result as Record<string, any> })
          return { ok: true }
        }
        return { ok: false, error: `bridge: command not allowed: ${cmd}` }
      },
      records(): OfflineRecord[] { return host.drain(HOME).records },
    }
  }

  const request = (h: string, cmd: string, params: Record<string, unknown>) => {
    const d = daemons.get(h)
    if (!d) return Promise.reject(new Error(`no bridge to ${h}`))
    return d.bridge(cmd, params)
  }
  const leader = createBackupLeader({ now: () => clock.now, takeoverMs: T, hosts: () => ['__local__', ...daemons.keys()], request, stateFile: null })
  // The session list the primary last pushed to the companion (the projection).
  const projection = [
    { id: A, host: 'devbox', task_id: TASK_A, title: 'Leader', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
    { id: B, host: 'oldbox', task_id: TASK_B, title: 'Worker', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
    { id: M, host: 'local', task_id: TASK_M, title: 'On the Mac', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
  ]
  const allTasks = [...TASKS, { id: TASK_M, title: 'On the Mac' }, { id: TASK_FAR, title: 'Far away' }]
  const gateway = createBackupGateway({
    leader, request,
    sessions: async () => projection,
    findTask: async (ref) => {
      const hits = allTasks.filter((t) => t.id === ref || (ref.length >= 4 && t.id.startsWith(ref)))
      return hits.length === 1 ? { id: hits[0].id, title: hits[0].title } : hits.length > 1 ? { ambiguous: hits.length } : null
    },
    executeOp: async (name, args, ctx) => { executed.push({ name, args, ctx }); return { ok: true, result: { id: args.id, applied: true } } },
  })

  daemons.set('devbox', makeDaemon('devbox', [A], [{ sid: A, taskId: TASK_A, title: 'Leader: ship the release' }]))
  daemons.set('oldbox', makeDaemon('oldbox', [B], [{ sid: B, taskId: TASK_B, title: 'Worker: fix the build' }]))
  const devbox = daemons.get('devbox')!
  const oldbox = daemons.get('oldbox')!

  function primaryAlive() {
    leader.noteHeartbeat({ walnutId: WALNUT })
    for (const d of daemons.values()) d.book.noteHeard(HOME)
  }
  async function pass(ms: number, opts: { primaryAlive?: boolean } = {}) {
    for (let t = 0; t < ms; t += 5_000) {
      clock.now += 5_000
      if (opts.primaryAlive) primaryAlive()
      await leader.tick()
    }
  }
  return { clock, leader, devbox, oldbox, executed, primaryAlive, pass, projection }
}

describe('the Mac is gone and the cloud companion takes over (simulated cluster)', () => {
  it('while the Mac is up the companion leads nothing and a send between hosts still needs the Mac', async () => {
    const s = simulate()
    await s.pass(5 * T, { primaryAlive: true })
    expect(s.leader.isLeading()).toBe(false)
    const r = await s.devbox.gatewayCall(A, 'task_send', { to: TASK_B, text: 'status?' })
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(s.oldbox.delivered).toHaveLength(0)
  })

  it('takes over, carries a message and its answer between two hosts, and the Mac takes it all back', async () => {
    const s = simulate()
    s.primaryAlive()
    await s.pass(T + 10_000) // the Mac sleeps: no heartbeat, no frames
    expect(s.leader.status().leading.map((l) => `${l.host}@${l.epoch}`).sort()).toEqual(['devbox@2', 'oldbox@2'])

    // A on devbox asks B on oldbox.
    const sent = await s.devbox.gatewayCall(A, 'task_send', { to: TASK_B, text: 'Is the build green?' }) as Extract<GatewayResult, { ok: true }>
    expect(sent.ok).toBe(true)
    expect(sent.result).toMatchObject({ viaLeader: true, targetSessionId: B, targetHost: 'oldbox' })
    expect(sent.result.outcome).toContain('through the cloud companion')
    const requestId = sent.result.requestId as string
    expect(requestId).toMatch(/^rq-/)
    expect(s.oldbox.delivered).toHaveLength(1)
    const envelope = s.oldbox.delivered[0].text
    expect(envelope).toContain('Is the build green?')
    expect(envelope).toContain('devbox') // the sender's host, so B knows where the asker runs
    expect(envelope).toContain(requestId)

    // B answers; the answer travels back through the companion into A.
    const replied = await s.oldbox.gatewayCall(B, 'task_send', { in_reply_to: requestId, text: 'Green on main.' })
    expect(replied.ok).toBe(true)
    expect(s.devbox.delivered).toHaveLength(1)
    expect(s.devbox.delivered[0].text).toContain('Green on main.')
    expect(s.devbox.delivered[0].text).toContain(requestId)

    // A task outside every host's copy: the companion runs it on its replica.
    const far = await s.devbox.gatewayCall(A, 'task_update', { id: TASK_FAR, note: 'checked' })
    expect(far).toMatchObject({ ok: true, result: { applied: true, viaLeader: true } })
    expect(s.executed).toEqual([{ name: 'task_update', args: { id: TASK_FAR, note: 'checked' }, ctx: { callerSid: A, callerHost: 'devbox' } }])

    // A session on the Mac itself cannot be reached while the Mac is away.
    expect(await s.devbox.gatewayCall(A, 'task_send', { to: TASK_M, text: 'hi' })).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    // Nor can what only the Mac answers.
    expect(await s.devbox.gatewayCall(A, 'session_start', { task: TASK_B })).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })

    // ── The Mac wakes. It drains each host, then takes the lead back. ──
    const oldboxRecords = s.oldbox.records()
    expect(oldboxRecords.map((r) => r.kind)).toEqual(['row', 'delivery', 'row'])
    expect(oldboxRecords[0]).toMatchObject({ kind: 'row', row: { id: requestId, fromSessionId: A, toSessionId: B, fromHost: 'devbox', status: 'pending' } })
    expect(oldboxRecords[2]).toMatchObject({ kind: 'row', row: { id: requestId, status: 'replied' } })
    const devboxRecords = s.devbox.records()
    expect(devboxRecords).toEqual([expect.objectContaining({ kind: 'delivery', toSessionId: A, fromSessionId: B, requestId, reply: true })])

    s.leader.noteHeartbeat({ walnutId: WALNUT })
    expect(s.devbox.book.primaryClaim(HOME)).toMatchObject({ holder: 'primary', epoch: 3 })
    // Before the companion's next look, it still thinks it leads devbox at epoch 2:
    // a message it routes there is refused by the epoch, and it lets devbox go.
    expect(s.leader.leadFor('devbox')).toEqual({ walnutId: WALNUT, epoch: 2 })
    const fenced = await s.oldbox.gatewayCall(B, 'task_send', { to: TASK_A, text: 'late news' })
    expect(fenced).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(s.devbox.delivered).toHaveLength(1)
    expect(s.leader.leadFor('devbox')).toBeNull()
    await s.pass(5_000)
    expect(s.leader.status().leading.map((l) => l.host)).toEqual(['oldbox'])
    expect(s.oldbox.book.primaryClaim(HOME)).toMatchObject({ epoch: 3 })
    await s.pass(5_000)
    expect(s.leader.isLeading()).toBe(false)
  })

  it('a turn that ends without an answer sends the asker the usual notice, across hosts', async () => {
    const s = simulate()
    s.primaryAlive()
    await s.pass(T + 10_000)
    const sent = await s.devbox.gatewayCall(A, 'task_send', { to: TASK_B, text: 'Please run the tests.' }) as Extract<GatewayResult, { ok: true }>
    await s.oldbox.host.onResult(B, JSON.stringify({ type: 'result', is_error: false, result: 'Ran them: 3 failures in parser.' }), 10)
    expect(s.devbox.delivered).toHaveLength(1)
    expect(s.devbox.delivered[0].text).toContain('Ran them: 3 failures in parser.')
    expect(s.devbox.delivered[0].text).toContain(sent.result.requestId)
  })

  it('a link-only cut (the Mac is up, only its link to the companion is down) takes nothing over', async () => {
    const s = simulate()
    for (let t = 0; t < 5 * T; t += 5_000) {
      s.clock.now += 5_000
      // The heartbeat no longer reaches the companion, but the hosts still hear the Mac.
      s.devbox.book.noteHeard(HOME)
      s.oldbox.book.noteHeard(HOME)
      await s.leader.tick()
    }
    expect(s.leader.isLeading()).toBe(false)
    expect(s.devbox.book.backupLead(HOME)).toBeNull()
  })

  it('a host whose bridge is down while the companion leads answers what it can and says the rest needs the server', async () => {
    const s = simulate()
    s.primaryAlive()
    await s.pass(T + 10_000)
    s.devbox.setBridge(false)
    expect(await s.devbox.gatewayCall(A, 'task_send', { to: TASK_B, text: 'hi' })).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    // Its own copy still answers.
    expect(await s.devbox.gatewayCall(A, 'task_get', { id: TASK_B })).toMatchObject({ ok: true, result: { task: { id: TASK_B } } })
  })

  it('the Board is the host\'s own: written on its copy while the Mac is away, journaled for the Mac', async () => {
    const s = simulate()
    s.primaryAlive()
    await s.pass(T + 10_000)
    const edited = await s.oldbox.gatewayCall(B, 'board_edit', { edits: [{ old: 'Build: red', new: 'Build: green' }], version: 1 })
    expect(edited).toMatchObject({ ok: true, result: { queued: true, task_id: TASK_A, version: 2 } })
    expect(await s.oldbox.gatewayCall(B, 'board_get', {})).toMatchObject({ ok: true, result: { board: { version: 2 } } })
    // Each host answers from its own copy; the copies meet again on the Mac,
    // where the server's checks decide (offline-handover.ts replays board_*).
    expect(await s.devbox.gatewayCall(A, 'board_get', {})).toMatchObject({ ok: true, result: { board: { version: 1 } } })
    expect(s.oldbox.records()).toEqual([expect.objectContaining({ kind: 'op', op: 'board_edit', callerSid: B, args: expect.objectContaining({ task: TASK_A }) })])
  })
})
