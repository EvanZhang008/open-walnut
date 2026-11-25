/**
 * The rules of what may go up the bulk channel's own paced connection (src/providers/paced-send-gate.ts).
 * 2026-11-25: the whole notes manifest (about 1.7 MB in one frame) took longer than the host's 120 s
 * keepalive at a paced 13.7 KB/s; the host cut the connection every two minutes, all day, and every
 * relay answer behind it was lost. Pins:
 *   - G1: a frame that alone takes longer than UPLOAD_FRAME_MAX_SECS is refused at once; the largest
 *     upload part (MAX_UPLOAD_FRAME_BYTES as base64) still fits at the bulk channel's lowest pace;
 *   - G2: unpaced, nothing waits;
 *   - G3: a relay answer goes at once, past frames that wait;
 *   - G4: other frames wait while more than AHEAD_MAX_SECS of the pace is ahead, and go in order as it drains;
 *   - G5: a waiting frame fails when nothing ahead moves for its stall time, never while bytes move, and at its most;
 *   - G6: close fails every waiting frame;
 *   - G7: a relay answer's time and the small error a caller gets instead of a late answer;
 *   - G8: a manifest's lists gzip and come back the same (replica-sync-gz.ts), small ones go plain.
 */
import { describe, it, expect } from 'vitest'
import {
  AHEAD_MAX_SECS, FRAME_ALONE_MAX_SECS, PacedFrameTooSlowError, PacedGateWaitError, PacedSendGate, relayAnswerSecs, type PacedLink,
} from '../../src/providers/paced-send-gate.js'
import { BULK_PACE_FLOOR_BYTES_PER_SEC, MAX_UPLOAD_FRAME_BYTES } from '../../src/providers/ssh-upload-budget.js'
import { neverFitsGatewayReply, tooSlowGatewayReply } from '../../src/providers/daemon-frame-cap.js'
import { packReplicaSyncLists, REPLICA_SYNC_GZ_BYTES, unpackReplicaSyncLists } from '../../src/providers/replica-sync-gz.js'

function fakeLink(pace: number | null) {
  const state = { ahead: 0, up: 0, pace }
  const link: PacedLink = { aheadBytes: () => state.ahead, bytesPerSec: () => state.pace, upBytes: () => state.up }
  return { state, link }
}

function gateOf(pace: number | null) {
  const clock = { t: 1_000_000 }
  const { state, link } = fakeLink(pace)
  const gate = new PacedSendGate('dev-host', link, { now: () => clock.t, tickMs: 1_000_000 })
  return { gate, state, clock }
}

const settled = async (p: Promise<void>) => {
  let out: 'pending' | 'done' | Error = 'pending'
  p.then(() => { out = 'done' }, (e: Error) => { out = e })
  await new Promise((r) => setImmediate(r))
  return out
}

describe('paced send gate', () => {
  const floor = BULK_PACE_FLOOR_BYTES_PER_SEC

  it('G1: a frame too slow for the keepalive alone is refused at once; the largest upload part fits at the lowest pace', () => {
    const { gate } = gateOf(floor)
    const manifest = 1_700_000
    expect(() => gate.admit(manifest, { what: 'replica.sync', stallMs: 30_000, maxMs: 60_000 })).toThrow(PacedFrameTooSlowError)
    expect(() => gate.admit(manifest, { what: 'replica.sync', stallMs: 30_000, maxMs: 60_000 })).toThrow(/replica\.sync: a 1660 KB frame takes about 1\d\d s to go up to dev-host .*Nothing was sent/)
    // An answer too slow alone is refused too: it would end the link for everything else.
    expect(() => gate.admit(manifest, { what: 'gateway-result', first: true, stallMs: 1, maxMs: 1 })).toThrow(PacedFrameTooSlowError)
    // A whole part's frame as it goes, its command's fields included (the last part carries the most).
    const frame = JSON.stringify({
      id: 123456, cmd: 'fs.writePart', path: '/home/someone/.local/state/open-walnut/tasks/0a650170-01ec-5089-aede-2894d37fe723/incoming/a-long-file-name.tar.gz',
      offset: 987654321, data: Buffer.alloc(MAX_UPLOAD_FRAME_BYTES, 7).toString('base64'), final: true, size: 1987654321,
      sha256: 'f'.repeat(64), private: true, attempt: 'a'.repeat(32), traceId: 'abcdef12',
    })
    expect(frame.length / floor).toBeGreaterThan(100)
    expect(frame.length / floor).toBeLessThanOrEqual(FRAME_ALONE_MAX_SECS)
    expect(FRAME_ALONE_MAX_SECS).toBeLessThan(120)
    expect(gate.admit(frame.length, { what: 'fs.writePart', stallMs: 30_000, maxMs: 60_000 })).toBeNull()
  })

  it('G2: unpaced, every frame goes at once', () => {
    const { gate, state } = gateOf(null)
    state.ahead = 50 * 1024 * 1024
    expect(gate.admit(20 * 1024 * 1024, { what: 'fs.writePart', stallMs: 1, maxMs: 1 })).toBeNull()
  })

  it('G3: a relay answer goes at once past frames that wait', async () => {
    const { gate, state } = gateOf(10_000)
    state.ahead = 500_000
    const waiting = gate.admit(100_000, { what: 'replica.put', stallMs: 30_000, maxMs: 60_000 })
    expect(waiting).toBeInstanceOf(Promise)
    expect(gate.admit(80_000, { what: 'gateway-result', first: true, stallMs: 1, maxMs: 1 })).toBeNull()
    expect(await settled(waiting!)).toBe('pending')
    gate.close(new Error('done'))
    await waiting!.catch(() => {})
  })

  it('G4: frames wait while more than a few seconds of the pace is ahead, and go in order as it drains', async () => {
    const pace = 10_000
    const { gate, state } = gateOf(pace)
    // Little ahead and nobody waiting: at once.
    state.ahead = pace * AHEAD_MAX_SECS
    expect(gate.admit(50_000, { what: 'a', stallMs: 30_000, maxMs: 60_000 })).toBeNull()
    state.ahead = pace * AHEAD_MAX_SECS + 1
    const order: string[] = []
    const a = gate.admit(20_000, { what: 'a', stallMs: 30_000, maxMs: 60_000 })!.then(() => order.push('a'))
    // One behind a waiting frame waits too, even with the link drained: order holds.
    state.ahead = 0
    const b = gate.admit(20_000, { what: 'b', stallMs: 30_000, maxMs: 60_000 })!.then(() => order.push('b'))
    const c = gate.admit(20_000, { what: 'c', stallMs: 30_000, maxMs: 60_000 })!.then(() => order.push('c'))
    expect(gate.waiting).toBe(3)
    // One pass lets go only what fits, counting the ones it let go before.
    state.ahead = 0
    gate.tick()
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['a', 'b'])
    expect(gate.waiting).toBe(1)
    state.ahead = 0
    gate.tick()
    await Promise.all([a, b, c])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('G5: a waiting frame fails when nothing ahead moves for its stall time, never while bytes move, and at its most', async () => {
    const { gate, state, clock } = gateOf(10_000)
    state.ahead = 1_000_000
    const p = gate.admit(10_000, { what: 'fs.writePart', stallMs: 5_000, maxMs: 20_000 })!
    for (let i = 0; i < 4; i++) {
      clock.t += 4_000
      state.up += 40_000
      gate.tick()
    }
    expect(await settled(p)).toBe('pending')
    clock.t += 5_000
    gate.tick()
    const err = await settled(p)
    expect(err).toBeInstanceOf(PacedGateWaitError)
    expect(String(err)).toMatch(/fs\.writePart: waited 21 s behind 977 KB still going up to dev-host at 9\.8 KB\/s; nothing was sent/)

    const stalled = gate.admit(10_000, { what: 'replica.put', stallMs: 5_000, maxMs: 60_000 })!
    clock.t += 5_000
    gate.tick()
    expect(await settled(stalled)).toBeInstanceOf(PacedGateWaitError)
  })

  it('G6: close fails every waiting frame with its reason', async () => {
    const { gate, state } = gateOf(10_000)
    state.ahead = 1_000_000
    const ps = [1, 2].map(() => gate.admit(10_000, { what: 'x', stallMs: 5_000, maxMs: 20_000 })!)
    gate.close(new Error('channel dropped'))
    for (const p of ps) await expect(p).rejects.toThrow('channel dropped')
    expect(gate.waiting).toBe(0)
  })

  it('G7: an answer\'s time behind what is ahead, and the small error instead of a late answer', () => {
    const { link, state } = fakeLink(13_982)
    state.ahead = 140_000
    expect(relayAnswerSecs(link, 140_000)).toBeCloseTo(20, 0)
    expect(relayAnswerSecs(fakeLink(null).link, 1)).toBeNull()
    const reply = tooSlowGatewayReply(7, 'dev-host', { bytes: 170_000, aheadKB: 137, paceKBps: 13.7, needSecs: 22, leftSecs: 18 })
    expect(reply).toMatchObject({ relayId: 7, errorCode: 'bad_request', detail: { tooSlow: true, needSecs: 22, leftSecs: 18 } })
    expect(String(reply.error)).toMatch(/166 KB.*13\.7 KB\/s with 137 KB ahead.*about 22 s.*18 s left.*Ask for less/)
    expect(JSON.stringify(reply).length).toBeLessThan(1024)
    const never = neverFitsGatewayReply(8, 'dev-host', 2_000_000, 13_982)
    expect(never).toMatchObject({ relayId: 8, errorCode: 'bad_request', detail: { tooSlow: true, never: true } })
    expect(String(never.error)).toMatch(/1953 KB.*13\.7 KB\/s.*about 143 s.*Ask for less/)
    expect(String(never.error)).not.toMatch(/0 s left/)
  })

  it('G8: a manifest\'s lists gzip and come back the same; small ones go plain', async () => {
    const entries = Array.from({ length: 6_000 }, (_, i) => ({ k: `notes/folder ${i % 40}/note ${i}.md`, h: (i * 2654435761 % 2 ** 32).toString(16).padStart(12, '0'), n: i, m: { title: `Note \u4f60\u597d ${i}`, updatedAt: '2026-11-25T04:15:00.000Z' } }))
    const params = { home: '/h', kind: 'notes', asOf: 1, manifestId: 'abc', entries, renamed: [{ from: 'a.md', to: 'b.md' }] }
    const packed = await packReplicaSyncLists(params)
    expect(packed.entries).toBeUndefined()
    expect(typeof packed.listsGz).toBe('string')
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(params).length / 3)
    expect(unpackReplicaSyncLists({ cmd: 'replica.sync', ...packed })).toEqual({ cmd: 'replica.sync', ...params })
    // Changes only, gzipped too.
    const changes = { home: '/h', kind: 'notes', base: 'b1', changed: entries, removed: ['x.md'] }
    expect(unpackReplicaSyncLists(await packReplicaSyncLists(changes))).toEqual(changes)
    const small = { home: '/h', kind: 'memory', entries: [{ k: 'a', h: 'b', n: 1 }] }
    expect(JSON.stringify(small).length).toBeLessThan(REPLICA_SYNC_GZ_BYTES)
    expect(await packReplicaSyncLists(small)).toBe(small)
    expect(() => unpackReplicaSyncLists({ listsGz: Buffer.from('not gzip').toString('base64') })).toThrow()
  })
})
