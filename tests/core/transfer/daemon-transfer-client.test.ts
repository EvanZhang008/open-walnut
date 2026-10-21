/**
 * The server's transfer client against two in-memory hosts: host A serves
 * fs.readRange from a buffer, host B runs the REAL writePart core over a temp
 * dir. Covers the relay loop (a lost reply, a receiver that lost its staging),
 * capability gating, and how a daemon refusal reaches the caller.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps, type TransferError } from '../../../src/providers/transfer-core.js'
import { DaemonNeedsUpgradeError } from '../../../src/core/daemon-file-reader.js'
import {
  __setTransferConnectionResolverForTesting, fetchFromHost, relayFile, packWorkspace, probeHostFacts, writePart,
  TransferCommandError, TransferHostOfflineError, type TransferConn,
} from '../../../src/core/transfer/daemon-transfer-client.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transfer-client-')))
afterAll(() => { if (tmp.includes('walnut-transfer-client-')) fs.rmSync(tmp, { recursive: true, force: true }) })
afterEach(() => __setTransferConnectionResolverForTesting(null))

const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: {}, home: tmp })
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const ALL_CAPS = ['fs.readRange', 'fs-write-part-v1', 'transfer-v1', 'host-facts-v1']

interface Fake { conn: TransferConn; sent: Array<{ cmd: string; params: Record<string, unknown> }> }

/** A host whose daemon answers like a real one; `hook` may fail a call before or after it runs. */
function fakeHost(opts: { caps?: string[]; file?: Buffer; hook?: (cmd: string, params: Record<string, unknown>, n: number) => 'before' | 'after' | void; reply?: Record<string, unknown> }): Fake {
  const sent: Fake['sent'] = []
  const caps = opts.caps ?? ALL_CAPS
  return {
    sent,
    conn: {
      hasCapability: (c) => caps.includes(c),
      async send(cmd, params) {
        sent.push({ cmd, params })
        const when = opts.hook?.(cmd, params, sent.filter((s) => s.cmd === cmd).length)
        if (when === 'before') throw new Error('DaemonConnection not connected')
        let res: Record<string, unknown>
        if (opts.reply) res = { id: 1, ok: true, ...opts.reply }
        else if (cmd === 'fs.readRange') {
          const f = opts.file!
          const start = params.start as number
          const slice = f.subarray(start, start + (params.length as number))
          res = { id: 1, ok: true, data: slice.toString('base64'), bytesRead: slice.length, fileSize: f.length, eof: start + slice.length >= f.length }
        } else if (cmd === 'fs.writePart') {
          try {
            res = { id: 1, ok: true, ...(await core.writePart(params)) }
          } catch (err) {
            const e = err as TransferError
            res = { id: 1, ...(e.data ?? {}), ok: false, error: 'fs.writePart failed: ' + e.message, code: e.code }
          }
        } else {
          res = { id: 1, ok: false, error: cmd + ' failed: unknown', code: 'failed' }
        }
        if (when === 'after') throw new Error('command timed out (the reply was lost)')
        return res
      },
    },
  }
}

function useHosts(hosts: Record<string, Fake | null>) {
  __setTransferConnectionResolverForTesting(async (h) => (hosts[h] ? [hosts[h]!.conn] : []))
}

const body = crypto.randomBytes(5 * 1024 + 321)
const chunkBytes = 1024

describe('relayFile', () => {
  it('copies a file chunk by chunk and verifies it at the end', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({})
    useHosts({ a, b })
    const target = path.join(tmp, 'r1', 'copy.bin')
    const progress: number[] = []
    const r = await relayFile('a', '/src/file.bin', 'b', target, { size: body.length, sha256: sha(body), chunkBytes, onProgress: (p) => progress.push(p.sent) })
    expect(r).toEqual({ bytes: body.length, sha256: sha(body), chunks: 6, retries: 0 })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    expect(progress).toEqual([1024, 2048, 3072, 4096, 5120, body.length])
    const last = b.sent[b.sent.length - 1].params
    expect(last).toMatchObject({ final: true, size: body.length, sha256: sha(body), offset: 5120 })
  })

  it('a lost reply is retried and the receiver acknowledges without writing twice', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({ hook: (cmd, _p, n) => (cmd === 'fs.writePart' && n === 3 ? 'after' : undefined) })
    useHosts({ a, b })
    const target = path.join(tmp, 'r2', 'copy.bin')
    const r = await relayFile('a', '/src/file.bin', 'b', target, { size: body.length, sha256: sha(body), chunkBytes, retryDelayMs: 0 })
    expect(r.retries).toBe(1)
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    const offsets = b.sent.filter((s) => s.cmd === 'fs.writePart').map((s) => s.params.offset)
    expect(offsets).toEqual([0, 1024, 2048, 2048, 3072, 4096, 5120])
  })

  it('a receiver that lost its staging answers gap, and the relay resumes from its have', async () => {
    const a = fakeHost({ file: body })
    const target = path.join(tmp, 'r3', 'copy.bin')
    let restarted = false
    const b = fakeHost({
      hook: (cmd, p) => {
        // The receiver restarted after taking 3 KB and kept only the first 2 KB.
        if (cmd === 'fs.writePart' && p.offset === 3072 && !restarted) {
          restarted = true
          fs.truncateSync(target + '.walnut-part', 2048)
        }
      },
    })
    useHosts({ a, b })
    const r = await relayFile('a', '/src/file.bin', 'b', target, { size: body.length, sha256: sha(body), chunkBytes, retryDelayMs: 0 })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    expect(r.retries).toBe(1)
    const offsets = b.sent.filter((s) => s.cmd === 'fs.writePart').map((s) => s.params.offset)
    expect(offsets).toEqual([0, 1024, 2048, 3072, 2048, 3072, 4096, 5120])
  })

  it('a link that keeps failing gives up after the retries; a checksum refusal is final at once', async () => {
    const a = fakeHost({ file: body })
    const down = fakeHost({ hook: (cmd, _p, n) => (cmd === 'fs.writePart' && n >= 2 ? 'before' : undefined) })
    useHosts({ a, b: down })
    await expect(relayFile('a', '/src/file.bin', 'b', path.join(tmp, 'r4', 'x.bin'), { size: body.length, sha256: sha(body), chunkBytes, retryDelayMs: 0 }))
      .rejects.toThrow(/not connected/)
    expect(down.sent.filter((s) => s.cmd === 'fs.writePart')).toHaveLength(4)

    const b = fakeHost({})
    useHosts({ a, b })
    const target = path.join(tmp, 'r5', 'x.bin')
    const err = await relayFile('a', '/src/file.bin', 'b', target, { size: body.length, sha256: 'c'.repeat(64), chunkBytes, retryDelayMs: 0 }).catch((e) => e)
    expect(err).toBeInstanceOf(TransferCommandError)
    expect(err).toMatchObject({ code: 'checksum_mismatch', command: 'fs.writePart', host: 'b' })
    expect(err.message).not.toMatch(/^fs\.writePart failed/)
    expect(fs.existsSync(target)).toBe(false)
    expect(b.sent.filter((s) => s.cmd === 'fs.writePart')).toHaveLength(6)
  })

  it('a source that changed size fails, and an empty file still lands', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({})
    useHosts({ a, b })
    await expect(relayFile('a', '/src', 'b', path.join(tmp, 'r6', 'x'), { size: body.length + 1, sha256: sha(body), chunkBytes, retryDelayMs: 0 }))
      .rejects.toMatchObject({ code: 'source_changed' })
    useHosts({ a: fakeHost({ file: Buffer.alloc(0) }), b })
    const empty = path.join(tmp, 'r6', 'empty')
    expect(await relayFile('a', '/src', 'b', empty, { size: 0, sha256: sha(Buffer.alloc(0)) })).toMatchObject({ bytes: 0, chunks: 1 })
    expect(fs.statSync(empty).size).toBe(0)
    // Told the file is empty, but it is not: caught by the one read, nothing lands.
    useHosts({ a, b })
    const notEmpty = path.join(tmp, 'r6', 'not-empty')
    await expect(relayFile('a', '/src', 'b', notEmpty, { size: 0, sha256: sha(Buffer.alloc(0)) }))
      .rejects.toMatchObject({ code: 'source_changed' })
    expect(fs.existsSync(notEmpty)).toBe(false)
  })

  it('no size given: it comes from the first read (an empty file still lands)', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({})
    useHosts({ a, b })
    const target = path.join(tmp, 'r8', 'copy.bin')
    const r = await relayFile('a', '/src', 'b', target, { sha256: sha(body), chunkBytes, retryDelayMs: 0 })
    expect(r).toMatchObject({ bytes: body.length, sha256: sha(body), chunks: 6 })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    expect(b.sent[b.sent.length - 1].params).toMatchObject({ final: true, size: body.length })

    const e = fakeHost({ file: Buffer.alloc(0) })
    useHosts({ a: e, b })
    const empty = path.join(tmp, 'r8', 'empty')
    expect(await relayFile('a', '/src', 'b', empty, {})).toMatchObject({ bytes: 0, sha256: sha(Buffer.alloc(0)), chunks: 1 })
    expect(e.sent.map((s) => s.cmd)).toEqual(['fs.readRange'])
    expect(fs.statSync(empty).size).toBe(0)
  })

  it('no sha given: hashed from the relayed bytes, never twice across a lost reply and a resume', async () => {
    const a = fakeHost({ file: body })
    const target = path.join(tmp, 'r9', 'copy.bin')
    let restarted = false
    const b = fakeHost({
      hook: (cmd, p, n) => {
        if (cmd !== 'fs.writePart') return undefined
        if (n === 2) return 'after' // the reply to the second chunk is lost
        // After 4 KB the receiver restarts holding 1500 bytes: a resume off the chunk grid.
        if (p.offset === 4096 && !restarted) { restarted = true; fs.truncateSync(target + '.walnut-part', 1500) }
        return undefined
      },
    })
    useHosts({ a, b })
    const r = await relayFile('a', '/src', 'b', target, { chunkBytes, retryDelayMs: 0 })
    expect(r.sha256).toBe(sha(body))
    expect(r.retries).toBe(2)
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    const writes = b.sent.filter((s) => s.cmd === 'fs.writePart')
    expect(writes.map((s) => s.params.offset)).toEqual([0, 1024, 1024, 2048, 3072, 4096, 1500, 2524, 3548, 4572])
    expect(writes[writes.length - 1].params).toMatchObject({ final: true, size: body.length, sha256: sha(body) })

    // A file smaller than one chunk: the only chunk is the final one and carries the digest.
    const c = fakeHost({})
    useHosts({ a: fakeHost({ file: Buffer.from('tiny') }), b: c })
    expect(await relayFile('a', '/src', 'b', path.join(tmp, 'r9', 'tiny'), {})).toMatchObject({ bytes: 4, sha256: sha(Buffer.from('tiny')) })
  })

  it('a receiver without fs-write-part-v1 fails before any byte moves', async () => {
    const a = fakeHost({ file: body })
    const old = fakeHost({ caps: ['fs.readRange'] })
    useHosts({ a, b: old })
    await expect(relayFile('a', '/src', 'b', path.join(tmp, 'r7', 'x'), { size: body.length, sha256: sha(body) }))
      .rejects.toBeInstanceOf(DaemonNeedsUpgradeError)
    expect(a.sent).toEqual([])
    expect(old.sent).toEqual([])
  })
})

describe('the other helpers', () => {
  it('send one command, strip ok/id from the reply, and gate on the capability', async () => {
    const a = fakeHost({ reply: { outDir: '/o', meta: { kind: 'dir' }, files: [] } })
    useHosts({ a, old: fakeHost({ caps: [] }) })
    expect(await packWorkspace('a', { cwd: '/w', outDir: '/o', timeoutMs: 5000 })).toEqual({ outDir: '/o', meta: { kind: 'dir' }, files: [] })
    expect(a.sent[0]).toEqual({ cmd: 'transfer.pack', params: { cwd: '/w', outDir: '/o' } })
    await expect(probeHostFacts('old')).rejects.toBeInstanceOf(DaemonNeedsUpgradeError)
    await expect(probeHostFacts('nowhere')).rejects.toBeInstanceOf(TransferHostOfflineError)
  })

  it('writePart sends bytes as base64 and a gap refusal carries have', async () => {
    const b = fakeHost({})
    useHosts({ b })
    const target = path.join(tmp, 'h1', 'f')
    expect(await writePart('b', { path: target, offset: 0, data: Buffer.from('abc') })).toEqual({ staged: 3 })
    expect(b.sent[0].params.data).toBe(Buffer.from('abc').toString('base64'))
    await expect(writePart('b', { path: target, offset: 9, data: 'eHl6' })).rejects.toMatchObject({ code: 'gap', data: { have: 3 } })
  })
})

describe('fetchFromHost', () => {
  const files = [{ remotePath: '~/x/a', localPath: '/tmp/a' }]
  it('a fetch whose files all arrived is a success, though the RPC envelope carries the ok', async () => {
    useHosts({ b: fakeHost({ reply: { results: [{ localPath: '/tmp/a', ok: true, size: 3 }] } }) })
    await expect(fetchFromHost('b', { host: 'a.example', files })).resolves.toMatchObject({ ok: true })
  })
  it('one missing file makes it a failure, and no results is never a success', async () => {
    useHosts({ b: fakeHost({ reply: { results: [{ localPath: '/tmp/a', ok: false, error: 'No such file' }] } }) })
    await expect(fetchFromHost('b', { host: 'a.example', files })).resolves.toMatchObject({ ok: false })
    useHosts({ b: fakeHost({ reply: {} }) })
    await expect(fetchFromHost('b', { host: 'a.example', files })).resolves.toMatchObject({ ok: false, results: [] })
  })
})
