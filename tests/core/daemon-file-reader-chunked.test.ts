/**
 * DaemonFileReader chunked-read regression tests (inc-1783532915925).
 *
 * Root cause under test: whole-file fs.read of a >10MB session JSONL serialized
 * into ONE WebSocket frame, which corp SSH proxies kill mid-transfer — the
 * client only sees a pong gap + 30s read timeout, and history never loads.
 * Fix: readFile() stats first and switches to fs.readRange 1MB chunks above
 * CHUNK_THRESHOLD. These tests pin the chunking protocol:
 *   - byte-exact reassembly (a range boundary can split a UTF-8 multi-byte char)
 *   - small files / local host keep the plain fs.read path
 *   - stat failure degrades to plain fs.read (old daemons)
 *   - ENOENT stays null (not a throw)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: sendMock }),
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    hosts: { clouddev: { hostname: 'remote.example.com', user: 'u' } },
  }),
}))

import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'

const CHUNK_SIZE = (DaemonFileReader as unknown as { CHUNK_SIZE: number }).CHUNK_SIZE
const CHUNK_THRESHOLD = (DaemonFileReader as unknown as { CHUNK_THRESHOLD: number }).CHUNK_THRESHOLD

/** Wire sendMock to serve `fileBuf` as the remote file (stat + readRange + read). */
function serveFile(fileBuf: Buffer, opts?: { failStat?: boolean; missing?: boolean }) {
  sendMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'fs.stat') {
      if (opts?.failStat) return { ok: false, error: 'fs.stat failed: unknown command' }
      if (opts?.missing) return { ok: true, exists: false }
      return { ok: true, exists: true, mtimeMs: 1, size: fileBuf.length }
    }
    if (cmd === 'fs.readRange') {
      if (opts?.missing) return { ok: false, error: 'fs.readRange failed: no such file (ENOENT)' }
      const start = args.start as number
      const length = args.length as number
      if (start >= fileBuf.length) {
        return { ok: true, data: '', bytesRead: 0, fileSize: fileBuf.length, eof: true }
      }
      const slice = fileBuf.subarray(start, Math.min(start + length, fileBuf.length))
      return {
        ok: true,
        data: slice.toString('base64'),
        bytesRead: slice.length,
        fileSize: fileBuf.length,
        eof: start + slice.length >= fileBuf.length,
      }
    }
    if (cmd === 'fs.read') {
      if (opts?.missing) return { ok: false, error: 'fs.read failed: no such file (ENOENT)' }
      return { ok: true, data: fileBuf.toString('utf-8') }
    }
    throw new Error(`unexpected daemon cmd: ${cmd}`)
  })
}

const callsFor = (cmd: string) => sendMock.mock.calls.filter(c => c[0] === cmd)

beforeEach(() => {
  sendMock.mockReset()
})

describe('DaemonFileReader chunked reads', () => {
  it('whale file (> CHUNK_THRESHOLD) is read via fs.readRange chunks, never one fs.read frame', async () => {
    // 2.5MB of multi-byte content — boundaries WILL split chars.
    const content = '好'.repeat(Math.ceil((CHUNK_THRESHOLD + CHUNK_SIZE / 2) / 3))
    const fileBuf = Buffer.from(content, 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFile('/remote/whale.jsonl')

    expect(result).toBe(content)
    expect(callsFor('fs.read')).toHaveLength(0) // the incident path — must not be taken
    expect(callsFor('fs.readRange')).toHaveLength(Math.ceil(fileBuf.length / CHUNK_SIZE))
  })

  it('reassembles a UTF-8 char split exactly across a chunk boundary (byte-exact, decode-after-concat)', async () => {
    // '好' = 3 bytes. Place its bytes at CHUNK_SIZE-1..CHUNK_SIZE+1 so the first
    // range boundary cuts it in half. Naive per-chunk utf-8 decode would emit
    // U+FFFD replacement chars here.
    const content = 'a'.repeat(CHUNK_SIZE - 1) + '好' + 'b'.repeat(16)
    const fileBuf = Buffer.from(content, 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFileRange('/remote/split.jsonl', 0)

    expect(result).not.toBeNull()
    expect(result!.content).toBe(content)
    expect(result!.content).not.toContain('�')
    expect(result!.fileSize).toBe(fileBuf.length)
  })

  it('readFileRange(start > 0) returns only the appended tail (incremental turn-delta path)', async () => {
    const head = 'x'.repeat(1000)
    const tail = '{"type":"assistant","text":"新增内容"}\n'
    const fileBuf = Buffer.from(head + tail, 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFileRange('/remote/s.jsonl', Buffer.byteLength(head))

    expect(result!.content).toBe(tail)
    expect(result!.fileSize).toBe(fileBuf.length)
  })

  it('small remote file keeps the plain fs.read path (no readRange calls)', async () => {
    const fileBuf = Buffer.from('small file\n', 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFile('/remote/small.jsonl')

    expect(result).toBe('small file\n')
    expect(callsFor('fs.readRange')).toHaveLength(0)
    expect(callsFor('fs.read')).toHaveLength(1)
  })

  it('stat failure (old daemon) degrades to plain fs.read instead of throwing', async () => {
    const fileBuf = Buffer.from('legacy daemon content', 'utf-8')
    serveFile(fileBuf, { failStat: true })

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFile('/remote/legacy.jsonl')

    expect(result).toBe('legacy daemon content')
    expect(callsFor('fs.readRange')).toHaveLength(0)
  })

  it('missing file returns null (stat exists:false short-circuits, no read RPCs)', async () => {
    serveFile(Buffer.alloc(0), { missing: true })

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.readFile('/remote/gone.jsonl')

    expect(result).toBeNull()
    expect(callsFor('fs.read')).toHaveLength(0)
    expect(callsFor('fs.readRange')).toHaveLength(0)
  })

  it('readFileRange ENOENT returns null; other RPC errors throw transport failure', async () => {
    serveFile(Buffer.alloc(0), { missing: true })
    const reader = new DaemonFileReader('clouddev')
    expect(await reader.readFileRange('/remote/gone.jsonl', 0)).toBeNull()

    sendMock.mockImplementation(async () => ({ ok: false, error: 'tunnel died' }))
    await expect(reader.readFileRange('/remote/x.jsonl', 0))
      .rejects.toThrow(/fs.readRange transport failure/)
  })

  it('local host (__local__) never stats or chunks — in-process daemon has no proxy in the path', async () => {
    const fileBuf = Buffer.from('local content', 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('__local__')
    const result = await reader.readFile('/local/file.jsonl')

    expect(result).toBe('local content')
    expect(callsFor('fs.stat')).toHaveLength(0)
    expect(callsFor('fs.readRange')).toHaveLength(0)
  })
})
