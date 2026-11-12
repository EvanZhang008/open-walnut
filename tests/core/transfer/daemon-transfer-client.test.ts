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
  __setTransferConnectionResolverForTesting, applyPack, fetchFromHost, relayFile, packWorkspace, probeHostFacts, scanWorkDir, writePart,
  TransferCommandError, TransferHostOfflineError, TransferServerStoppingError, findTranscript, type TransferConn,
} from '../../../src/core/transfer/daemon-transfer-client.js'
import { markServerStopping, noteServerStopReason, resetServerStopping } from '../../../src/core/server-stopping.js'
import { __setLinkWaitPollForTesting, withLinkWait } from '../../../src/core/transfer/link-wait.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'

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

  it('its gate is asked right before each send, after the link lookup; a refusal sends nothing more and is never retried', async () => {
    // 2026-11-04: host_copy looked at the grant only between parts, so a revoke while a link was
    // looked up again let the next part go, and a small file's one part was the whole file.
    const small = crypto.randomBytes(300)
    const a = fakeHost({ file: small })
    const b = fakeHost({})
    let read = false
    let revoked = false
    // The receiver's link is looked up again for the write (a redial looks the same); the revoke lands then.
    __setTransferConnectionResolverForTesting(async (h) => {
      if (h === 'b' && read) revoked = true
      return h === 'a' ? [a.conn] : [b.conn]
    })
    const asked: string[] = []
    const no = new Error('revoked')
    const gate = (host: string, command: string) => {
      asked.push(`${host} ${command}`)
      if (revoked) throw no
      if (command === 'fs.readRange') read = true
    }
    await expect(relayFile('a', '/src', 'b', path.join(tmp, 'r11', 'x'), { size: small.length, chunkBytes, retryDelayMs: 0, gate })).rejects.toBe(no)
    expect(asked).toEqual(['a fs.readRange', 'b fs.writePart'])
    expect(b.sent).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'r11', 'x'))).toBe(false)
  })

  it('a signal stops it before its next chunk, with the signal\'s reason, and is never retried', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({})
    useHosts({ a, b })
    const stop = new AbortController()
    const why = new Error('stopped by the caller')
    const run = relayFile('a', '/src', 'b', path.join(tmp, 'r10', 'x'), {
      size: body.length, chunkBytes, onProgress: (p) => { if (p.sent === 2 * chunkBytes) stop.abort(why) }, signal: stop.signal,
    })
    await expect(run).rejects.toBe(why)
    expect(a.sent.filter((s) => s.cmd === 'fs.readRange')).toHaveLength(2)
    expect(fs.existsSync(path.join(tmp, 'r10', 'x'))).toBe(false)
    // A bare abort() sets the platform's AbortError as the reason, and that is what it throws.
    const bare = new AbortController()
    bare.abort()
    await expect(relayFile('a', '/src', 'b', path.join(tmp, 'r10', 'y'), { size: body.length, signal: bare.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    // A reason that is not an Error stops it as `aborted`, before a byte is read.
    const reads = a.sent.length
    const plain = new AbortController()
    plain.abort('why')
    const err = await relayFile('a', '/src', 'b', path.join(tmp, 'r10', 'z'), { size: body.length, signal: plain.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransferCommandError)
    expect(err).toMatchObject({ code: 'aborted', command: 'relay' })
    expect(a.sent.length).toBe(reads)
  })

  it('the last part may get its own timeout; every other part, and every caller that names none, keeps the usual one', async () => {
    const a = fakeHost({ file: body })
    const b = fakeHost({})
    const waits: Array<{ final: boolean; timeoutMs?: number }> = []
    const send = b.conn.send.bind(b.conn)
    b.conn.send = (cmd, params, timeoutMs) => {
      if (cmd === 'fs.writePart') waits.push({ final: params.final === true, timeoutMs })
      return send(cmd, params, timeoutMs)
    }
    useHosts({ a, b })
    await relayFile('a', '/src', 'b', path.join(tmp, 'r11', 'x'), { size: body.length, chunkBytes, finalPartTimeoutMs: 123_000 })
    expect(waits.map((w) => w.timeoutMs)).toEqual([60_000, 60_000, 60_000, 60_000, 60_000, 123_000])
    expect(waits.at(-1)!.final).toBe(true)
    expect(b.sent.every((s) => !('timeoutMs' in s.params))).toBe(true)
    waits.length = 0
    await relayFile('a', '/src', 'b', path.join(tmp, 'r11', 'y'), { size: body.length, chunkBytes })
    expect(waits.map((w) => w.timeoutMs)).toEqual(Array(6).fill(60_000))
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

describe('a daemon call while this server stops', () => {
  // 2026-11-12: a deploy's stop closed the links mid-move, and the move recorded
  // "Walnut is not connected to this Mac right now." The stop is the server's, not the host's.
  afterEach(() => resetServerStopping())

  it('is a server stop, never the host offline: no link, a link lost mid-command, a relay mid-file', async () => {
    markServerStopping()
    noteServerStopReason('deploy')
    useHosts({})
    const none = await probeHostFacts('__local__').then(() => null, (e: unknown) => e)
    expect(none).toBeInstanceOf(TransferServerStoppingError)
    expect(none).not.toBeInstanceOf(TransferHostOfflineError)
    expect((none as Error).message).toBe('The Walnut server is restarting (a deploy); that closed its link to this Mac, which is still fine.')
    expect(await findTranscript('__local__', 's1')).toMatchObject({ kind: 'unreachable', error: expect.stringContaining('restarting (a deploy)') })
    resetServerStopping()
    // The same miss while the server runs is the host away, as before.
    expect(await probeHostFacts('__local__').then(() => null, (e: unknown) => e)).toBeInstanceOf(TransferHostOfflineError)

    // The stop begins after the link was found; the command's link closes under it.
    const a = fakeHost({ reply: { os: 'x' }, hook: () => { markServerStopping(); return 'before' } })
    useHosts({ a })
    await expect(probeHostFacts('a')).rejects.toMatchObject({ name: 'TransferServerStoppingError', code: 'server_restarting', host: 'a', command: 'host.facts' })
    resetServerStopping()

    // A relay is not retried through a stop: no retry gets a link back.
    const src = fakeHost({ file: body })
    const dst = fakeHost({ hook: (cmd, _p, n) => { if (cmd === 'fs.writePart' && n === 2) { markServerStopping(); return 'before' } } })
    useHosts({ src, dst })
    await expect(relayFile('src', '/f', 'dst', path.join(tmp, 'stop', 'f'), { chunkBytes, retryDelayMs: 0 }))
      .rejects.toBeInstanceOf(TransferServerStoppingError)
    expect(dst.sent.filter((c) => c.cmd === 'fs.writePart')).toHaveLength(2)
  })
})

describe('a link wait (a task move)', () => {
  afterEach(() => { __setLinkWaitPollForTesting(null); resetServerStopping() })

  it('waits for a host with no link and goes on once it is back; outside a wait it is offline at once', async () => {
    __setLinkWaitPollForTesting(50)
    const a = fakeHost({ reply: { os: 'x' } })
    let backAt = Date.now() + 400
    __setTransferConnectionResolverForTesting(async (h) => (h === 'a' && Date.now() >= backAt ? [a.conn] : []))
    await expect(probeHostFacts('a')).rejects.toBeInstanceOf(TransferHostOfflineError)
    const t0 = Date.now()
    expect(await withLinkWait(5_000, () => probeHostFacts('a'))).toEqual({ os: 'x' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    // A link that does not come back within the bound: offline, saying it waited.
    backAt = Infinity
    await expect(withLinkWait(200, () => probeHostFacts('a'))).rejects.toBeInstanceOf(TransferHostOfflineError)
    await expect(withLinkWait(60_000, async () => {
      setTimeout(() => markServerStopping(), 150)
      return probeHostFacts('a')
    })).rejects.toBeInstanceOf(TransferServerStoppingError)
  })
})

describe('a command whose link went away under it, inside a link wait', () => {
  afterEach(() => __setLinkWaitPollForTesting(null))
  /** A host whose first `fails` sends of `cmd` reject as a link failure of `kind`, then answer. */
  const flaky = (cmd: string, kind: 'no-link' | 'lost', fails = 1) => {
    const sent: string[] = []
    const conn: TransferConn = {
      hasCapability: () => true,
      async send(c, params) {
        sent.push(c)
        if (c === cmd && sent.filter((x) => x === c).length <= fails) throw markLinkFailure(new Error(`link ${kind}`), kind)
        return { id: 1, ok: true, echo: params, dest: params.dest, kind: 'git', head: 'h1', steps: [] }
      },
    }
    __setTransferConnectionResolverForTesting(async () => [conn])
    return sent
  }

  it('a command that never reached the host goes again once a link is back', async () => {
    __setLinkWaitPollForTesting(10)
    const sent = flaky('host.facts', 'no-link')
    expect(await withLinkWait(5_000, () => probeHostFacts('a'))).toMatchObject({ echo: {} })
    expect(sent).toEqual(['host.facts', 'host.facts'])
  })

  it('a lost read that can run twice goes again; a lost apply never does', async () => {
    __setLinkWaitPollForTesting(10)
    const sent = flaky('transfer.scan', 'lost')
    expect(await withLinkWait(5_000, () => scanWorkDir('a', '/w'))).toMatchObject({ echo: { dir: '/w' } })
    expect(sent).toEqual(['transfer.scan', 'transfer.scan'])
    // A pack goes again into a folder of its own: the first may still be writing its own.
    const packs = flaky('transfer.pack', 'lost')
    const pack = await withLinkWait(5_000, () => packWorkspace('a', { cwd: '/w', outDir: '/o/pack' }))
    expect(packs).toEqual(['transfer.pack', 'transfer.pack'])
    expect(pack).toMatchObject({ echo: { outDir: '/o/pack-again-1' } })
    // An apply may have run there: it is never sent twice, inside a wait or not.
    const applies = flaky('transfer.apply', 'lost')
    await expect(withLinkWait(5_000, () => applyPack('a', { dest: '/d', bundleDir: '/b' }))).rejects.toThrow('link lost')
    expect(applies).toEqual(['transfer.apply'])
    // Outside a wait nothing is sent again.
    const once = flaky('transfer.scan', 'lost')
    await expect(scanWorkDir('a', '/w')).rejects.toThrow('link lost')
    expect(once).toEqual(['transfer.scan'])
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

describe('a file this server writes onto a host in parts (writeTargetFile)', () => {
  afterEach(() => __setLinkWaitPollForTesting(null))
  const text = crypto.randomBytes(3 * 1024 * 1024 + 4321).toString('base64') // about 4.2 MB: several parts

  it('inside a link wait, a link cut under a part and one gone for a while are waited out, and the file completes', async () => {
    __setLinkWaitPollForTesting(10)
    const { writeTargetFile } = await import('../../../src/core/transfer/transfer.js')
    const dest = path.join(tmp, 'wtf', 'transcript.md')
    let downUntil = 0
    const host = fakeHost({
      hook: (cmd, _p, n) => {
        if (cmd !== 'fs.writePart') return
        // The 2nd part runs there, then the link is cut before its answer (lost).
        if (n === 2) { downUntil = Date.now() + 150; return 'after' }
      },
    })
    const sendPart = host.conn.send.bind(host.conn)
    host.conn.send = async (cmd, params, ms) => {
      try { return await sendPart(cmd, params, ms) } catch (err) { throw markLinkFailure(err as Error, 'lost') }
    }
    // While the link is down the host has none (no-link): the write waits for it.
    __setTransferConnectionResolverForTesting(async (h) => (h === 'b' && Date.now() >= downUntil ? [host.conn] : []))
    await withLinkWait(5_000, () => writeTargetFile('b', dest, text))
    expect(fs.readFileSync(dest, 'utf8')).toBe(text)
    const parts = host.sent.filter((s) => s.cmd === 'fs.writePart').map((s) => s.params.offset as number)
    // The cut part went again at its own offset, then smaller parts went on from there.
    expect(parts[2]).toBe(parts[1])
    expect(parts.length).toBeGreaterThan(5)
  })

  it('outside a wait a cut part fails the write, as before', async () => {
    const { writeTargetFile } = await import('../../../src/core/transfer/transfer.js')
    const host = fakeHost({ hook: (cmd, _p, n) => (cmd === 'fs.writePart' && n === 2 ? 'after' : undefined) })
    const sendPart = host.conn.send.bind(host.conn)
    host.conn.send = async (cmd, params, ms) => {
      try { return await sendPart(cmd, params, ms) } catch (err) { throw markLinkFailure(err as Error, 'lost') }
    }
    useHosts({ b: host })
    await expect(writeTargetFile('b', path.join(tmp, 'wtf', 'once.md'), text)).rejects.toThrow('the reply was lost')
    expect(host.sent.filter((s) => s.cmd === 'fs.writePart')).toHaveLength(2)
  })
})
