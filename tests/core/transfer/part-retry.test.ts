/**
 * What a failed part of a file written onto a host in parts means (part-retry.ts), and the two
 * writers that ask it: relayFile and writeTargetFile (writeFileInParts). The receiving host runs
 * the REAL fs.writePart core over a temp dir, plain and private stage. Inside a link wait a part
 * that may have gone up is followed by a smaller one, a cut final part stays final (the receiver
 * may have finished the file), and nothing starts the file over (2026-11-12: a task move failed on
 * "daemon command lost: fs.writePart" after the same 1 MB part was cut for 10 minutes).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps, type TransferError } from '../../../src/providers/transfer-core.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import { __setLinkWaitPollForTesting, withLinkWait } from '../../../src/core/transfer/link-wait.js'
import { MIN_PART_BYTES, partRetry } from '../../../src/core/transfer/part-retry.js'

/** An old daemon takes a small file whole (fs.write): recorded here instead of a daemon link. */
const wholeWrites: Array<{ host: string; path: string; bytes: number }> = []
vi.mock('../../../src/core/daemon-file-reader.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/daemon-file-reader.js')>()),
  DaemonFileReader: class {
    constructor(private host: string) {}
    async writeFile(p: string, content: string) { wholeWrites.push({ host: this.host, path: p, bytes: Buffer.byteLength(content) }) }
  },
}))

const { __setTransferConnectionResolverForTesting, relayFile } = await import('../../../src/core/transfer/daemon-transfer-client.js')
const { writeTargetFile } = await import('../../../src/core/transfer/transfer.js')
type Conn = import('../../../src/core/transfer/daemon-transfer-client.js').TransferConn

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-part-retry-')))
afterAll(() => { if (home.includes('walnut-part-retry-')) fs.rmSync(home, { recursive: true, force: true }) })
const core = createTransferCore({
  fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: {}, home,
  getuid: () => process.getuid!(), ownerStamp: () => null, instanceId: 'test-instance',
})
const KB = 1024
const MB = 1024 * KB
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const lost = () => markLinkFailure(new Error('daemon command lost: fs.writePart: connection closed before b answered'), 'lost')

interface Part { offset: number; bytes: number; final: boolean }
/**
 * A host: serves fs.readRange from `file`, runs fs.writePart on the real core. `cut(n)` cuts the
 * link under its n-th part: 'after' once the part ran there (only the answer is lost).
 */
function fakeHost(opts: { file?: Buffer; caps?: string[]; private?: boolean; cut?: (n: number) => 'after' | 'before' | undefined }) {
  const parts: Part[] = []
  const caps = opts.caps ?? ['fs.readRange', 'fs-write-part-v1', 'transfer-private-v1']
  const conn = {
    hasCapability: (c: string) => caps.includes(c),
    async send(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'fs.readRange') {
        const start = params.start as number
        const slice = opts.file!.subarray(start, start + (params.length as number))
        return { id: 1, ok: true, data: slice.toString('base64'), bytesRead: slice.length, fileSize: opts.file!.length }
      }
      parts.push({ offset: params.offset as number, bytes: Buffer.from(params.data as string, 'base64').length, final: params.final === true })
      const when = opts.cut?.(parts.length)
      if (when === 'before') throw lost()
      let res: Record<string, unknown>
      try {
        res = { id: 1, ok: true, ...(await core.writePart(params, opts.private ? { boundHome: home, origin: null } : undefined)) }
      } catch (err) {
        const e = err as TransferError
        res = { id: 1, ...(e.data ?? {}), ok: false, error: 'fs.writePart failed: ' + e.message, code: e.code }
      }
      if (when === 'after') throw lost()
      return res
    },
  } as unknown as Conn
  return { conn, parts }
}
const useHosts = (hosts: Record<string, { conn: Conn }>) => __setTransferConnectionResolverForTesting(async (h) => (hosts[h] ? [hosts[h]!.conn] : []))

beforeEach(() => { __setLinkWaitPollForTesting(1); wholeWrites.length = 0 })
afterEach(() => { __setLinkWaitPollForTesting(null); __setTransferConnectionResolverForTesting(null) })

describe('partRetry', () => {
  const opts = { host: 'b', path: '/f', size: MB, tries: 1, delayMs: 0 }

  it('inside a wait: a cut part shrinks to a quarter down to 64 KB, and doubles back after 8 good parts', async () => {
    await withLinkWait(5_000, async () => {
      const r = partRetry(opts)
      expect(await r.next(lost(), 0)).toBe(0)
      expect(r.size).toBe(256 * KB)
      await r.next(lost(), 0)
      expect(r.size).toBe(MIN_PART_BYTES)
      await r.next(lost(), 0)
      expect(r.size).toBe(MIN_PART_BYTES)
      for (let i = 0; i < 7; i++) r.ok()
      expect(r.size).toBe(MIN_PART_BYTES)
      r.ok()
      expect(r.size).toBe(128 * KB)
      for (let i = 0; i < 16; i++) r.ok()
      expect(r.size).toBe(512 * KB)
      for (let i = 0; i < 80; i++) r.ok()
      expect(r.size).toBe(MB)
    })
  })

  it('inside a wait, a part with no answer in its window shrinks and is not counted; outside one it is', async () => {
    const noAnswer = () => markLinkFailure(new Error('daemon command timeout: fs.writePart (60000ms)'), 'no-answer')
    await withLinkWait(5_000, async () => {
      const r = partRetry(opts)
      for (let i = 0; i < 3; i++) await r.next(noAnswer(), 0)
      expect(r.size).toBe(MIN_PART_BYTES)
    })
    const outside = partRetry(opts)
    await expect(outside.next(noAnswer(), 0)).rejects.toThrow('daemon command timeout')
    expect(outside.size).toBe(MB)
  })

  it('a wait whose bound passes with no part acknowledged throws the last error', async () => {
    await withLinkWait(40, async () => {
      const r = partRetry(opts)
      const t0 = Date.now()
      let thrown: unknown
      while (!thrown) {
        try { await r.next(lost(), 0) } catch (err) { thrown = err }
      }
      expect(String(thrown)).toContain('daemon command lost')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
    })
  })

  it('a cut final part stays final: the same part again, or (jump) a smaller one ending at the file\'s end', async () => {
    await withLinkWait(5_000, async () => {
      const same = partRetry(opts)
      expect(await same.next(lost(), 3 * MB, { final: true, end: 3 * MB + 512 * KB, jump: false })).toBe(3 * MB)
      expect(same.size).toBe(MB)
      const jump = partRetry(opts)
      expect(await jump.next(lost(), 3 * MB, { final: true, end: 3 * MB + 512 * KB, jump: true })).toBe(3 * MB + 256 * KB)
      expect(jump.size).toBe(256 * KB)
    })
  })
})

describe('writeTargetFile under a link wait', () => {
  const text = crypto.randomBytes(3 * MB + 4321).toString('base64') // about 4.2 MB

  it('a part cut after it ran goes again at 256 KB, then 64 KB; the size doubles back after 8 good parts; the file completes', async () => {
    let downUntil = 0
    const b = fakeHost({ cut: (n) => (n === 2 ? 'after' : n === 3 ? (downUntil = Date.now() + 60, 'after') : undefined) })
    // After the second cut the host has no link for a while: the write waits for it.
    __setTransferConnectionResolverForTesting(async (h) => (h === 'b' && Date.now() >= downUntil ? [b.conn] : []))
    const dest = path.join(home, 'plain', 'transcript.md')
    await withLinkWait(5_000, () => writeTargetFile('b', dest, text))
    expect(fs.readFileSync(dest, 'utf8')).toBe(text)
    const sizes = b.parts.map((p) => p.bytes)
    expect(sizes.slice(0, 3)).toEqual([MB, MB, 256 * KB])
    expect(b.parts[2]!.offset).toBe(MB)
    expect(sizes.slice(3, 11)).toEqual(Array(8).fill(64 * KB))
    expect(sizes[11]).toBe(128 * KB)
    expect(b.parts.filter((p) => p.offset === 0)).toHaveLength(1)
  })

  it('a final part cut after it finished the file goes again final from a later offset: done, never a restart from 0', async () => {
    const small = crypto.randomBytes(300 * KB).toString('base64') // 400 KB: one final part
    const b = fakeHost({ cut: (n) => (n === 1 ? 'after' : undefined) })
    useHosts({ b })
    const dest = path.join(home, 'plain', 'final.md')
    await withLinkWait(5_000, () => writeTargetFile('b', dest, small))
    expect(fs.readFileSync(dest, 'utf8')).toBe(small)
    const size = Buffer.byteLength(small)
    expect(b.parts).toEqual([
      { offset: 0, bytes: size, final: true },
      { offset: size - 256 * KB, bytes: 256 * KB, final: true },
    ])
  })

  it('a small file goes in parts; a daemon without fs.writePart takes it whole, and refuses a big one', async () => {
    const small = 'a short transcript\n'
    const b = fakeHost({})
    useHosts({ b })
    await withLinkWait(5_000, () => writeTargetFile('b', path.join(home, 'plain', 'small.md'), small))
    expect(b.parts).toEqual([{ offset: 0, bytes: small.length, final: true }])
    expect(wholeWrites).toEqual([])
    const old = fakeHost({ caps: ['fs.readRange'] })
    useHosts({ b: old })
    await withLinkWait(5_000, () => writeTargetFile('b', '/x/small.md', small))
    expect(wholeWrites).toEqual([{ host: 'b', path: '/x/small.md', bytes: small.length }])
    await expect(withLinkWait(5_000, () => writeTargetFile('b', '/x/big.md', text))).rejects.toThrow(/fs-write-part-v1/)
    expect(old.parts).toEqual([])
  })
})

describe('relayFile under a link wait', () => {
  it('a chunk cut after it ran goes again smaller, and the file arrives whole', async () => {
    const file = crypto.randomBytes(3 * MB + 77)
    const a = fakeHost({ file })
    const b = fakeHost({ cut: (n) => (n === 2 ? 'after' : undefined) })
    useHosts({ a, b })
    const dest = path.join(home, 'relay', 'pack.bundle')
    const r = await withLinkWait(5_000, () => relayFile('a', '/src', 'b', dest, { size: file.length, sha256: sha(file) }))
    expect(fs.readFileSync(dest).equals(file)).toBe(true)
    expect(r.sha256).toBe(sha(file))
    expect(b.parts.slice(0, 4).map((p) => [p.offset, p.bytes])).toEqual([[0, MB], [MB, MB], [MB, 256 * KB], [MB + 256 * KB, 256 * KB]])
  })

  it('a private stage\'s final part cut after it committed goes again whole and final: done, no restart from 0', async () => {
    const file = crypto.randomBytes(MB + 512 * KB)
    const a = fakeHost({ file })
    const b = fakeHost({ private: true, cut: (n) => (n === 2 ? 'after' : undefined) })
    useHosts({ a, b })
    const dest = path.join(home, '.open-walnut-transfers', `xf-${crypto.randomUUID()}`, 'transcript', `${crypto.randomUUID()}.jsonl`)
    // No sha given: hashed here as the bytes pass, so a cut final part goes again as it was.
    const r = await withLinkWait(5_000, () => relayFile('a', '/src', 'b', dest, { privateAttempt: crypto.randomBytes(16).toString('hex') }))
    expect(r.sha256).toBe(sha(file))
    expect(fs.readFileSync(dest).equals(file)).toBe(true)
    // A smaller part from there would be a non-final one on a committed stage: stage_changed, the move failed.
    expect(b.parts.map((p) => [p.offset, p.bytes, p.final])).toEqual([[0, MB, false], [MB, 512 * KB, true], [MB, 512 * KB, true]])
  })
})
