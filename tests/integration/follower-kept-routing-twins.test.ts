/**
 * Class: "a daemon answers a call itself while its host has a follower". On a REAL standalone
 * daemon process (sendGatewayRequest, relayAttemptEnded), each of the four ways the daemon used to
 * answer a host's call from its own copy while this host's own Walnut server was there for it:
 *
 *   1. an outside caller's read (no session) while the Mac is away: now handed to the follower
 *   2. a read the Mac does not answer in time: still read from the copy (the follower's reads go to
 *      the same Mac while it answers), now counted `read_late`
 *   3. a same-host send while the Mac answers: a follower that takes them (answersOnline) restarting
 *      is waited for; one that does not take them leaves it to handleLocal, now counted `same_host`
 *   4. a session's call while the follower restarts: waits for it within the call's time; a call
 *      with no time to wait is answered from the copy, counted `follower_away`
 *
 * And a host with NO follower answers each from its copy at once, as before, and counts nothing.
 *
 *   test as the Mac ==trusted WS==> daemon: start (two mock sessions), host.slice, leader.configure,
 *     server.configure (a fake host server with the replica's spec env); answers gateway requests as "mac"
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *
 * Hygiene: every dir is under a temp `base`; each daemon is stopped by the pid it wrote into its own
 * dir, the fake host server and the mock sessions by the pids they logged (cleanupFollowerTwins).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BUN, REPLICA_SPEC_ENV, cleanupFollowerTwins, cmd, connectWs, gatewayCall, helloFollower, linkFollower, nextFrameId, sleep,
  spawnFollowerTwin, startMockSession, type Daemon,
} from '../helpers/follower-twin-rig.js'

const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinakept01'
const A = 'aaaaaaaa-6666-4666-8666-666666666666'
const B = 'bbbbbbbb-7777-4777-8777-777777777777'
const TASK_A = 'mkepta-0006'
const TASK_B = 'mkeptb-0007'
const EXTERNAL = 'external'
/** The quiet window this daemon calls the Mac away by, and its keepalive beat. */
const T = 4_000
const BEAT = 1_000

let base = ''
const started: number[] = []

interface Asked { op: string; callerSid: string; online: boolean }

/** A server end that answers every gateway request with who it is (unless `silent()`); returns what it was asked. */
function answersAs(ws: WebSocket, who: string, silent: () => boolean = () => false): Asked[] {
  const asked: Asked[] = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push({ op: String(m.payload?.name ?? ''), callerSid: String(m.callerSid), online: m.online === true })
    if (silent()) return
    ws.send(JSON.stringify({ id: nextFrameId(), cmd: 'gateway-result', relayId: m.relayId, result: { who, op: m.payload?.name } }))
  })
  return asked
}

const slice = (alias: string) => ({
  v: 1, home: HOME, hash: `h-${alias}`, asOf: Date.now(), host: alias,
  sessions: [{ sid: A, taskId: TASK_A, title: 'Parent work' }, { sid: B, taskId: TASK_B, title: 'Child: build the page' }],
  tasks: [
    { id: TASK_A, title: 'Parent work', phase: 'IN_PROGRESS', project: 'Acme' },
    { id: TASK_B, title: 'Child: build the page', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
  ],
  requests: [], boards: [], boardOf: {},
})

/** The daemon, the Mac on it (beating, answering as "mac" unless silent) and two idle sessions of its Walnut. */
async function hostWithMac(alias: string): Promise<{ d: Daemon; mac: WebSocket; macAsked: Asked[]; setSilent: (v: boolean) => void; stopBeat: () => void }> {
  const d = await spawnFollowerTwin({ base, name: alias, takeoverMs: T, beatMs: BEAT, started })
  const mac = await connectWs(d.port)
  let silent = false
  const macAsked = answersAs(mac, 'mac', () => silent)
  const beat = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT / 2)
  for (const [sid, task] of [[A, TASK_A], [B, TASK_B]]) {
    const s = await startMockSession({ base, name: `${alias}-${sid.slice(0, 1)}`, d, mac, sid, home: HOME, task })
    expect(s.ok, JSON.stringify(s)).toBe(true)
  }
  expect((await cmd(mac, { cmd: 'host.slice', slice: slice(alias) })).ok).toBe(true)
  expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
  // Both CLIs said their first turn is over (the mock's startup lines), as a sibling waiting for work.
  await sleep(1_000)
  return { d, mac, macAsked, setSilent: (v) => { silent = v }, stopBeat: () => clearInterval(beat) }
}

/** What the daemon counted as its own answers given while this host had a follower. */
async function ownAnswers(ws: WebSocket): Promise<{ total: number; byWhy: Record<string, number> }> {
  const s = await cmd(ws, { cmd: 'follower.status' })
  return { total: Number(s.offlineAnswers?.total ?? 0), byWhy: s.offlineAnswers?.byWhy ?? {} }
}

const isWho = (r: { ok: boolean; result?: Record<string, unknown> }, who: string) => r.ok && r.result?.who === who

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fkr-'))
})

afterAll(async () => {
  await cleanupFollowerTwins(base, started)
}, 60_000)

describe.skipIf(!BUN)('standalone daemon: a host WITH a follower never answers a call itself while that follower can', () => {
  let host: Awaited<ReturnType<typeof hostWithMac>>
  let follower: WebSocket
  let token = ''
  let followerAsked: Asked[] = []
  /** Links the follower again (its server restarted), answering as "follower". */
  const relink = async (answersOnline = false) => {
    const linked = await helloFollower({ d: host.d, home: HOME, walnutId: WALNUT, token, answersOnline })
    expect(linked.hello.ok, JSON.stringify(linked.hello)).toBe(true)
    follower = linked.follower
    followerAsked = answersAs(follower, 'follower')
  }
  const unlink = async () => { follower.close(); await sleep(300) }

  beforeAll(async () => {
    host = await hostWithMac('kept')
    const linked = await linkFollower({ base, name: 'kept', d: host.d, mac: host.mac, home: HOME, walnutId: WALNUT, serverPort: 41_241, env: { ...REPLICA_SPEC_ENV } })
    expect(linked.hello.ok, JSON.stringify(linked.hello)).toBe(true)
    follower = linked.follower
    token = linked.token
    followerAsked = answersAs(follower, 'follower')
  }, 120_000)

  afterAll(() => {
    host?.stopBeat()
    try { follower?.close() } catch { /* closed */ }
    try { host?.mac.close() } catch { /* closed */ }
  })

  it('3: a same-host send while the Mac answers, the follower not taking them: handleLocal delivers it, counted same_host', async () => {
    const before = await ownAnswers(follower)
    const sent = await gatewayCall(host.d, A, 'task_send', { to: TASK_B, text: 'Build the page, please.' })
    expect(sent.reply.ok, JSON.stringify(sent.reply)).toBe(true)
    expect(isWho(sent.reply, 'mac') || isWho(sent.reply, 'follower'), JSON.stringify(sent.reply)).toBe(false)
    expect(followerAsked).toEqual([])
    const after = await ownAnswers(follower)
    expect(after.byWhy.same_host ?? 0, JSON.stringify(after)).toBe((before.byWhy.same_host ?? 0) + 1)
  }, 60_000)

  it('3: a same-host send while a follower that takes them restarts waits for it, and it delivers it', async () => {
    // It says it takes same-host sends (its host_call_entry experiment on), then its server restarts.
    await unlink()
    await relink(true)
    await unlink()
    const call = gatewayCall(host.d, A, 'task_send', { to: TASK_B, text: 'And the footer.' })
    await sleep(1_500)
    await relink(true)
    const sent = await call
    expect(isWho(sent.reply, 'follower'), JSON.stringify(sent.reply)).toBe(true)
    expect(sent.ms).toBeGreaterThanOrEqual(1_200)
    expect(followerAsked).toEqual([{ op: 'task_send', callerSid: A, online: true }])
    expect(host.macAsked.filter((a) => a.op === 'task_send')).toEqual([])
    // Back to a follower that does not take them, for the rest.
    await unlink()
    await relink(false)
  }, 60_000)

  it('2: a read the Mac does not answer in time is read from the copy, counted read_late; the follower is not asked', async () => {
    const before = await ownAnswers(follower)
    host.setSilent(true)
    try {
      const read = await gatewayCall(host.d, A, 'task_get', { id: TASK_A }, 8_000)
      expect(read.reply.ok, JSON.stringify(read.reply)).toBe(true)
      expect(isWho(read.reply, 'mac') || isWho(read.reply, 'follower'), JSON.stringify(read.reply)).toBe(false)
    } finally {
      host.setSilent(false)
    }
    expect(followerAsked).toEqual([])
    const after = await ownAnswers(follower)
    expect(after.byWhy.read_late ?? 0, JSON.stringify(after)).toBe((before.byWhy.read_late ?? 0) + 1)
  }, 60_000)

  it('1: an outside caller\'s read while the Mac is away goes to this host\'s Walnut server', async () => {
    host.stopBeat()
    host.mac.close()
    await vi.waitFor(async () => {
      const s = await cmd(follower, { cmd: 'follower.status' })
      if (s.primaryConnected !== false) throw new Error('the daemon still sees the Mac')
    }, { timeout: 30_000, interval: 50 })
    const read = await gatewayCall(host.d, EXTERNAL, 'task_get', { id: TASK_A })
    expect(isWho(read.reply, 'follower'), JSON.stringify(read.reply)).toBe(true)
    expect(followerAsked).toEqual([{ op: 'task_get', callerSid: EXTERNAL, online: false }])
  }, 60_000)

  it('4: a session\'s call while this host\'s Walnut server restarts waits for it, and it answers', async () => {
    await unlink()
    const call = gatewayCall(host.d, A, 'task_get', { id: TASK_A })
    await sleep(1_500)
    await relink()
    const read = await call
    expect(isWho(read.reply, 'follower'), JSON.stringify(read.reply)).toBe(true)
    expect(read.ms).toBeGreaterThanOrEqual(1_200)
    expect(followerAsked).toEqual([{ op: 'task_get', callerSid: A, online: false }])
  }, 60_000)

  it('4: a call with no time left to wait for it is answered from the copy at once, counted follower_away', async () => {
    const before = await ownAnswers(follower)
    await unlink()
    // 8 s: less than the time the server needs of a call (FOLLOWER_WAIT_SPARE_MS), so nothing waits.
    const read = await gatewayCall(host.d, A, 'task_get', { id: TASK_A }, 8_000)
    expect(read.reply.ok, JSON.stringify(read.reply)).toBe(true)
    expect(isWho(read.reply, 'follower'), JSON.stringify(read.reply)).toBe(false)
    expect(read.ms).toBeLessThan(3_000)
    await relink()
    const after = await ownAnswers(follower)
    expect(after.byWhy.follower_away ?? 0, JSON.stringify(after)).toBe((before.byWhy.follower_away ?? 0) + 1)
  }, 60_000)
  it('4: a follower that does not come back within a call\'s room: that call gets the copy, the next ones do not wait until it links again', async () => {
    const before = await ownAnswers(follower)
    await unlink()
    // 15 s: a room of about 3 s (the call keeps FOLLOWER_WAIT_SPARE_MS for the server).
    const first = await gatewayCall(host.d, A, 'task_get', { id: TASK_A }, 15_000)
    expect(first.reply.ok, JSON.stringify(first.reply)).toBe(true)
    expect(isWho(first.reply, 'follower'), JSON.stringify(first.reply)).toBe(false)
    expect(first.ms).toBeGreaterThanOrEqual(2_000)
    // The server process still runs but never links (a hung boot): no call waits for it again.
    const second = await gatewayCall(host.d, A, 'task_get', { id: TASK_A }, 15_000)
    expect(second.reply.ok, JSON.stringify(second.reply)).toBe(true)
    expect(second.ms).toBeLessThan(1_500)
    await relink()
    const after = await ownAnswers(follower)
    expect(after.byWhy.follower_away ?? 0, JSON.stringify(after)).toBe((before.byWhy.follower_away ?? 0) + 2)
    // Its hello ends the hold: a restart after it is waited for again.
    await unlink()
    const call = gatewayCall(host.d, A, 'task_get', { id: TASK_A })
    await sleep(1_500)
    await relink()
    const third = await call
    expect(isWho(third.reply, 'follower'), JSON.stringify(third.reply)).toBe(true)
  }, 90_000)
})

describe.skipIf(!BUN)('standalone daemon: a host with NO follower answers each from its copy at once, as before', () => {
  it('a same-host send, a late read, an outside caller\'s read and a session\'s read: the copy, nothing waits, nothing counted', async () => {
    const host = await hostWithMac('alone')
    try {
      // 3. A same-host send while the Mac answers: handleLocal.
      const sent = await gatewayCall(host.d, A, 'task_send', { to: TASK_B, text: 'Build the page, please.' })
      expect(sent.reply.ok, JSON.stringify(sent.reply)).toBe(true)
      expect(isWho(sent.reply, 'mac'), JSON.stringify(sent.reply)).toBe(false)
      // 2. A read the Mac does not answer in time: the copy.
      host.setSilent(true)
      const late = await gatewayCall(host.d, A, 'task_get', { id: TASK_A }, 8_000)
      host.setSilent(false)
      expect(late.reply.ok, JSON.stringify(late.reply)).toBe(true)
      expect(isWho(late.reply, 'mac'), JSON.stringify(late.reply)).toBe(false)
      // The Mac away.
      host.stopBeat()
      host.mac.close()
      await sleep(500)
      // 1. An outside caller's read, and 4. a session's read: the copy, at once.
      for (const sid of [EXTERNAL, A]) {
        const read = await gatewayCall(host.d, sid, 'task_get', { id: TASK_A })
        expect(read.reply.ok, `${sid}: ${JSON.stringify(read.reply)}`).toBe(true)
        expect(read.ms, sid).toBeLessThan(3_000)
      }
      // Nothing counted: no follower was there for any of them.
      const mac = await connectWs(host.d.port)
      try {
        expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
        const status = await cmd(mac, { cmd: 'server.status', home: HOME })
        expect(status.ok, JSON.stringify(status)).toBe(true)
        expect(status.status?.state).toBe('off')
        expect(status.offlineAnswers?.total, JSON.stringify(status.offlineAnswers)).toBe(0)
      } finally {
        mac.close()
      }
    } finally {
      host.stopBeat()
      try { host.mac.close() } catch { /* closed */ }
    }
  }, 120_000)
})
