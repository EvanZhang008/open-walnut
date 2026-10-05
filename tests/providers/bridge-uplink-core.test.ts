/**
 * The daemon bridge uplink (src/providers/bridge-uplink-core.ts): what the
 * replica has not confirmed never exceeds the high-water mark.
 *
 * Field shape (Mac uplink, 2026-09-25/26): the 5-minute projection self-heal
 * wrote ~1.7MB of mobile-event frames (a 1.5MB task list, 158KB of sessions,
 * live transcripts) into the bridge socket at once, and flaps clustered within a
 * second of those ticks. Here a simulated replica receives every written frame,
 * echoes each marker after a delay, and measures, from ITS side, how many bytes
 * were on the wire past its last confirmation. Fake clock; no sockets.
 */
import { describe, it, expect } from 'vitest'
import { createBridgeUplink, createLoopDriftProbe } from '../../src/providers/bridge-uplink-core.js'

const HWM = 1024 * 1024
const MiB = 1024 * 1024

interface Timer { at: number; fn: () => void; id: number }

function harness(opts?: { echo?: 'seq' | 'fifo' | 'none'; ackDelayMs?: number; chunkBytes?: number; maxQueueBytes?: number }) {
  let now = 0
  let nextId = 0
  const timers: Timer[] = []
  const setTimer = (fn: () => void, ms: number): number => { const t = { at: now + ms, fn, id: ++nextId }; timers.push(t); return t.id }
  const clearTimer = (id: unknown): void => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
  const wire: string[] = []
  let received = 0
  let confirmed = 0
  let worst = 0
  let overflowed: number | null = null
  const echo = opts?.echo ?? 'seq'
  const up = createBridgeUplink({
    write: (frame) => {
      wire.push(frame)
      received += Buffer.byteLength(frame)
      worst = Math.max(worst, received - confirmed)
      if (frame.startsWith('{"ev":"bridge-ping"') && echo !== 'none') {
        const seq = (JSON.parse(frame) as { seq: number }).seq
        const covered = received
        setTimer(() => { confirmed = Math.max(confirmed, covered); up.ack(echo === 'seq' ? seq : undefined) }, opts?.ackDelayMs ?? 40)
      }
    },
    now: () => now,
    setTimer,
    clearTimer,
    onOverflow: (q) => { overflowed = q },
  }, opts?.maxQueueBytes ? { maxQueueBytes: opts.maxQueueBytes } : undefined)
  if (opts?.chunkBytes) up.setChunkBytes(opts.chunkBytes)
  const run = (ms: number): void => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
  }
  return { up, wire, run, get worst() { return worst }, get overflowed() { return overflowed }, get now() { return now } }
}

/** Reassemble chunk envelopes back into whole frames (the replica's job). */
function frames(wire: string[]): string[] {
  const out: string[] = []
  const open = new Map<string, string[]>()
  for (const f of wire) {
    if (f.startsWith('{"ev":"bridge-ping"')) continue
    if (f.startsWith('{"ev":"chunk"')) {
      const c = JSON.parse(f) as { cid: string; i: number; n: number; part: string }
      const parts = open.get(c.cid) ?? []
      parts[c.i] = c.part
      open.set(c.cid, parts)
      if (parts.filter((p) => p !== undefined).length === c.n) { out.push(parts.join('')); open.delete(c.cid) }
      continue
    }
    out.push(f)
  }
  return out
}

/** The self-heal burst: one 1.5MB task list, 158KB of sessions, 10 transcripts of 35KB. */
function selfHealBurst(): string[] {
  const ev = (kind: string, fill: string, n: number): string =>
    JSON.stringify({ ev: 'mobile-event', kind, data: { rows: fill.repeat(n) } })
  return [
    ev('projection-upsert', '{"id":"t","title":"a task"},', 1.5 * MiB / 26),
    ev('projection-upsert', 's', 158 * 1024),
    ...Array.from({ length: 10 }, (_, i) => ev('transcript-upsert', String(i), 35 * 1024)),
  ]
}

describe('flow control', () => {
  it('a 2MB burst never puts more than the high-water mark on the wire unconfirmed (chunked peer)', () => {
    const h = harness({ chunkBytes: 256 * 1024 })
    const burst = selfHealBurst()
    const total = burst.reduce((n, f) => n + Buffer.byteLength(f), 0)
    expect(total).toBeGreaterThan(1.9 * MiB)
    const outcomes = burst.map((f) => h.up.send(f))
    expect(outcomes).toContain('queued')
    expect(h.up.queuedBytes).toBeGreaterThan(0)
    h.run(10_000)
    expect(h.up.queuedBytes).toBe(0)
    expect(h.worst).toBeLessThanOrEqual(HWM)
    // Nothing lost, nothing reordered, nothing re-cut.
    expect(frames(h.wire)).toEqual(burst)
    // Every frame on the wire is a chunk-sized frame.
    const biggest = Math.max(...h.wire.map((f) => Buffer.byteLength(f)))
    expect(biggest).toBeLessThanOrEqual(256 * 1024)
    const snap = h.up.snapshot()
    expect(snap.bufferedAmountPeak).toBeLessThanOrEqual(HWM)
    expect(snap.maxOutFrameKind).toBe('chunk')
    expect(snap.rttMsP50).toBe(40)
    expect(snap.chunkedFrames).toBe(1) // only the task list is over the chunk size
  })

  it('an old replica (no chunks, plain in-order pings) still paces: an oversized frame goes alone', () => {
    const h = harness({ echo: 'fifo' })
    const burst = selfHealBurst()
    for (const f of burst) h.up.send(f)
    h.run(10_000)
    expect(frames(h.wire)).toEqual(burst)
    // The 1.5MB frame is bigger than the mark, so it may exceed it, but only alone.
    expect(h.worst).toBeLessThanOrEqual(Buffer.byteLength(burst[0]) + 128)
    const before = h.wire.indexOf(burst[0])
    expect(before).toBe(0)
    // What followed it waited for its confirmation.
    const next = h.wire.findIndex((f, i) => i > before && !f.startsWith('{"ev":"bridge-ping"'))
    expect(h.wire.slice(before + 1, next).some((f) => f.startsWith('{"ev":"bridge-ping"'))).toBe(true)
  })

  it('small interactive frames go straight out while nothing is waiting', () => {
    const h = harness()
    expect(h.up.send('{"ev":"jsonl","line":"x"}')).toBe('sent')
    expect(h.up.send('{"id":3,"ok":true}')).toBe('sent')
    expect(h.wire).toEqual(['{"ev":"jsonl","line":"x"}', '{"id":3,"ok":true}'])
  })

  it('a confirmation that never comes releases the window after the ack timeout (fail open)', () => {
    const h = harness({ echo: 'none' })
    h.up.send('x'.repeat(HWM))
    expect(h.up.send('after')).toBe('queued')
    h.run(14_000)
    expect(h.wire).not.toContain('after')
    h.run(2_000)
    expect(h.wire).toContain('after')
    expect(h.up.snapshot().ackTimeouts).toBe(1)
  })

  it('a queue past its cap reports dropped and asks the caller to close', () => {
    const h = harness({ echo: 'none', maxQueueBytes: 3 * MiB })
    h.up.send('x'.repeat(HWM))
    expect(h.up.send('y'.repeat(2 * MiB))).toBe('queued')
    expect(h.up.send('z'.repeat(2 * MiB))).toBe('dropped')
    expect(h.overflowed).toBeGreaterThan(3 * MiB)
    expect(h.up.send('more')).toBe('dropped')
  })

  // On a busy link the marker answers are the only frames the daemon hears, and
  // its watchdog tears the link down 45 to 50 s after the last one. At the
  // replica's 256 KB chunks an envelope is a little under 256 KB, so a 256 KB
  // marker spacing put a marker after every SECOND chunk (about 508 KB apart),
  // and a link under about 11 KB/s was torn down mid-transfer (gate 2026-10-04:
  // a 2 MB reply at 8 KB/s, 8 drops in 420 s and no reply).
  const longestRunWithoutMarker = (wire: string[]): number => {
    let run = 0
    let worst = 0
    for (const f of wire) {
      if (f.startsWith('{"ev":"bridge-ping"')) { run = 0; continue }
      run += Buffer.byteLength(f)
      worst = Math.max(worst, run)
    }
    return worst
  }
  it('a marker follows every chunk of a large reply', () => {
    const h = harness({ chunkBytes: 256 * 1024 })
    h.up.send(JSON.stringify({ id: 7, ok: true, data: 'r'.repeat(2 * MiB) }))
    h.run(60_000)
    expect(h.up.queuedBytes).toBe(0)
    const chunks = h.wire.filter((f) => f.startsWith('{"ev":"chunk"'))
    expect(chunks.length).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < h.wire.length - 1; i++) {
      if (h.wire[i].startsWith('{"ev":"chunk"')) expect(h.wire[i + 1].startsWith('{"ev":"bridge-ping"')).toBe(true)
    }
    expect(longestRunWithoutMarker(h.wire)).toBeLessThanOrEqual(256 * 1024)
  })
  it('a stream of small frames gets a marker every 64 KB', () => {
    const h = harness()
    const frame = JSON.stringify({ ev: 'jsonl', line: 'l'.repeat(10 * 1024) })
    for (let i = 0; i < 100; i++) h.up.send(frame)
    h.run(60_000)
    expect(h.up.queuedBytes).toBe(0)
    expect(longestRunWithoutMarker(h.wire)).toBeLessThan(64 * 1024 + Buffer.byteLength(frame))
  })

  it('the keepalive ping is a marker, and its echo measures the round trip', () => {
    const h = harness({ ackDelayMs: 120 })
    h.up.send('{"ev":"hello"}')
    h.up.ping()
    h.run(200)
    const snap = h.up.snapshot()
    expect(snap.rttMsP50).toBe(120)
    expect(snap.rttMsMax).toBe(120)
    expect(snap.bufferedAmountAtClose).toBe(0)
  })

  it('clamps the peer chunk size and turns chunking off for zero', () => {
    const h = harness()
    expect(h.up.setChunkBytes(1)).toBe(16 * 1024)
    expect(h.up.setChunkBytes(10 * MiB)).toBe(512 * 1024)
    expect(h.up.setChunkBytes('lots')).toBe(0)
  })
})

describe('loop drift probe', () => {
  it('reports how late the 500ms tick fired, over 5s and 60s windows', () => {
    let now = 0
    let tick: (() => void) | null = null
    const probe = createLoopDriftProbe({ now: () => now, setInterval: (fn) => { tick = fn; return 1 }, clearInterval: () => { tick = null } })
    probe.start()
    const fire = (at: number): void => { now = at; tick?.() }
    fire(500); fire(1000); fire(2800) // the loop was blocked for 1.3s
    expect(probe.max5s()).toBe(1300)
    fire(3300); fire(20_000)
    expect(probe.max5s()).toBe(16_200)
    now = 70_000
    expect(probe.max60s()).toBe(16_200)
    now = 81_000
    expect(probe.max60s()).toBe(0)
    probe.stop()
    expect(tick).toBeNull()
  })
})
