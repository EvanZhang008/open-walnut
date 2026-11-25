/**
 * A plugin job's call in the seconds after its leader went quiet, on a REAL standalone daemon
 * process (follower-gateway-core.ts routeJob, the one rule for "away"):
 *
 *   test as the Mac ==trusted WS (no auto pong)==> daemon
 *     leader.configure, server.configure, jobs.configure; app pings while it is awake
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a real job run (the daemon's own `walnut plugin-job`): its run id is the caller
 *
 * The Mac stops pinging: after three beats the gateway passes over it, while the follower
 * may not write until the Mac's whole quiet window has passed. A job's call made in that
 * window waits, within its deadline, and then goes the right way:
 *   - the window ends: to the follower (`gateway-request` naming the job), never an error
 *   - the Mac pings again first: to the Mac, the follower asked nothing
 *   - the job's call leaves (its socket closes) while it waits: asked of no one, even once the
 *     Mac answers again (its next run would retry it: applied twice)
 * Either way the call names its job in the frame's `caller`, built from the daemon's own record
 * of the run (plugin-jobs-core.ts callerOfRun): to the Mac and to the follower alike. What a
 * caller writes (a `caller` or `pluginJob` in its request, its payload or its arguments) never
 * names one, and a run id no live run holds is refused before anyone is asked. The daemon
 * adds `vouched: true` only when the process on the gateway socket is the run or one of its
 * descendants (the job's own walnut.ops.call, a child it starts); this test process holding the
 * run's id is outside the run, so its call names the job unvouched.
 * A job started while the follower names its call entry ('host-call-entry-v1') posts there first;
 * that door has no socket peer to read, so the daemon hands the job's line back and the
 * job's own call is vouched on the socket all the same (2026-11-23: a job started after the host's
 * service named its entry had every bypass start refused).
 *
 * The rig is tests/helpers/follower-job-rig.ts; the same call while the cloud companion leads is
 * tests/integration/follower-gateway-job-companion-twins.test.ts.
 *
 * Hygiene: every dir is a temp dir (short: socket paths); each daemon is stopped by the pid
 * it wrote into its own dir, the fake host server and the job run by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { BINARY, BUN, JOB, QUIET_MS, cleanupFollowerTwins, gatewayCall, leaderPassedOver, lines, rawGatewayCall, rig as jobRig, sleep, startGatewayCall, waitFor, writeJobChild } from '../helpers/follower-job-rig.js'

let base = ''
const started: number[] = []
const rig = (name: string, opts: { entry?: boolean } = {}) => jobRig({ base, started, name, ...opts })

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgj-'))
  writeJobChild(base)
})

afterAll(async () => {
  await cleanupFollowerTwins(base, started)
}, 60_000)

describe.skipIf(!BUN && !BINARY)("standalone daemon: a plugin job's call right after its leader went quiet", () => {
  it('awake: the call goes to the Mac, the follower is asked nothing', async () => {
    const r = await rig('sta')
    try {
      const { reply } = await gatewayCall(r.d.sock, r.jobSid, 'task_list')
      expect(reply).toMatchObject({ ok: true, result: { who: 'mac' } })
      expect(r.followerAsked).toEqual([])
      // The Mac hears the job too, in the same field the follower gets, from the daemon's own run record.
      expect(r.macAsked[0]).toMatchObject({ callerSid: 'external', caller: JOB })

      // The Mac falls silent: past three beats the gateway passes over it, and the follower
      // may write only once the whole quiet window has passed. A call in between waits.
      r.awake(false)
      const quietAt = Date.now()
      await leaderPassedOver(r)
      const { at, reply: waited } = await gatewayCall(r.d.sock, r.jobSid, 'task_create')
      expect(waited, JSON.stringify(waited)).toMatchObject({ ok: true, result: { who: 'follower', op: 'task_create' } })
      expect(at - quietAt).toBeGreaterThanOrEqual(QUIET_MS - 500)
      expect(r.followerAsked).toHaveLength(1)
      expect(r.followerAsked[0]).toMatchObject({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' } })
      expect(r.macAsked.map((m) => m.payload?.name)).toEqual(['task_list'])
      expect(r.followerAsked[0]!.caller).toEqual(r.macAsked[0]!.caller)
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)

  it('awake: only a call from inside the run is vouched; one from outside holding its id is not', async () => {
    const r = await rig('stv')
    try {
      // Outside the run: this test process, holding the run's id (a same-user process can read it
      // from the run's environment or its state file). The job is named, never vouched.
      const outside = await rawGatewayCall(r.d.sock, { v: 1, op: 'tools.call', sid: r.jobSid, args: { name: 'task_list', args: {} } })
      expect(outside, JSON.stringify(outside)).toMatchObject({ ok: true, result: { who: 'mac' } })
      expect(r.macAsked).toHaveLength(1)
      expect(r.macAsked[0]!.caller).toEqual(JOB)
      // The job's own walnut.ops.call, then a child process the job starts: inside the run.
      const go = `${r.jobOut}.go`
      fs.appendFileSync(go, 'task_update\n')
      await waitFor(() => lines(r.jobOut).some((l) => l.called === 'task_update'), 30_000, 'the job\'s own call')
      fs.appendFileSync(go, 'child\n')
      await waitFor(() => lines(r.jobOut).some((l) => typeof l.child === 'number'), 30_000, 'the job child\'s call')
      const child = lines(r.jobOut).find((l) => typeof l.child === 'number')!
      expect(child.reply, JSON.stringify(child)).toMatchObject({ ok: true, result: { who: 'mac', op: 'task_get' } })
      expect(lines(r.jobOut).find((l) => l.called === 'task_update')).toMatchObject({ result: { who: 'mac', op: 'task_update' } })
      expect(r.macAsked.map((m) => m.payload?.name)).toEqual(['task_list', 'task_update', 'task_get'])
      // The daemon read each socket's process: both calls came from inside the run.
      const inside = { ...JOB, vouched: true }
      expect(r.macAsked[1]!.caller).toEqual(inside)
      expect(r.macAsked[2]!.caller).toEqual(inside)
      expect(r.followerAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)

  it('awake: a job given its host\'s call entry is vouched for its own call as on the socket', async () => {
    const r = await rig('ste', { entry: true })
    try {
      // The job's own walnut.ops.call: its harness posts to the entry first (it was given one).
      fs.appendFileSync(`${r.jobOut}.go`, 'task_create\n')
      await waitFor(() => lines(r.jobOut).some((l) => l.called === 'task_create'), 30_000, 'the job\'s own call')
      expect(lines(r.jobOut).find((l) => l.called === 'task_create'), JSON.stringify(lines(r.jobOut))).toMatchObject({ result: { who: 'mac', op: 'task_create' } })
      // It came in by the entry: the run was given it, and the follower handed its line to the daemon.
      expect(r.entryLines.map((p) => p.request?.sid)).toEqual([r.jobSid])
      // Asked once, from inside the run: the daemon vouches for it whichever door it came in by.
      expect(r.macAsked.map((m) => m.payload?.name)).toEqual(['task_create'])
      expect(r.macAsked[0]!.caller).toEqual({ ...JOB, vouched: true })
      expect(r.followerAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
      await r.entry?.close()
    }
  }, 120_000)

  it('awake: what a caller writes never names a job; the frame names only the run\'s own', async () => {
    const r = await rig('stf')
    try {
      const words = { caller: { kind: 'plugin-job', plugin: 'evil', job: 'x' }, pluginJob: { plugin: 'evil', job: 'x' } }
      // An outside caller (no session) writing the fields everywhere it can: plain external.
      const outside = await rawGatewayCall(r.d.sock, { v: 1, op: 'tools.call', sid: 'external', ...words, args: { name: 'task_list', args: { ...words }, ...words } })
      expect(outside, JSON.stringify(outside)).toMatchObject({ ok: true, result: { who: 'mac' } })
      expect(r.macAsked).toHaveLength(1)
      expect(r.macAsked[0]!.callerSid).toBe('external')
      expect(r.macAsked[0]).not.toHaveProperty('caller')
      expect(r.macAsked[0]).not.toHaveProperty('pluginJob')
      // The job itself claiming another job in its words: the frame still names its own run's.
      const job = await rawGatewayCall(r.d.sock, { v: 1, op: 'tools.call', sid: r.jobSid, ...words, args: { name: 'task_list', args: {}, ...words } })
      expect(job, JSON.stringify(job)).toMatchObject({ ok: true, result: { who: 'mac' } })
      expect(r.macAsked).toHaveLength(2)
      expect(r.macAsked[1]).toMatchObject({ callerSid: 'external', caller: JOB })
      // A run id no live run holds: refused here, nobody asked.
      const guessed = await rawGatewayCall(r.d.sock, { v: 1, op: 'tools.call', sid: 'plugin-job:0123456789abcdef', args: { name: 'task_list', args: {} } })
      expect(guessed, JSON.stringify(guessed)).toMatchObject({ ok: false, error: { code: 'unknown_caller' } })
      expect(r.macAsked).toHaveLength(2)
      expect(r.followerAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)

  it('the Mac speaks again before its window ends: the waiting call goes to it, never to the follower', async () => {
    const r = await rig('stb')
    try {
      r.awake(false)
      await leaderPassedOver(r)
      // The call is on its way before the Mac's next beat (half a beat after it wakes).
      const pending = startGatewayCall(r.d.sock, r.jobSid, 'task_update')
      await pending.sent
      r.awake(true)
      const { reply } = await pending.done
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { who: 'mac', op: 'task_update' } })
      expect(r.followerAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)

  it('the job\'s call leaves while it waits: never relayed, even once the Mac answers again', async () => {
    const r = await rig('stc')
    try {
      r.awake(false)
      await leaderPassedOver(r)
      const c = net.connect(r.d.sock)
      await new Promise<void>((resolve, reject) => { c.on('connect', () => resolve()); c.on('error', reject) })
      c.write(JSON.stringify({ v: 1, op: 'tools.call', sid: r.jobSid, args: { name: 'task_create', args: {} } }) + '\n')
      await sleep(400)
      c.destroy()
      r.awake(true)
      // Well past the quiet window: had the wait gone on, the call would have gone to one of them.
      await sleep(QUIET_MS + 1_000)
      expect(r.macAsked.map((m) => m.payload?.name)).toEqual([])
      expect(r.followerAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)
})
