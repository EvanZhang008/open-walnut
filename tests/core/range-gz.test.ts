/**
 * fs-read-range-gz-v1: a range read from another host comes gzipped.
 * 2026-11-20: 8 agents paging large transcripts on one dev host moved each older page's
 * 4 MB windows over the tunnel as base64; every page took over 15 s and 41 answered 503.
 * A JSONL window packs 2 to 4 times smaller with gzip level 1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const { sendMock, caps } = vi.hoisted(() => ({ sendMock: vi.fn(), caps: { list: [] as string[] } }))

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: sendMock, hasCapability: (c: string) => caps.list.includes(c) }),
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { devbox: { hostname: 'remote.example.com', user: 'u' } } }),
}))

import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'
import { rangeBytes } from '../../src/core/range-gz.js'

const ROOT = join(import.meta.dirname, '..', '..')
const CHUNK_SIZE = (DaemonFileReader as unknown as { CHUNK_SIZE: number }).CHUNK_SIZE

/** A daemon answering fs.readRange the way the twins do: gzipped when asked and smaller. */
function serve(file: Buffer): void {
  sendMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'fs.stat') return { ok: true, exists: true, mtimeMs: 1, size: file.length }
    if (cmd !== 'fs.readRange') throw new Error(`unexpected ${cmd}`)
    const start = args.start as number
    const slice = file.subarray(start, Math.min(start + (args.length as number), file.length))
    const gz = args.gz === true && slice.length >= 16 * 1024 ? zlib.gzipSync(slice, { level: 1 }) : null
    return {
      ok: true,
      ...(gz && gz.length < slice.length ? { dataGz: gz.toString('base64') } : { data: slice.toString('base64') }),
      bytesRead: slice.length, fileSize: file.length, eof: start + slice.length >= file.length,
    }
  })
}

/** JSONL-like text with a multi-byte char on every line, so chunk seams split characters. */
function jsonl(bytes: number): Buffer {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"\u597d step"}]}}\n'
  return Buffer.from(line.repeat(Math.ceil(bytes / line.length)), 'utf-8')
}

beforeEach(() => {
  sendMock.mockReset()
  caps.list = []
})

describe('a range read from another host comes gzipped', () => {
  it('asks for gz, unpacks byte-exact, and moves fewer bytes', async () => {
    caps.list = ['fs-read-range-gz-v1']
    const file = jsonl(CHUNK_SIZE * 2 + 12345)
    serve(file)
    const got = await new DaemonFileReader('devbox').readRangeBytes('/r/s.jsonl', 0, CHUNK_SIZE)
    expect(got!.buf.equals(file.subarray(0, CHUNK_SIZE))).toBe(true)
    const [, args] = sendMock.mock.calls.find((c) => c[0] === 'fs.readRange')!
    expect(args.gz).toBe(true)
    const answer = await sendMock.mock.results.at(-1)!.value
    expect(typeof answer.dataGz).toBe('string')
    expect(answer.dataGz.length).toBeLessThan(CHUNK_SIZE / 2)
  })

  it('a whole chunked read of a large file reassembles the same bytes', async () => {
    caps.list = ['fs-read-range-gz-v1']
    const file = jsonl(CHUNK_SIZE * 3 + 7)
    serve(file)
    const got = await new DaemonFileReader('devbox').readFileRange('/r/s.jsonl', 0)
    expect(got!.content).toBe(file.toString('utf-8'))
    expect(sendMock.mock.calls.filter((c) => c[0] === 'fs.readRange').every((c) => c[1].gz === true)).toBe(true)
  })

  it('an older daemon (no capability) and the local daemon are asked plainly', async () => {
    const file = jsonl(CHUNK_SIZE)
    serve(file)
    await new DaemonFileReader('devbox').readRangeBytes('/r/s.jsonl', 0, CHUNK_SIZE)
    caps.list = ['fs-read-range-gz-v1']
    await new DaemonFileReader('__local__').readRangeBytes('/r/s.jsonl', 0, CHUNK_SIZE)
    expect(sendMock.mock.calls.filter((c) => c[0] === 'fs.readRange').every((c) => c[1].gz === undefined)).toBe(true)
  })
})

describe('rangeBytes', () => {
  it('reads data or dataGz, and refuses a packed range that is not the size read', async () => {
    const bytes = jsonl(40_000)
    expect((await rangeBytes({ data: bytes.toString('base64') }, bytes.length)).equals(bytes)).toBe(true)
    const dataGz = zlib.gzipSync(bytes).toString('base64')
    expect((await rangeBytes({ dataGz }, bytes.length)).equals(bytes)).toBe(true)
    await expect(rangeBytes({ dataGz }, bytes.length - 1)).rejects.toThrow()
    await expect(rangeBytes({ dataGz }, bytes.length + 1)).rejects.toThrow(/not/)
    await expect(rangeBytes({ dataGz: Buffer.from('not gzip').toString('base64') }, 8)).rejects.toThrow()
  })
})

describe('class guard: every range read the reader makes may come gzipped', () => {
  it('each fs.readRange the reader sends passes rangeGz and unpacks with rangeBytes', () => {
    const src = readFileSync(join(ROOT, 'src/core/daemon-file-reader.ts'), 'utf8')
    const sends = [...src.matchAll(/conn\.send\('fs\.readRange',[^)]*\)/gs)].map((m) => m[0])
    expect(sends.length).toBeGreaterThanOrEqual(2)
    for (const s of sends) expect(s).toContain('this.rangeGz(conn)')
    expect(src).not.toMatch(/Buffer\.from\(res\.data as string, 'base64'\)/)
  })

  it('both daemon twins answer gz with dataGz, and advertise it', () => {
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = readFileSync(join(ROOT, twin), 'utf8')
      const body = src.slice(src.indexOf('async function cmdFsReadRange('))
      const fn = body.slice(0, body.indexOf('\n}\n'))
      expect(fn, twin).toMatch(/cmd\.gz === true/)
      expect(fn, twin).toMatch(/dataGz: gz\.toString\('base64'\)/)
    }
    const caps = readFileSync(join(ROOT, 'src/providers/daemon-capabilities.ts'), 'utf8')
    expect(caps).toMatch(/'fs-read-range-gz-v1',/)
  })
})
