/**
 * The bulk channel's own connection to a host goes up at a steady pace (src/providers/paced-forward.ts;
 * 2026-11-12: the relay ended it within 1 to 4 s of each redial, eleven times in a row, because what
 * waited for it went out at full speed at once). The pace is the host's learned one
 * (tests/providers/upload-pace.test.ts); these cases name a fixed one.
 *
 *   - bytes up leave at the pace and arrive whole and in order; bytes down pass at once;
 *   - its upload counter moves while a big frame is still going up (a command's timeout reads it);
 *   - the forward ending closes the listener; stop() stops the forward under it;
 *   - every SSH forward Walnut opens to a host is paced (the bulk channel by this forward, the stream
 *     lane per stream): a new one fails here until it is;
 *   - no upload command carries more than MAX_UPLOAD_FRAME_BYTES (writePart and uploadPart split a
 *     bigger chunk): a daemon closes a client it heard no whole frame from for 120 s, and at the
 *     slowest pace the bulk channel learns a bigger frame is still going up then.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { pacedForward } from '../../src/providers/paced-forward.js'
import type { LaneForward } from '../../src/providers/stream-lane.js'
import { MAX_UPLOAD_FRAME_BYTES } from '../../src/providers/ssh-upload-budget.js'
import { createTransferCore } from '../../src/providers/transfer-core.js'
import { __setTransferConnectionResolverForTesting, uploadPart, writePart } from '../../src/core/transfer/daemon-transfer-client.js'
import os from 'node:os'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** A far end: records what arrives (and when), and answers `reply` bytes on the first byte. */
async function farEnd(reply = 0) {
  const got: Array<{ at: number; n: number }> = []
  const chunks: Buffer[] = []
  const conns = new Set<net.Socket>()
  const server = net.createServer((s) => {
    conns.add(s)
    let answered = false
    s.on('data', (b: Buffer) => {
      got.push({ at: Date.now(), n: b.length }); chunks.push(b)
      if (reply && !answered) { answered = true; s.write(Buffer.alloc(reply, 7)) }
    })
    s.on('error', () => {})
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  let exitCbs: Array<(why: string) => void> = []
  let stopped = false
  const fwd: LaneForward = {
    port,
    onExit: (cb) => { exitCbs.push(cb) },
    stop: () => { stopped = true; for (const cb of exitCbs.splice(0)) cb('stopped') },
  }
  cleanups.push(() => new Promise<void>((r) => { for (const c of conns) c.destroy(); server.close(() => r()) }))
  return {
    fwd, got, bytes: () => Buffer.concat(chunks), stopped: () => stopped,
    exit: (why: string) => { const cbs = exitCbs; exitCbs = []; for (const cb of cbs) cb(why) },
  }
}

function payload(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 13) & 0xff
  return b
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('pacedForward', () => {
  it('lets the upload go at the pace, whole and in order; the answer comes back at once', async () => {
    const far = await farEnd(256 * 1024)
    // 64 KB at 32 KB/s with an 8 KB burst: about 1.75 s; one write of all of it, as a WS frame is.
    const fwd = await pacedForward(far.fwd, { bytesPerSec: 32 * 1024, burstBytes: 8 * 1024, pieceBytes: 4 * 1024 })
    cleanups.push(() => fwd.stop())
    const data = payload(64 * 1024)
    const client = net.connect(fwd.port, '127.0.0.1')
    let down = 0
    let firstDownAt = 0
    client.on('data', (b: Buffer) => { if (!firstDownAt) firstDownAt = Date.now(); down += b.length })
    const startedAt = Date.now()
    await new Promise<void>((r) => client.once('connect', () => r()))
    client.write(data)
    // A big frame still going up moves the counter: its owner's timeout reads that as progress.
    await waitFor(() => fwd.sentBytes() >= 16 * 1024, 3_000, 'part of the upload')
    expect(far.bytes().length).toBeLessThan(data.length)
    await waitFor(() => far.bytes().length === data.length, 6_000, 'the whole upload')
    const took = Date.now() - startedAt
    expect(took).toBeGreaterThan(1_400)
    expect(took).toBeLessThan(4_000)
    expect(far.bytes().equals(data)).toBe(true)
    expect(Math.max(...far.got.map((g) => g.n))).toBeLessThanOrEqual(8 * 1024)
    // Down is not paced: 256 KB came back long before the upload's pace would allow.
    await waitFor(() => down === 256 * 1024, 2_000, 'the answer')
    expect(firstDownAt - startedAt).toBeLessThan(1_000)
    expect(fwd.sentBytes()).toBe(data.length)
    client.destroy()
  })

  it('the forward ending closes its connections; stop() stops the forward', async () => {
    const far = await farEnd()
    const fwd = await pacedForward(far.fwd, { bytesPerSec: 1024, burstBytes: 1024 })
    const client = net.connect(fwd.port, '127.0.0.1')
    await new Promise<void>((r) => client.once('connect', () => r()))
    const closed = new Promise<void>((r) => client.once('close', () => r()))
    client.write(payload(64 * 1024))
    const exited: string[] = []
    fwd.onExit((why) => exited.push(why))
    far.exit('code 255: client_loop: send disconnect: Broken pipe')
    await closed
    expect(exited).toEqual(['code 255: client_loop: send disconnect: Broken pipe'])
    // Nothing listens any more.
    await expect(new Promise((resolve, reject) => {
      const c = net.connect(fwd.port, '127.0.0.1'); c.once('connect', () => { c.destroy(); resolve('connected') }); c.once('error', reject)
    })).rejects.toThrow()

    const far2 = await farEnd()
    const fwd2 = await pacedForward(far2.fwd, { bytesPerSec: 1024, burstBytes: 1024 })
    fwd2.stop()
    expect(far2.stopped()).toBe(true)
  })
})

describe('every SSH forward to a host is paced', () => {
  it('each sshLaneForward call in src/ is the stream lane (paced per stream) or wrapped in pacedForward', () => {
    const root = path.resolve(__dirname, '../../src')
    const sites: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name)) {
          const lines = fs.readFileSync(p, 'utf8').split('\n')
          lines.forEach((line, i) => {
            if (/\bsshLaneForward\(/.test(line) && !/function sshLaneForward/.test(line)) sites.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`)
          })
        }
      }
    }
    walk(root)
    expect(sites.length).toBeGreaterThanOrEqual(2)
    const unpaced = sites.filter((s) => !/pacedForward\(await sshLaneForward\(/.test(s) && !/forward: \(\) =>/.test(s))
    expect(unpaced, 'an SSH forward that uploads unpaced: wrap it in pacedForward (paced-forward.ts) or pace its streams').toEqual([])
  })
})

describe('no upload frame outlasts a daemon keepalive at the bulk pace', () => {
  afterEach(() => __setTransferConnectionResolverForTesting(null))

  it('MAX_UPLOAD_FRAME_BYTES as base64 goes up within 100 s at the slowest pace the bulk channel learns', async () => {
    const { CHANNEL_RULES } = await import('../../src/providers/upload-pace.js')
    const { learnFromCut } = await import('../../src/lib/adaptive-pace.js')
    const floor = CHANNEL_RULES.bulk.floor
    expect(Math.ceil(MAX_UPLOAD_FRAME_BYTES * 4 / 3) / floor).toBeLessThanOrEqual(100)
    // However low the rate a cut came at, the bulk channel is never paced under it.
    expect(learnFromCut(null, { at: 0, measured: 1, cap: null }, CHANNEL_RULES.bulk)!.rate).toBe(floor)
  })

  it('the senders of upload parts take their size from it', () => {
    const root = path.resolve(__dirname, '../../src')
    for (const f of ['core/hosts/host-copy.ts', 'core/attachment-replica.ts']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8'), f).toMatch(/const CHUNK_BYTES = MAX_UPLOAD_FRAME_BYTES\b/)
    }
    expect(fs.readFileSync(path.join(root, 'providers/outbound-uploads.ts'), 'utf8')).toMatch(/const PART_BYTES = Math\.min\(UPLOAD_CHUNK_BYTES, MAX_UPLOAD_FRAME_BYTES\)/)
    // Every file that sends an upload command to a host is listed here with how its frames stay small.
    const SENDERS: Record<string, string> = {
      'core/transfer/daemon-transfer-client.ts': 'writePart and uploadPart split a chunk into MAX_UPLOAD_FRAME_BYTES parts',
      'core/attachment-replica.ts': 'CHUNK_BYTES = MAX_UPLOAD_FRAME_BYTES',
      'providers/outbound-uploads.ts': 'PART_BYTES = min(phone chunk, MAX_UPLOAD_FRAME_BYTES)',
      'web/routes/session-upload-v1.ts': "a phone's chunk to the companion over its bridge, not an SSH link",
      'providers/daemon-net-update-io.ts': 'the update over the host network, not an SSH link',
    }
    const senders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8')
          if (/(send|call|bridgeRequest)\w*(<[^>]*>)?\([^)]*'(upload\.part|fs\.writePart|attachments\.put)'/.test(text)) senders.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(senders.sort(), 'a new sender of upload frames: cap its frames at MAX_UPLOAD_FRAME_BYTES and list it').toEqual(Object.keys(SENDERS).sort())
    expect(fs.readFileSync(path.join(root, 'core/transfer/daemon-transfer-client.ts'), 'utf8')).toMatch(/Math\.min\(opts\.chunkBytes \?\? MAX_UPLOAD_FRAME_BYTES, MAX_CHUNK_BYTES, MAX_UPLOAD_FRAME_BYTES\)/)
  })

  it("a phone's 2 MB part goes to the host as parts of at most 1 MB, and lands whole", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-paced-upload-')))
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const core = createTransferCore({ fs, path, crypto, spawn: (() => { throw new Error('no spawn') }) as never, env: {}, home: tmp })
    const sent: number[] = []
    __setTransferConnectionResolverForTesting(async () => [{
      hasCapability: () => true,
      send: async (_cmd: string, params: Record<string, unknown>) => {
        sent.push(Buffer.from(String(params.data), 'base64').length)
        try { return { ok: true, ...(await core.uploadPart(params, path.join(tmp, 'uploads'))) } } catch (err) {
          return { ok: false, error: (err as Error).message, code: (err as { code?: string }).code }
        }
      },
    } as never])
    const body = crypto.randomBytes(2 * 1024 * 1024 + 99)
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    const id = 'up-0f8e7a6b-1c2d-4e5f-9a8b-7c6d5e4f3a2b'
    const first = await uploadPart('devbox', { uploadId: id, name: 'clip.mov', size: body.length, offset: 0, data: body.subarray(0, 2 * 1024 * 1024) })
    expect(first).toMatchObject({ staged: 2 * 1024 * 1024 })
    const done = await uploadPart('devbox', { uploadId: id, name: 'clip.mov', size: body.length, offset: 2 * 1024 * 1024, data: body.subarray(2 * 1024 * 1024), sha256: sha })
    expect(done).toMatchObject({ done: true, sha256: sha })
    expect(sent).toEqual([MAX_UPLOAD_FRAME_BYTES, MAX_UPLOAD_FRAME_BYTES, 99])
    expect(fs.readFileSync(String((done as { path: string }).path)).equals(body)).toBe(true)
  })

  it('a whole 2.5 MB file in one writePart (a picture an MCP tool returned) goes as 1 MB parts, final and checksum on the last', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-paced-write-')))
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const core = createTransferCore({ fs, path, crypto, spawn: (() => { throw new Error('no spawn') }) as never, env: {}, home: tmp })
    const sent: Array<{ n: number; offset: unknown; final: unknown; sha: unknown }> = []
    __setTransferConnectionResolverForTesting(async () => [{
      hasCapability: () => true,
      send: async (_cmd: string, params: Record<string, unknown>) => {
        sent.push({ n: Buffer.from(String(params.data), 'base64').length, offset: params.offset, final: params.final, sha: params.sha256 })
        return { ok: true, ...(await core.writePart(params)) }
      },
    } as never])
    const body = crypto.randomBytes(2.5 * 1024 * 1024)
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    const target = path.join(tmp, 'pic.png')
    const done = await writePart('devbox', { path: target, offset: 0, data: body.toString('base64'), final: true, size: body.length, sha256: sha })
    expect(done).toMatchObject({ done: true, sha256: sha })
    const MB = 1024 * 1024
    expect(sent).toEqual([
      { n: MB, offset: 0, final: undefined, sha: undefined },
      { n: MB, offset: MB, final: undefined, sha: undefined },
      { n: MB / 2, offset: 2 * MB, final: true, sha },
    ])
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    // An empty file is still one part.
    sent.length = 0
    const empty = Buffer.alloc(0)
    await writePart('devbox', { path: path.join(tmp, 'empty'), offset: 0, data: empty, final: true, size: 0, sha256: crypto.createHash('sha256').update(empty).digest('hex') })
    expect(sent.map((p) => p.n)).toEqual([0])
  })
})
