/**
 * A session's call while the Mac is back but has not taken this host's journal yet, on REAL
 * daemon processes, both twins (sendGatewayRequest's first rule: `!target ||
 * offlineHost.pendingHandover(home)` hands it to this host's own Walnut server):
 *
 *   test as the Mac ==trusted WS==> daemon: start, host.slice, leader.configure, server.configure;
 *     answers every gateway request it is sent as "mac"
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a mock session on the daemon, its calls on the agent-gateway socket
 *
 *   1. The Mac goes away (its socket closes). A session's task_update goes to the follower, which
 *      hands it back (needs_leader, not final); the daemon journals it: one drainable record.
 *   2. The Mac comes back on a new socket (the host.slice probe binds it, says pendingHandover)
 *      and pings, but does not drain. The next call goes to the follower, never to the Mac, and
 *      the daemon's own away answer is not used for it (its counter stays where step 1 left it).
 *   3. The Mac drains and acks the record. The next call goes to the Mac; the follower is not asked.
 *
 * Hygiene: every dir is a temp dir (short: socket paths); each daemon is stopped by the pid it
 * wrote into its own dir, the fake host server and the mock session by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUN, cleanupFollowerTwins, cmd, connectWs, gatewayCall, linkFollower, nextFrameId, spawnFollowerTwin, startMockSession, sleep } from '../helpers/follower-twin-rig.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinadrain1'
const SID = 'eeeeeeee-5555-4555-8555-555555555555'
const TASK = 'mdrainee-0005'
/** The quiet window this daemon calls the Mac away by, and its keepalive beat. */
const T = 4_000
const BEAT = 1_000

let base = ''
const started: number[] = []

/** A server end that answers every gateway request it is sent with `answer`; returns the ops it was asked. */
function answers(ws: WebSocket, answer: (op: string) => Record<string, unknown>): string[] {
  const asked: string[] = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    const op = String(m.payload?.name ?? '')
    asked.push(op)
    ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'gateway-result', relayId: m.relayId, ...answer(op) }))
  })
  return asked
}

/** Polls the follower's view of its leader until `ok` holds; returns that view. */
async function statusUntil(follower: WebSocket, ok: (s: Record<string, any>) => boolean, label: string): Promise<Record<string, any>> {
  const end = Date.now() + 30_000
  for (;;) {
    const s = await cmd(follower, { cmd: 'follower.status' })
    if (ok(s)) return s
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}: ` + JSON.stringify(s).slice(0, 400))
    await sleep(50)
  }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fdh-'))
})

afterAll(async () => {
  await cleanupFollowerTwins(base, started)
}, 60_000)

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin === 'source' ? `source twin (${SOURCE_TWIN.runtime})` : 'standalone twin'}: a session's call while the Mac is back but has not drained this host's journal`, () => {
    it('goes to this host\'s Walnut server until the Mac drains and acks, then to the Mac', async () => {
      const alias = `${twin.slice(0, 3)}drn`
      const d = await spawnFollowerTwin({ base, name: alias, twin, takeoverMs: T, beatMs: BEAT, started })
      const macAnswer = (op: string) => ({ result: { who: 'mac', op } })
      let mac = await connectWs(d.port)
      // What each Mac socket was asked (the one before it went away, the one after it came back).
      const macOps = [answers(mac, macAnswer)]
      let beat: ReturnType<typeof setInterval> | null = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT / 2)
      const slice = { v: 1, home: HOME, hash: `h-${alias}`, asOf: Date.now(), host: alias, sessions: [{ sid: SID, taskId: TASK, title: 'Ship it' }], tasks: [{ id: TASK, title: 'Ship it', phase: 'IN_PROGRESS', project: 'Acme' }], requests: [], boards: [], boardOf: {} }
      let follower: WebSocket | null = null
      try {
        const startedSession = await startMockSession({ base, name: alias, d, mac, sid: SID, home: HOME, task: TASK })
        expect(startedSession.ok, JSON.stringify(startedSession)).toBe(true)
        expect((await cmd(mac, { cmd: 'host.slice', slice })).ok).toBe(true)
        expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
        const linked = await linkFollower({ base, name: alias, d, mac, home: HOME, walnutId: WALNUT, serverPort: 41_239 })
        follower = linked.follower
        expect(linked.hello.ok, JSON.stringify(linked.hello)).toBe(true)
        // Step 1 the follower hands back (as a server too old for the op does); later it answers.
        let followerHandsBack = true
        const followerAsked = answers(follower, (op) => followerHandsBack
          ? { errorCode: 'needs_leader', error: `${op} needs your Mac` }
          : { result: { who: 'follower', op } })

        // 1. The Mac goes away; a session's write is journaled here.
        clearInterval(beat); beat = null
        mac.close()
        await statusUntil(follower, (s) => s.primaryConnected === false, 'the daemon to see the Mac gone')
        const away = await gatewayCall(d, SID, 'task_update', { id: TASK, description: 'written while the Mac was away' })
        expect(away.reply, JSON.stringify(away.reply)).toMatchObject({ ok: true, result: { queued: true, offline: true } })
        expect(followerAsked).toEqual(['task_update'])
        const awayStatus = await statusUntil(follower, (s) => s.drainablePending === 1, 'one drainable journal record')
        const ownBefore = Number(awayStatus.offlineAnswers?.total ?? 0)

        // 2. The Mac is back and heard, and has not drained: the call is the follower's.
        followerHandsBack = false
        const backAt = Date.now()
        mac = await connectWs(d.port)
        macOps.push(answers(mac, macAnswer))
        beat = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT / 2)
        const probe = await cmd(mac, { cmd: 'host.slice', home: HOME, hash: slice.hash, asOf: slice.asOf })
        expect(probe, JSON.stringify(probe)).toMatchObject({ ok: true, have: true, pendingHandover: true })
        await statusUntil(follower, (s) => s.primaryConnected === true && Number(s.primaryHeardAgoMs) < Date.now() - backAt, 'the daemon to hear the Mac again')
        const pending = await gatewayCall(d, SID, 'task_update', { id: TASK, description: 'written while the Mac takes the journal' })
        expect(pending.reply, JSON.stringify(pending.reply)).toMatchObject({ ok: true, result: { who: 'follower', op: 'task_update' } })
        expect(followerAsked).toEqual(['task_update', 'task_update'])
        expect(macOps.flat()).toEqual([])
        const pendingStatus = await cmd(follower, { cmd: 'follower.status' })
        expect(pendingStatus.offlineAnswers?.total ?? 0, JSON.stringify(pendingStatus.offlineAnswers)).toBe(ownBefore)
        expect(pendingStatus.drainablePending).toBe(1)

        // 3. The Mac drains and acks: the next call is the Mac's.
        const drained = await cmd(mac, { cmd: 'offline.drain', home: HOME })
        expect(drained.ok, JSON.stringify(drained)).toBe(true)
        expect(drained.records.map((r: Record<string, unknown>) => [r.kind, r.op]), JSON.stringify(drained.records)).toEqual([['op', 'task_update']])
        const acked = await cmd(mac, { cmd: 'offline.ack', home: HOME, upTo: drained.records.at(-1).seq })
        expect(acked, JSON.stringify(acked)).toMatchObject({ ok: true, remaining: 0 })
        await statusUntil(follower, (s) => s.drainablePending === 0, 'the journal to be taken')
        const after = await gatewayCall(d, SID, 'task_update', { id: TASK, description: 'written once the Mac took the journal' })
        expect(after.reply, JSON.stringify(after.reply)).toMatchObject({ ok: true, result: { who: 'mac', op: 'task_update' } })
        expect(macOps.flat()).toEqual(['task_update'])
        expect(followerAsked).toEqual(['task_update', 'task_update'])
      } finally {
        if (beat) clearInterval(beat)
        follower?.close()
        mac.close()
      }
    }, 180_000)
  })
}
