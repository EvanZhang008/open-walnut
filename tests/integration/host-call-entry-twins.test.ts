/**
 * The host call entry ('host-call-entry-v1') on a REAL standalone daemon process (the rig:
 * tests/helpers/host-call-rig.ts), with a real job run (the daemon's own `walnut plugin-job`):
 * its first walnut.ops.call.
 *
 * Proven: a run started after the follower said its socket gets WALNUT_CALL_SOCKET and its own
 * WALNUT_CALL_TOKEN beside the gateway socket; its call goes over HTTP on the entry socket, through
 * the daemon's gateway rules (a plugin job's call: to the server of its Walnut) and back, the same
 * answer a socket line gets; a token for another sid, or none, or of a run that ended, is refused
 * and runs nothing; a socket outside the daemon dir's entry dir (an old http address too) is never
 * given; once the follower's report says no socket (its experiment off), the next run gets none.
 * The daemon's own away answers are counted in follower.status and server.status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { BUN, alive, askUntil, cmd, endRigs, report, rig, rigBase, socketCall, startRigs, waitFor } from '../helpers/host-call-rig.js'

beforeAll(() => startRigs('hce-'))
afterAll(endRigs)

describe.skipIf(!BUN)('standalone daemon: the host call entry', () => {
  it('a job run gets the entry socket and its own token, its call is handed back by the entry and answered on the socket, and a wrong or ended run\'s token runs nothing', async () => {
    const r = await rig('sta')
    try {
      const run = await r.startJob('worker')
      expect(run.callSocket).toBe(r.callSocket)
      expect(fs.statSync(r.callSocket).mode & 0o777).toBe(0o600)
      expect(run.callToken).toMatch(/^[0-9a-f]{64}$/)
      expect(run.socket).toBe(r.d.sock)
      // Its call went to the entry first, which handed it back unrun (a plugin job's run is vouched for
      // only on the gateway socket, by the process there), and the socket answered it, once.
      expect(r.entryLines.map((l) => [l.sid, l.args?.name])).toEqual([[run.sid, 'task_list']])
      expect(run.answer).toEqual({ who: 'mac', op: 'task_list' })
      expect(r.macAsked).toHaveLength(1)
      expect(r.macAsked[0]).toMatchObject({ callerSid: 'external', payload: { name: 'task_list' } })
      // The very same line on the socket: the same answer.
      expect(await socketCall(r.d.sock, run.sid, 'task_list')).toEqual({ ok: true, result: { who: 'mac', op: 'task_list' } })

      // follower.gateway itself: the token of this run only, and even its own token runs nothing for
      // a job (job_on_socket): the door has no socket peer to vouch for the run.
      const line = { v: 1, op: 'tools.call', sid: run.sid, args: { name: 'task_get', args: {} } }
      const asked = r.macAsked.length
      const good = await cmd(r.follower, { cmd: 'follower.gateway', request: line, token: run.callToken, openedAt: Date.now() })
      expect(good).toMatchObject({ ok: false, errorKind: 'job_on_socket' })
      expect(r.macAsked.length).toBe(asked)
      const other = await cmd(r.follower, { cmd: 'follower.gateway', request: { ...line, sid: 'plugin-job:' + '0'.repeat(64) }, token: run.callToken })
      expect(other).toMatchObject({ ok: false, errorKind: 'bad_token' })
      const none = await cmd(r.follower, { cmd: 'follower.gateway', request: line })
      expect(none).toMatchObject({ ok: false, errorKind: 'bad_token' })
      expect(r.macAsked.length).toBe(asked)
      // Not over the Mac's socket: only a follower's link may hand a line in.
      expect(await cmd(r.mac, { cmd: 'follower.gateway', request: line, token: run.callToken })).toMatchObject({ ok: false })
      expect(r.macAsked.length).toBe(asked)

      // The key and the runs are the daemon dir's own private files.
      expect(fs.statSync(path.join(r.d.dir, 'host-call.key')).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.join(r.d.dir, 'host-call-runs.json')).mode & 0o777).toBe(0o600)

      // The count of own away answers is there to read, zero here (the Mac answered every call).
      expect((await cmd(r.follower, { cmd: 'follower.status' })).offlineAnswers).toMatchObject({ total: 0 })
      expect((await cmd(r.follower, { cmd: 'server.status' })).offlineAnswers).toMatchObject({ total: 0 })

      // The run ends: its token ends with it, though the sid is the same.
      await r.stopJobs()
      await waitFor(() => !alive(run.pid), 30_000, 'the job run to end')
      const after = await askUntil(
        () => cmd(r.follower, { cmd: 'follower.gateway', request: line, token: run.callToken, openedAt: Date.now() }),
        (a) => a.errorKind === 'bad_token', 4_000,
      )
      expect(after).toMatchObject({ ok: false, errorKind: 'bad_token' })
    } finally {
      r.mac.close(); r.follower.close()
    }
  }, 180_000)

  it('the follower\'s report says no socket (its experiment off) or one outside the entry dir: the next run gets none, and calls over the gateway socket', async () => {
    const r = await rig('stb')
    try {
      await report(r.follower, { callSocket: null })
      const run = await r.startJob('worker')
      expect(run.callSocket).toBeNull()
      expect(run.callToken).toBeNull()
      expect(run.answer).toEqual({ who: 'mac', op: 'task_list' })
      // A socket outside this daemon dir's entry dir, or an old http address: never given.
      const stray = path.join(rigBase(), 'stray.sock')
      const straySrv = net.createServer()
      await new Promise<void>((resolve) => straySrv.listen(stray, () => resolve()))
      fs.chmodSync(stray, 0o600)
      for (const bad of [stray, 'http://127.0.0.1:4100/api/host/call', `${r.d.dir}/host-call/../host-call/${path.basename(r.callSocket)}`]) {
        await report(r.follower, { callSocket: bad })
      }
      const strayRun = await r.startJob('third')
      expect(strayRun.callSocket).toBeNull()
      expect(strayRun.answer).toEqual({ who: 'mac', op: 'task_list' })
      straySrv.close()
      // And its socket again: the run after that gets it.
      await report(r.follower, { callSocket: r.callSocket })
      const next = await r.startJob('second')
      expect(next.callSocket).toBe(r.callSocket)
      expect(r.entryLines.map((l) => l.sid)).toEqual([next.sid])
      expect(next.answer).toEqual({ who: 'mac', op: 'task_list' })
    } finally {
      r.mac.close(); r.follower.close()
    }
  }, 180_000)
})
