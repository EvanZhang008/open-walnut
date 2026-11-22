/**
 * A host replica's day through its follower link, once over the socket link and once over the
 * direct link of a host's one Walnut service (src/core/link/follower-link-direct.ts), against a
 * real daemon runtime in its own process (tests/helpers/follower-link-proc.ts, one scenario for
 * both): the same assertions on what a caller of the link sees (the writes' answers and error
 * codes, the sessions, the owner scope of a read, streams both ways, the journal a leader drains
 * and acks through the door), and the one thing that differs: the daemon logs a `follower.hello`
 * for the socket link and none for the direct one.
 * MACHINE SAFETY: one temp root per run; no CLI starts; the child ends by itself.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const FIXTURE = path.resolve(__dirname, '../helpers/follower-link-proc.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

interface Run { arm: string; shared: Record<string, any>; wire: { helloLogged: number; seatedLogged: number }; seat: Record<string, any> }

function run(arm: 'ws' | 'direct'): Promise<Run> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `follower-link-${arm}-`))
  roots.push(root)
  return new Promise((resolve, reject) => {
    const child = execFile(BUN!, [FIXTURE, root, arm], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const last = String(stdout).trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(last) as Run) } catch { reject(new Error(`${arm}: ${error?.message ?? ''}\n${String(stderr).slice(-3000)}\n${String(stdout).slice(-1500)}`)) }
    })
    child.stdin?.end()
  })
}

describe.skipIf(!BUN || process.platform === 'win32')('the follower link, socket and direct, against a real daemon runtime', () => {
  const runs = new Map<string, Run>()
  for (const arm of ['ws', 'direct'] as const) {
    it(`${arm}: a write is refused while the leader answers, journaled while it is away, and drained and acked by the leader through the door`, async () => {
      const r = await run(arm)
      runs.set(arm, r)
      const s = r.shared
      expect(s.linked).toEqual({ state: 'up', linkState: 'following', walnutId: 'w-acme', holder: 'primary', primaryConnected: true, opsCap: true, readsCap: true })
      // The leader answers: the daemon refuses with the code the replica retries by.
      expect(s.writeWhileLeaderAnswers).toEqual({ ok: false, errorKind: 'leader_answers' })
      expect(s.sendWhileLeaderAnswers).toEqual({ ok: false, errorKind: 'leader_answers' })
      expect(s.sessions).toEqual({ ok: true, host: 'devbox', sids: ['aaaaaaaa-1111-4111-8111-111111111111:stopped'] })
      expect(s.status).toEqual({ ok: true, walnutId: 'w-acme', home: '/acme/home', holder: 'primary' })
      // The follower's own scope and allow-list hold on this link too.
      expect(s.readOfAStranger).toEqual({ ok: false, errorKind: 'not_found' })
      expect(s.leaderOnlyCommand).toEqual({ ok: false, errorKind: 'follower_refused' })
      // Streams run both ways through the daemon's relay.
      expect(s.streamToLeader).toBe('THROUGH THE DAEMON')
      expect(s.streamToFollower).toEqual({ echoed: 'cba', plugged: ['primary'] })
      // The leader is away: the write is the journal's, once, and what is pending says so.
      expect(s.writeWhileLeaderAway).toMatchObject({ ok: true })
      expect(s.writeAskedAgain).toMatchObject({ ok: true })
      expect(s.pendingWhileAway.ok).toBe(true)
      expect(s.pendingWhileAway.kinds.length).toBe(1)
      expect(s.sendWhileAway).toEqual({ ok: false, errorKind: 'not_found' })
      // The follower's report is what the leader reads with server.status.
      expect(s.reportRead).toBe('reported')
      // A leader that comes back drains the journal through the door and acks it.
      expect(s.drained.ok).toBe(true)
      expect(s.drained.kinds.length).toBe(1)
      expect(s.drained.opIds).toEqual(['op-away'])
      expect(s.drained.description).toBe(true)
      expect(s.acked).toMatchObject({ ok: true, remaining: 0 })
      expect(s.pendingAfterAck.kinds).toEqual([])
      expect(s.stopCode).toBe(0)
      expect(s.exitCalls).toBe(0)
    }, 150_000)
  }

  it('both links give a caller the same answers, and the daemon sees a follower.hello for the socket link only', () => {
    const ws = runs.get('ws')
    const direct = runs.get('direct')
    expect(ws && direct, 'both arms ran').toBeTruthy()
    expect(direct!.shared).toEqual(ws!.shared)
    expect(ws!.wire).toEqual({ helloLogged: 1, seatedLogged: 0 })
    expect(direct!.wire).toEqual({ helloLogged: 0, seatedLogged: 1 })
  })

  // Review A3b S56-L3, L5 and S34-L3, on the real runtime's seat (the direct arm's run above).
  it('the seat: no socket takes it, a declared move is followed, and a seat taken is taken back', () => {
    const s = runs.get('direct')?.seat
    expect(s, 'the direct arm ran').toBeTruthy()
    expect(s!.socketHello).toEqual({ ok: false, errorKind: 'not_started_here' })
    expect(s!.stillFollowing).toBe('following')
    // The leader that moved hears the home the host keeps it under (one-service-mode.ts serviceModeAsk names it).
    expect(s!.moveAnswer).toEqual({ ok: true, homeHere: '/acme/home' })
    expect(s!.movedStatus).toEqual({ ok: true, walnutId: 'w-acme', home: '/acme/home' })
    expect(s!.otherSeatedAs).toBe('/acme/home')
    expect(s!.afterTakeBack).toEqual({ linkState: 'following', status: true })
  })
})
