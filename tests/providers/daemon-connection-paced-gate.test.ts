/**
 * What DaemonConnection writes onto the bulk channel's own paced connection, and when
 * (src/providers/paced-send-gate.ts). 2026-11-25: a host's daemon closes a client it heard no whole
 * frame from for 120 to 135 s; the Mac's bulk channel to one dev host went up at 13.7 KB/s, the
 * whole notes manifest (about 1.7 MB, one frame) took longer than that, so the host cut the
 * channel every two minutes, all day, and every relay answer queued behind it was lost. Pins, each
 * on a real paced forward to a mock daemon:
 *   - P1: a frame that alone takes longer than UPLOAD_FRAME_MAX_SECS at the pace is refused at
 *     once, never written, and the channel and the next small upload are fine;
 *   - P2: a burst of background uploads all arrive in order, and what is written but not yet up
 *     never passes a few seconds of the pace plus one frame;
 *   - P3: a relay answer sent while uploads wait reaches the host before the ones still waiting,
 *     with its real result;
 *   - P4: a relay answer that cannot arrive in time at the pace is answered at once with a small
 *     error (tooSlow), to the host and to the caller;
 *   - P5: with no pace nothing is gated, a big frame goes as before;
 *   - P6: a manifest goes with its lists gzipped to a daemon that reads them (and plain to one
 *     that does not);
 *   - P7: the class guard: no socket write that can reach the bulk socket exists outside
 *     sendOnce, after the gate (a source scan, with a sample that proves it catches a miss);
 *   - P8: the bulk socket closing while uploads wait fails them at once as "no link", unsent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { _setBulkForwardForTesting } from '../../src/providers/stream-lane.js'
import { pacedForward } from '../../src/providers/paced-forward.js'
import { linkFailureKind } from '../../src/providers/link-failure.js'
import { AHEAD_MAX_SECS, PacedFrameTooSlowError } from '../../src/providers/paced-send-gate.js'
import { UPLOAD_FRAME_MAX_SECS } from '../../src/providers/ssh-upload-budget.js'
import { REPLICA_SYNC_GZ_CAPABILITY } from '../../src/providers/replica-sync-gz.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { proxyForward } from '../helpers/proxy-forward.js'
import { waitFor } from '../helpers/poll-wait.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
type Statics = { BULK_REDIAL_DELAY_MS: number }
const statics = DaemonConnection as unknown as Statics
/** The connection's private parts the tests read. */
interface Inner {
  bulkQueuedUp(): number
  pacedGate: { waiting: number }
  bulkWs: { send: (m: unknown, ...rest: unknown[]) => void }
  sendGatewayResult(reply: Record<string, unknown>, relayId: number, kept?: { reply: Promise<Record<string, unknown>> }, about?: { answerBy?: number; instanceId?: string }): Promise<boolean>
}

const KB = 1024
/**
 * The host copy and the walnut skills (each several hundred KB, pushed on connect) ride the bulk
 * channel too; a daemon without these never gets them, so only the test's own frames use the paced link.
 */
const QUIET_LINK = ['offline-host-v1', 'skill-sync-v2']
const part = (offset: number, bytes: number) => ({ path: '/tmp/x', offset, data: 'A'.repeat(bytes) })

describe('DaemonConnection: the paced own bulk connection admits frames by the pace', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection
  let forwards: Array<Awaited<ReturnType<typeof proxyForward>>>
  let savedRedial: number

  const inner = () => conn as unknown as Inner

  beforeEach(async () => {
    savedRedial = statics.BULK_REDIAL_DELAY_MS
    statics.BULK_REDIAL_DELAY_MS = 300
    daemon = await createMockDaemon()
    daemon.omitCapabilities(QUIET_LINK)
    for (const cmd of ['fs.writePart', 'gateway-result', 'replica.sync']) daemon.answerWith(cmd, { ok: true })
    forwards = []
  })

  afterEach(async () => {
    statics.BULK_REDIAL_DELAY_MS = savedRedial
    _setBulkForwardForTesting(null)
    try { conn.disconnect() } catch { /* best effort */ }
    for (const f of forwards) f.stop()
    await daemon.stop()
  })

  async function connectWithForward(pace?: { bytesPerSec: number; burstBytes: number }): Promise<void> {
    _setBulkForwardForTesting(async () => {
      const f = await proxyForward(daemon.port)
      forwards.push(f)
      return pace ? pacedForward(f, pace) : f
    })
    conn = new DaemonConnection('paced-gate-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel up')
  }

  /** A relay answer whose gzipped result stays over the 64 KB that sends it down the bulk channel. */
  const bigAnswer = (relayId: number, randomBytes = 72 * KB) =>
    ({ relayId, result: { blob: crypto.randomBytes(randomBytes).toString('base64') } })

  it('P1: a frame that alone takes longer than the host waits is refused at once; the channel goes on', async () => {
    const pace = 8 * KB
    await connectWithForward({ bytesPerSec: pace, burstBytes: 8 * KB })
    const bytes = 900 * KB
    expect(bytes / pace).toBeGreaterThan(UPLOAD_FRAME_MAX_SECS)
    daemon.clearCommandHistory()
    const startedAt = Date.now()
    const err = await conn.send('fs.writePart', part(0, bytes)).then(() => null, (e: Error) => e)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(err).toBeInstanceOf(PacedFrameTooSlowError)
    expect(err?.message).toMatch(/takes about \d+ s to go up/)
    expect(err?.message).toMatch(/Nothing was sent/)
    expect(daemon.getCommandHistoryFor('fs.writePart')).toEqual([])
    // Nothing was cut: the same forward, the bulk channel up, and a small upload goes on it.
    expect(forwards).toHaveLength(1)
    expect(conn.bulkChannelActive).toBe(true)
    await conn.send('fs.writePart', part(1, 1 * KB))
    const sent = daemon.getCommandHistoryFor('fs.writePart')
    expect(sent).toHaveLength(1)
    expect(sent[0].connIndex).toBe(1)
    expect(forwards).toHaveLength(1)
  }, 30_000)

  it('P2: a burst of uploads arrives in order, and what is ahead stays a few seconds of the pace', async () => {
    const pace = 64 * KB
    const frame = 32 * KB
    const count = 8
    // More than the ahead budget plus one frame, so the gate has to hold some back.
    expect(count * frame).toBeGreaterThan(AHEAD_MAX_SECS * pace + frame)
    await connectWithForward({ bytesPerSec: pace, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    let maxAhead = 0
    let sawWaiting = false
    const sampler = setInterval(() => {
      maxAhead = Math.max(maxAhead, inner().bulkQueuedUp())
      if (inner().pacedGate.waiting > 0) sawWaiting = true
    }, 50)
    try {
      const sends = Array.from({ length: count }, (_, i) => conn.send('fs.writePart', part(i, frame)))
      await Promise.all(sends)
    } finally { clearInterval(sampler) }
    const offsets = daemon.getCommandHistoryFor('fs.writePart').map((c) => c.payload.offset)
    expect(offsets).toEqual(Array.from({ length: count }, (_, i) => i))
    expect(sawWaiting).toBe(true)
    // The frame's JSON is a little over its data.
    expect(maxAhead).toBeLessThanOrEqual(AHEAD_MAX_SECS * pace + frame + 2 * KB)
    expect(maxAhead).toBeGreaterThan(0)
  }, 30_000)

  it('P3: a relay answer sent while uploads wait reaches the host before them, with its real result', async () => {
    const pace = 64 * KB
    const frame = 32 * KB
    const count = 8
    await connectWithForward({ bytesPerSec: pace, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    const sends = Array.from({ length: count }, (_, i) => conn.send('fs.writePart', part(i, frame)))
    await waitFor(() => inner().pacedGate.waiting >= 2, 5_000, 'uploads waiting in the gate')
    const sentAt = Date.now()
    const sent = await inner().sendGatewayResult(bigAnswer(7), 7, { reply: Promise.resolve({}) }, { answerBy: Date.now() + 20_000 })
    await Promise.all(sends)
    expect(sent).toBe(true)
    expect(Date.now() - sentAt).toBeLessThan(15_000)
    const history = daemon.getCommandHistory()
    const answerAt = history.findIndex((c) => c.cmd === 'gateway-result')
    expect(answerAt).toBeGreaterThanOrEqual(0)
    const lastPartAt = history.map((c) => c.cmd).lastIndexOf('fs.writePart')
    expect(answerAt).toBeLessThan(lastPartAt)
    const answer = history[answerAt]
    expect(answer.connIndex).toBe(1)
    // Its real result (gzipped or not), not the small error.
    expect(answer.payload.detail).toBeUndefined()
    expect(answer.payload.error).toBeUndefined()
    expect(answer.payload.resultGz !== undefined || answer.payload.result !== undefined).toBe(true)
    // Every upload still arrived, in order.
    expect(daemon.getCommandHistoryFor('fs.writePart').map((c) => c.payload.offset)).toEqual(Array.from({ length: count }, (_, i) => i))
  }, 30_000)

  it('P4: a relay answer that cannot arrive in time is answered at once with a small error', async () => {
    await connectWithForward({ bytesPerSec: 32 * KB, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    const kept = { reply: Promise.resolve({}) as Promise<Record<string, unknown>> }
    const startedAt = Date.now()
    // About 100 KB at 32 KB/s needs 3 s or more; its caller waits 1.5 s.
    await inner().sendGatewayResult(bigAnswer(9, 80 * KB), 9, kept, { answerBy: Date.now() + 1_500 })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    const answers = daemon.getCommandHistoryFor('gateway-result')
    expect(answers).toHaveLength(1)
    expect(answers[0].payload).toMatchObject({ relayId: 9, errorCode: 'bad_request', detail: { tooSlow: true } })
    expect(answers[0].payload.resultGz).toBeUndefined()
    expect(answers[0].payload.result).toBeUndefined()
    const small = await kept.reply
    expect(small).toMatchObject({ relayId: 9, errorCode: 'bad_request', detail: { tooSlow: true } })
    expect(conn.bulkChannelActive).toBe(true)
    expect(forwards).toHaveLength(1)
  }, 30_000)

  it('P9: the host asking again while an answer still goes up shares that answer: one frame, never a small error past it', async () => {
    await connectWithForward({ bytesPerSec: 32 * KB, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    const kept = { reply: Promise.resolve({}) as Promise<Record<string, unknown>> }
    const about = { answerBy: Date.now() + 20_000, instanceId: 'd-run-1' }
    const first = inner().sendGatewayResult(bigAnswer(11), 11, kept, about)
    // The second ask comes while the first frame is still going up at 32 KB/s.
    await waitFor(() => inner().bulkQueuedUp() > 0, 5_000, 'the first answer written and going up')
    const again = inner().sendGatewayResult(bigAnswer(11), 11, kept, about)
    expect(await Promise.all([first, again])).toEqual([true, true])
    const answers = daemon.getCommandHistoryFor('gateway-result')
    expect(answers).toHaveLength(1)
    expect(answers[0].payload.detail).toBeUndefined()
    expect(answers[0].payload.resultGz ?? answers[0].payload.result).toBeDefined()
    // Once it went, a new ask sends again (a lost link's resend must still reach the host).
    await inner().sendGatewayResult(bigAnswer(11), 11, kept, about)
    expect(daemon.getCommandHistoryFor('gateway-result')).toHaveLength(2)
  }, 30_000)

  it('P10: what is ahead counts bytes, not characters: a Chinese note is three bytes a character', async () => {
    await connectWithForward({ bytesPerSec: 256 * KB, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    const written = () => (conn as unknown as { bulkOwnWritten: number }).bulkOwnWritten
    const before = written()
    const chars = 120 * KB
    await conn.send('fs.writePart', { path: '/tmp/x', offset: 0, data: '\u4f60'.repeat(chars) })
    expect(written() - before).toBeGreaterThanOrEqual(3 * chars)
  }, 30_000)

  it('P5: with no pace nothing is gated; a big frame goes as before', async () => {
    await connectWithForward()
    daemon.clearCommandHistory()
    // Over what the paced rules would refuse at any pace of a few KB/s.
    await conn.send('fs.writePart', part(0, 900 * KB))
    await inner().sendGatewayResult(bigAnswer(5), 5, { reply: Promise.resolve({}) }, { answerBy: Date.now() + 1_000 })
    const sent = daemon.getCommandHistoryFor('fs.writePart')
    expect(sent).toHaveLength(1)
    expect(sent[0].connIndex).toBe(1)
    expect(String(sent[0].payload.data).length).toBe(900 * KB)
    const answers = daemon.getCommandHistoryFor('gateway-result')
    expect(answers).toHaveLength(1)
    expect(answers[0].payload.detail).toBeUndefined()
    expect(inner().pacedGate.waiting).toBe(0)
  }, 30_000)

  describe('P6: a manifest goes gzipped to a daemon that reads it', () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({ path: `notes/topic-${i}/note-${crypto.randomBytes(4).toString('hex')}.md`, title: `Note number ${i}`, mtime: 1_700_000_000_000 + i }))
    const manifest = { home: '/h', kind: 'notes', entries }

    /** What the bulk socket wrote, as text. */
    function tapBulkWire(): string[] {
      const wire: string[] = []
      const ws = inner().bulkWs
      const original = ws.send.bind(ws)
      ws.send = (m: unknown, ...rest: unknown[]) => { if (typeof m === 'string') wire.push(m); return original(m, ...rest) }
      return wire
    }

    it('with the capability: listsGz on the wire, plain lists in the host history', async () => {
      expect(JSON.stringify(entries).length).toBeGreaterThanOrEqual(16 * KB)
      await connectWithForward()
      const wire = tapBulkWire()
      daemon.clearCommandHistory()
      await conn.send('replica.sync', manifest)
      const frames = wire.filter((m) => m.includes('"replica.sync"'))
      expect(frames).toHaveLength(1)
      expect(frames[0]).toContain('"listsGz"')
      expect(frames[0]).not.toContain('"entries"')
      expect(frames[0].length).toBeLessThan(JSON.stringify(entries).length / 2)
      const got = daemon.getCommandHistoryFor('replica.sync')
      expect(got).toHaveLength(1)
      expect(got[0].payload.listsGz).toBeUndefined()
      expect(got[0].payload.entries).toEqual(entries)
    }, 30_000)

    it('without the capability: the lists go plain', async () => {
      daemon.omitCapabilities([REPLICA_SYNC_GZ_CAPABILITY, ...QUIET_LINK])
      await connectWithForward()
      const wire = tapBulkWire()
      daemon.clearCommandHistory()
      await conn.send('replica.sync', manifest)
      const frames = wire.filter((m) => m.includes('"replica.sync"'))
      expect(frames).toHaveLength(1)
      expect(frames[0]).not.toContain('"listsGz"')
      expect(frames[0]).toContain('"entries"')
      expect(daemon.getCommandHistoryFor('replica.sync')[0].payload.entries).toEqual(entries)
    }, 30_000)
  })

  it('P8: the bulk socket closing while uploads wait fails them at once as "no link", unsent', async () => {
    statics.BULK_REDIAL_DELAY_MS = 60_000 // no new socket for what failed to find
    const pace = 64 * KB
    const frame = 32 * KB
    const count = 8
    await connectWithForward({ bytesPerSec: pace, burstBytes: 8 * KB })
    daemon.clearCommandHistory()
    const settled = Array.from({ length: count }, (_, i) =>
      conn.send('fs.writePart', part(i, frame)).then(() => ({ i, err: null as Error | null }), (err: Error) => ({ i, err })))
    await waitFor(() => inner().pacedGate.waiting >= 2, 5_000, 'uploads waiting in the gate')
    const cutAt = Date.now()
    forwards[0].cut()
    const results = await Promise.all(settled)
    expect(Date.now() - cutAt).toBeLessThan(3_000)
    const noLink = results.filter((r) => r.err && linkFailureKind(r.err) === 'no-link')
    expect(noLink.length).toBeGreaterThanOrEqual(2)
    expect(noLink.every((r) => /nothing of them was sent|nothing was sent/.test(r.err!.message))).toBe(true)
    // None of those reached the host, and the ones that did are all from before them.
    const arrived = daemon.getCommandHistoryFor('fs.writePart').map((c) => c.payload.offset as number)
    for (const r of noLink) expect(arrived).not.toContain(r.i)
    // Every upload ended one way or the other: the gate holds none.
    expect(results.every((r) => r.err !== null || arrived.includes(r.i))).toBe(true)
    expect(inner().pacedGate.waiting).toBe(0)
  }, 30_000)
})

// ── P7: the class guard ──────────────────────────────────────────────────────

/**
 * Socket writes that can reach the bulk socket and are not behind the gate. A "bulk write" is a
 * `.send(` / `.sendFrame(` on a receiver named like the bulk socket (`bulkWs`, `bulkSocket`), or
 * on a local that was assigned from one in the same method (`sentOn = bulkSocket ?? this.ws`).
 * Each must sit in `sendOnce`, after its `pacedGate.admit(`.
 */
function ungatedBulkWrites(source: string): { writes: number; violations: string[] } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1')
  const header = /^(?: {2}(?:(?:private|public|protected|static|readonly|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>\n]*>)?\(|(?:export\s+)?(?:async\s+)?function\s+[\w$]+)/gm
  const starts: Array<{ at: number; name: string }> = []
  for (let m = header.exec(code); m; m = header.exec(code)) {
    starts.push({ at: m.index, name: /([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\($/.exec(m[0])?.[1] ?? /function\s+([\w$]+)/.exec(m[0])?.[1] ?? '?' })
  }
  const violations: string[] = []
  let writes = 0
  starts.forEach((s, k) => {
    const body = code.slice(s.at, starts[k + 1]?.at ?? code.length)
    const names = new Set(['bulkWs', 'bulkSocket'])
    for (const m of body.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\b(?:bulkWs|bulkSocket)\b/g)) names.add(m[1])
    for (const m of body.matchAll(/([A-Za-z_$][\w$.?!]*)\.send(?:Frame)?\(/g)) {
      const receiver = m[1].replace(/[?!]/g, '').split('.').pop()!
      if (!names.has(receiver) && !/bulk/i.test(receiver)) continue
      writes++
      const gated = s.name === 'sendOnce' && body.slice(0, m.index).includes('pacedGate.admit(')
      if (!gated) violations.push(`${s.name}: ${m[0]}`)
    }
  })
  return { writes, violations }
}

describe('P7: every write that can reach the bulk socket is in sendOnce, after the gate', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../src/providers/daemon-connection.ts', import.meta.url)), 'utf8')

  it('daemon-connection.ts has no bulk write outside the gate', () => {
    const { writes, violations } = ungatedBulkWrites(source)
    // The scan must still see the writes sendOnce makes (a scan gone blind proves nothing).
    expect(writes).toBeGreaterThanOrEqual(2)
    expect(violations).toEqual([])
  })

  it('the scan catches a write that skips the gate', () => {
    const gated = `export class C {
  private async sendOnce(cmd: string) {
    const sentOn = bulkSocket ?? this.ws
    await this.pacedGate.admit(1)
    sentOn.send(message)
  }
}`
    expect(ungatedBulkWrites(gated)).toEqual({ writes: 1, violations: [] })
    const beforeGate = gated.replace('await this.pacedGate.admit(1)\n    sentOn.send(message)', 'sentOn.send(message)\n    await this.pacedGate.admit(1)')
    expect(ungatedBulkWrites(beforeGate).violations).toHaveLength(1)
    const otherMethod = `${gated.slice(0, -2)}
  private flush(message: string) {
    this.bulkWs.send(message)
  }
}`
    expect(ungatedBulkWrites(otherMethod).violations).toEqual(['flush: this.bulkWs.send('])
    const alias = `${gated.slice(0, -2)}
  private flush(message: string) {
    const out = this.bulkWs
    out.send(message)
  }
}`
    expect(ungatedBulkWrites(alias).violations).toEqual(['flush: out.send('])
    // A write on the session socket, or in a comment, is not one.
    const session = `${gated.slice(0, -2)}
  private ping() {
    // this.bulkWs.send(x)
    this.ws.send('ping')
  }
}`
    expect(ungatedBulkWrites(session).violations).toEqual([])
  })
})
