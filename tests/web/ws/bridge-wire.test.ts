/**
 * The replica's side of the bridge wire (src/web/ws/bridge-wire.ts): chunked
 * frames come back byte for byte, bad or runaway assemblies are dropped, and the
 * dialer's address is read from the reverse proxy's header first.
 */
import { describe, it, expect, vi } from 'vitest'
import { createChunkAssembler, bridgeClientIp, newBridgeWireStats, noteFrameIn, noteFrameOut, logBridgeHostClosed } from '../../../src/web/ws/bridge-wire.js'
import { log } from '../../../src/logging/index.js'

const cut = (frame: string, cid: string, size: number): Array<Record<string, unknown>> => {
  const n = Math.ceil(frame.length / size)
  return Array.from({ length: n }, (_, i) => ({ ev: 'chunk', cid, i, n, part: frame.slice(i * size, (i + 1) * size) }))
}

describe('createChunkAssembler', () => {
  it('rebuilds the original frame, including a surrogate pair cut in half', () => {
    const a = createChunkAssembler()
    const frame = JSON.stringify({ id: 7, ok: true, main: 'café 😀 '.repeat(5000) })
    const parts = cut(frame, 'c1', 1001) // odd size: lands inside surrogate pairs
    // Parts round-trip through JSON on the wire.
    const results = parts.map((p) => a.accept(JSON.parse(JSON.stringify(p)) as Record<string, unknown>))
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true)
    expect(results.at(-1)).toBe(frame)
  })

  it('keeps interleaved assemblies apart', () => {
    const a = createChunkAssembler()
    const one = cut('A'.repeat(50), 'x', 10)
    const two = cut('B'.repeat(30), 'y', 10)
    const out: Array<string | null> = []
    for (let i = 0; i < 5; i++) {
      out.push(a.accept(one[i]))
      if (two[i]) out.push(a.accept(two[i]))
    }
    expect(out.filter((r) => r !== null)).toEqual(['B'.repeat(30), 'A'.repeat(50)])
  })

  it('ignores malformed envelopes and duplicate parts', () => {
    const a = createChunkAssembler()
    expect(a.accept({ ev: 'chunk', cid: 'z', i: 3, n: 2, part: 'x' })).toBeNull()
    expect(a.accept({ ev: 'chunk', cid: 'z', i: 0, n: 2, part: 42 })).toBeNull()
    expect(a.accept({ ev: 'chunk', cid: 'z', i: 0, n: 2, part: 'a' })).toBeNull()
    expect(a.accept({ ev: 'chunk', cid: 'z', i: 0, n: 2, part: 'EVIL' })).toBeNull()
    expect(a.accept({ ev: 'chunk', cid: 'z', i: 1, n: 2, part: 'b' })).toBe('ab')
  })

  it('bounds all open assemblies of one socket together, oldest dropped first', () => {
    // Each assembly stays under its own 64 MB cap, but two of them together would
    // pass the socket's 96 MB. Parts reuse one string, so the test holds 8 MB.
    const warn = vi.spyOn(log.ws, 'warn').mockImplementation(() => {})
    try {
      const a = createChunkAssembler()
      const part = 'x'.repeat(8 * 1024 * 1024)
      for (let i = 0; i < 7; i++) expect(a.accept({ ev: 'chunk', cid: 'big-old', i, n: 8, part })).toBeNull() // 56 MB
      for (let i = 0; i < 6; i++) expect(a.accept({ ev: 'chunk', cid: 'big-new', i, n: 7, part })).toBeNull() // 48 MB
      expect(warn).toHaveBeenCalledWith('bridge: dropped an unfinished chunked frame (socket over its byte cap)', expect.objectContaining({ cid: 'big-old' }))
      // big-old is gone: its last part starts a fresh, incomplete assembly.
      expect(a.accept({ ev: 'chunk', cid: 'big-old', i: 7, n: 8, part })).toBeNull()
      // big-new is intact and completes.
      expect(a.accept({ ev: 'chunk', cid: 'big-new', i: 6, n: 7, part })?.length).toBe(7 * part.length)
    } finally {
      warn.mockRestore()
    }
  })

  it('drops the oldest unfinished assembly past 16 open ones', () => {
    const a = createChunkAssembler()
    for (let k = 0; k < 17; k++) a.accept({ ev: 'chunk', cid: `c${k}`, i: 0, n: 2, part: 'p' })
    expect(a.accept({ ev: 'chunk', cid: 'c0', i: 1, n: 2, part: 'q' })).toBeNull() // c0 was evicted
    expect(a.accept({ ev: 'chunk', cid: 'c16', i: 1, n: 2, part: 'q' })).toBe('pq')
  })
})

describe('bridgeClientIp', () => {
  it('prefers the first X-Forwarded-For hop, then the socket peer', () => {
    expect(bridgeClientIp('203.0.113.9, 10.0.0.2', '127.0.0.1')).toBe('203.0.113.9')
    expect(bridgeClientIp(['198.51.100.4'], '127.0.0.1')).toBe('198.51.100.4')
    expect(bridgeClientIp(undefined, '::1')).toBe('::1')
    expect(bridgeClientIp(' ', undefined)).toBeNull()
  })
})

describe('wire stats', () => {
  it('counts frames and bytes both ways and keeps the biggest inbound frame', () => {
    const s = newBridgeWireStats('127.0.0.1')
    noteFrameIn(s, 10); noteFrameIn(s, 300); noteFrameIn(s, 20)
    noteFrameOut(s, 5)
    expect(s).toMatchObject({ framesIn: 3, bytesRead: 330, maxInFrameBytes: 300, framesOut: 1, bytesWritten: 5, initiator: null })
  })
})

describe('logBridgeHostClosed', () => {
  it('names a socket that was no longer registered (replaced) by the alias its hello claimed', () => {
    const info = vi.spyOn(log.ws, 'info').mockImplementation(() => {})
    try {
      const s = newBridgeWireStats('203.0.113.9')
      s.hostAlias = 'mac'
      s.connId = 'd-1.4'
      s.initiator = 'replaced'
      logBridgeHostClosed(s, { hostAlias: null, code: 4002, reason: 'replaced', pendingRpcs: 0, loopP99Ms: 12 })
      expect(info).toHaveBeenCalledWith('bridge host closed', expect.objectContaining({
        hostAlias: 'mac', connId: 'd-1.4', initiator: 'replaced', code: 4002, clientIp: '203.0.113.9', loopP99Ms: 12,
      }))
    } finally {
      info.mockRestore()
    }
  })
})
