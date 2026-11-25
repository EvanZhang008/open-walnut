/**
 * A plugin job's call while the cloud companion leads, on a REAL standalone daemon process
 * (daemon-standalone.ts sendPluginJobGatewayRequest, follower-gateway-core.ts routeJob):
 *
 *   test as the Mac ==trusted WS (no auto pong)==> daemon <==bridge== companion (this process:
 *     leader.configure {backup}, bridge.configure,      a /bridge server; its link claims the
 *     server.configure, jobs.configure                  lead with leader.claim)
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a real job run (the daemon's own `walnut plugin-job`): its run id is the caller
 *
 * The Mac falls silent past its quiet window and the companion takes the lead. The companion
 * leading is the leader away too: the job's call goes to this host's own Walnut server, as a
 * `gateway-request` naming the job in `caller`, exactly as while no one leads. Its refusal
 * (`needs_leader`, final or not) is the caller's answer: routeJob passes no fallback, so the call
 * is never relayed to the companion, which would run it without the job's identity.
 *
 * 2026-11-25: with the Mac away five hours and the companion leading, the daemon answered every
 * job call `hub_unreachable` "the Walnut that runs this job is not connected now" (309 times),
 * while session calls in the same window were handed to the follower and answered: the gate
 * before routeJob skipped the follower whenever the companion led.
 *
 * The rig is tests/helpers/follower-job-rig.ts. Hygiene: every dir is a temp dir (short: socket
 * paths); each daemon is stopped by the pid it wrote into its own dir, the fake host server and
 * the job run by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BINARY, BUN, JOB, QUIET_MS, cleanupFollowerTwins, cmd, companionLeads, rig, startCompanion, startGatewayCall, writeJobChild, type Companion,
} from '../helpers/follower-job-rig.js'

let base = ''
const started: number[] = []
let companion: Companion | null = null

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgc-'))
  writeJobChild(base)
  companion = await startCompanion()
})

afterAll(async () => {
  await companion?.close()
  await cleanupFollowerTwins(base, started)
}, 60_000)

describe.skipIf(!BUN && !BINARY)("standalone daemon: a plugin job's call while the cloud companion leads", () => {
  it('goes to this host\'s Walnut server naming the job, never "not connected"; the companion is asked nothing', async () => {
    // The takeover window is the quiet window: once the companion leads, the follower may write.
    const r = await rig({ base, started, name: 'cla', backup: true, takeoverMs: QUIET_MS })
    try {
      await companionLeads(r, companion!, 'cla-box')
      const view = await cmd(r.follower, { cmd: 'follower.status' })
      expect(view, JSON.stringify(view).slice(0, 300)).toMatchObject({ holder: 'backup', epoch: r.epoch + 1 })
      const { reply } = await startGatewayCall(r.d.sock, r.jobSid, 'task_create').done
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { who: 'follower', op: 'task_create' } })
      expect(r.followerAsked).toHaveLength(1)
      // Named from the daemon's own record of the run, as while no one leads (unvouched: this
      // test process holds the run's id from outside the run).
      expect(r.followerAsked[0]).toMatchObject({ callerSid: 'external', caller: JOB })
      expect(r.followerAsked[0]!.caller).toEqual(JOB)
      expect(companion!.askedBy('cla-box')).toEqual([])
      expect(r.macAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)

  it('the follower\'s needs_leader stands, final or not: the caller hears it, the companion is never asked', async () => {
    const refuse = (m: Record<string, any>) => {
      const op = String(m.payload?.name ?? '')
      return { errorCode: 'needs_leader', error: `${op} needs your Mac`, detail: op === 'task_create' ? { final: true } : {} }
    }
    const r = await rig({ base, started, name: 'clb', backup: true, takeoverMs: QUIET_MS, follower: refuse })
    try {
      await companionLeads(r, companion!, 'clb-box')
      for (const op of ['task_create', 'task_update']) {
        const t0 = Date.now()
        const { at, reply } = await startGatewayCall(r.d.sock, r.jobSid, op).done
        expect(reply, JSON.stringify(reply)).toMatchObject({ ok: false, error: { code: 'needs_leader', message: `${op} needs your Mac` } })
        // At once: nothing waits for the Mac or for another leader to take it.
        expect(at - t0).toBeLessThan(5_000)
      }
      expect(r.followerAsked.map((m) => m.payload?.name)).toEqual(['task_create', 'task_update'])
      expect(r.followerAsked.every((m) => m.callerSid === 'external' && JSON.stringify(m.caller) === JSON.stringify(JOB))).toBe(true)
      // No gateway-request reached the companion's bridge for either call.
      expect(companion!.askedBy('clb-box').map((m) => m.payload?.name)).toEqual([])
      expect(r.macAsked).toEqual([])
    } finally {
      r.awake(false)
      r.mac.close(); r.follower.close()
    }
  }, 120_000)
})
