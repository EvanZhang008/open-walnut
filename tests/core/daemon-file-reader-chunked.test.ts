/**
 * DaemonFileReader chunked-read regression tests
 * (inc-1783532915925 remote, inc-1783842393500 local).
 *
 * Root cause under test: whole-file fs.read serialized into ONE WebSocket
 * frame. Remote: corp SSH proxies kill giant frames mid-transfer (11.4MB JSONL,
 * seen only as a pong gap + 30s read timeout). Local: the ws client's default
 * maxPayload (100MB) hard-kills the connection (134MB JSONL → "Max payload
 * size exceeded" + daemon connection bounced on every open).
 * Fix: readFile() stats first and switches to fs.readRange 1MB chunks above
 * CHUNK_THRESHOLD — for ALL hosts, __local__ included. These tests pin:
 *   - byte-exact reassembly (a range boundary can split a UTF-8 multi-byte char)
 *   - small files keep the plain fs.read path
 *   - stat failure degrades to plain fs.read (old daemons)
 *   - ENOENT stays null (not a throw)
 *   - local host chunks exactly like remote (no proxy ≠ no frame limit)
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

  it('findSession routes through readFile — a found whale chunks via fs.readRange (the actual incident path)', async () => {
    // Hashed-cwd sessions (encoded cwd >200 chars) have no exactPath and the
    // glob dir contains a literal '*' that fs.find can't readdir — so history
    // loads land in findSession(). It must NOT do a one-frame fs.read.
    const content = 'x'.repeat(CHUNK_THRESHOLD + 100)
    const fileBuf = Buffer.from(content, 'utf-8')
    serveFile(fileBuf)
    sendMock.mockImplementationOnce(async (cmd: string) => {
      expect(cmd).toBe('fs.find')
      return { ok: true, files: ['/home/u/.claude/projects/enc/sid.jsonl'] }
    })

    const reader = new DaemonFileReader('clouddev')
    const result = await reader.findSession('sid')

    expect(result).not.toBeNull()
    expect(result!.content).toBe(content)
    expect(result!.path).toBe('/home/u/.claude/projects/enc/sid.jsonl')
    expect(callsFor('fs.read')).toHaveLength(0)
    expect(callsFor('fs.readRange').length).toBeGreaterThan(1)
  })

  it('local whale (__local__, > CHUNK_THRESHOLD) chunks via fs.readRange — inc-1783842393500 (134MB one-frame fs.read exceeded ws maxPayload)', async () => {
    const content = 'x'.repeat(CHUNK_THRESHOLD + CHUNK_SIZE / 2)
    const fileBuf = Buffer.from(content, 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('__local__')
    const result = await reader.readFile('/local/whale.jsonl')

    expect(result).toBe(content)
    expect(callsFor('fs.read')).toHaveLength(0) // the incident path — must not be taken
    expect(callsFor('fs.readRange')).toHaveLength(Math.ceil(fileBuf.length / CHUNK_SIZE))
  })

  it('small local file keeps the plain fs.read path (stat, then one fs.read)', async () => {
    const fileBuf = Buffer.from('local content', 'utf-8')
    serveFile(fileBuf)

    const reader = new DaemonFileReader('__local__')
    const result = await reader.readFile('/local/file.jsonl')

    expect(result).toBe('local content')
    expect(callsFor('fs.readRange')).toHaveLength(0)
    expect(callsFor('fs.read')).toHaveLength(1)
  })
})

/**
 * GUARDRAIL. The concurrency gate bounds how MANY whole-file reads run at once; it
 * never bounded how BIG one may be. A single unbounded read drove ~3 GB RSS within
 * minutes of boot (533 reads / 9.56 GB in one day; the largest session JSONL grew
 * 34.9 MB → 174.9 MB in two days and keeps growing with age).
 *
 * These tests exist so that reintroducing an unbounded whole-file read FAILS CI.
 * The contract is REJECT, never truncate: a silently truncated transcript parses
 * fine and looks successful, corrupting history in ways far harder to diagnose.
 */
describe('DaemonFileReader byte ceiling (guardrail)', () => {
  const withLimit = async <T>(bytes: number, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.WALNUT_MAX_FILE_READ_BYTES
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(bytes)
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES
      else process.env.WALNUT_MAX_FILE_READ_BYTES = prev
    }
  }

  it('REJECTS a whole-file read over the ceiling instead of truncating', async () => {
    const fileBuf = Buffer.alloc(6 * 1024 * 1024, 'a')
    serveFile(fileBuf)

    await withLimit(4 * 1024 * 1024, async () => {
      const reader = new DaemonFileReader('__local__')
      await expect(reader.readFile('/whale.jsonl')).rejects.toThrow(/byte ceiling/)
    })
  })

  it('fails fast on a known-oversized file — no transfer, no concurrency slot spent', async () => {
    const fileBuf = Buffer.alloc(6 * 1024 * 1024, 'a')
    serveFile(fileBuf)

    await withLimit(4 * 1024 * 1024, async () => {
      const reader = new DaemonFileReader('__local__')
      await expect(reader.readFile('/whale.jsonl')).rejects.toThrow(/byte ceiling/)
      // stat told us the size; nothing should have been pulled over the wire.
      expect(callsFor('fs.readRange')).toHaveLength(0)
    })
  })

  it('a file UNDER the ceiling still reads completely and byte-exactly', async () => {
    const content = '好'.repeat(400_000) // ~1.2 MB, multi-byte
    const fileBuf = Buffer.from(content, 'utf-8')
    serveFile(fileBuf)

    await withLimit(4 * 1024 * 1024, async () => {
      const reader = new DaemonFileReader('__local__')
      await expect(reader.readFile('/normal.jsonl')).resolves.toBe(content)
    })
  })

  it('a BOUNDED WINDOW of a huge file is still allowed — tail readers must not be broken', async () => {
    // 20 MB file, 4 MB ceiling: readFileRange from near EOF pulls only its window.
    const fileBuf = Buffer.alloc(20 * 1024 * 1024, 'b')
    serveFile(fileBuf)

    await withLimit(4 * 1024 * 1024, async () => {
      const reader = new DaemonFileReader('__local__')
      const res = await reader.readFileRange('/whale.jsonl', fileBuf.length - 1024 * 1024)
      expect(res).not.toBeNull()
      expect(res!.content).toHaveLength(1024 * 1024)
    })
  })

  it('rejects a range read whose window itself exceeds the ceiling', async () => {
    const fileBuf = Buffer.alloc(20 * 1024 * 1024, 'b')
    serveFile(fileBuf)

    await withLimit(4 * 1024 * 1024, async () => {
      const reader = new DaemonFileReader('__local__')
      // start=0 ⇒ the "window" is the whole 20 MB file.
      await expect(reader.readFileRange('/whale.jsonl', 0)).rejects.toThrow(/byte ceiling/)
    })
  })

  it('defaults to a ceiling above the 4 MB history tail window and below whale sizes', () => {
    const limit = (DaemonFileReader as unknown as { maxReadBytes(): number }).maxReadBytes()
    expect(limit).toBeGreaterThan(4 * 1024 * 1024)
    expect(limit).toBeLessThan(100 * 1024 * 1024)
  })

  it('honors WALNUT_MAX_FILE_READ_BYTES and ignores a garbage value', async () => {
    await withLimit(7_000_000, async () => {
      expect((DaemonFileReader as unknown as { maxReadBytes(): number }).maxReadBytes()).toBe(7_000_000)
    })
    const prev = process.env.WALNUT_MAX_FILE_READ_BYTES
    process.env.WALNUT_MAX_FILE_READ_BYTES = 'not-a-number'
    try {
      // Garbage must fall back to the default, not to 0 (which would block all reads).
      expect((DaemonFileReader as unknown as { maxReadBytes(): number }).maxReadBytes()).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES
      else process.env.WALNUT_MAX_FILE_READ_BYTES = prev
    }
  })
})
