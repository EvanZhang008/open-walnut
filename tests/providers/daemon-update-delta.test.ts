/**
 * A host network daemon update sends only the blocks of the new walnut file that differ
 * from the file the host's service runs now (daemon-service-update.ts planHostDelta,
 * walnut-file-delta.ts), and the host builds the new file from both, in a real /bin/sh
 * (tests/helpers/net-update-lab.ts). 2026-11-19: home-pc's link carried about 30 KB/s and
 * every update sent the whole 85 MB file; 415 of its 625 blocks were the same as the
 * installed build's.
 *
 * Proven here: a delta goes up and builds the exact new file; a base that changed after it
 * was hashed builds wrong and the whole file goes up at once instead; no base, or most
 * blocks changed, sends the whole file; a delta whose file prints another version fails
 * without sending the whole file; a delta cut mid-upload resumes on the next try.
 *
 * MACHINE SAFETY: files only under a temp dir and the /tmp/open-walnut-update.* dirs this
 * file records and removes; the only processes are /bin/sh, dd, gzip, the hash tool and the
 * fake daemon script.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNetUpdateIo, type NetUpdateIoOptions } from '../../src/providers/daemon-net-update-io.js'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { DELTA_BLOCK_BYTES } from '../../src/providers/walnut-file-delta.js'
import { LAB_STAGING, labDaemon, labHost } from '../helpers/net-update-lab.js'

// This file's own version: chunk dirs are named by it, so another file's cases never share them.
const LAB_VERSION = 'walnut-daemon-de17a0000001'
/** The chunk dir of a payload kind of LAB_VERSION (daemon-service-update.ts chunkDirName). */
const chunkDirOf = (kind: 'binary' | 'gz' | 'delta') => `/tmp/open-walnut-update.r${crypto.createHash('sha256').update(`${LAB_VERSION}\0${kind}`).digest('hex').slice(0, 24)}`
const left = () => [...made].filter((d) => fs.existsSync(d))

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-delta-')))
const made = new Set<string>()
const removeMade = () => {
  for (const dir of made) if (LAB_STAGING.test(dir)) fs.rmSync(dir, { recursive: true, force: true })
  made.clear()
}
afterEach(removeMade)
afterAll(() => { removeMade(); fs.rmSync(root, { recursive: true, force: true }) })

let work: string, state: string, home: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  state = path.join(work, 'state')
  home = path.join(work, 'home')
  fs.mkdirSync(state)
  fs.mkdirSync(home)
})

const fast = (): NetUpdateIoOptions => ({ pauseSeconds: 0.2, settleSeconds: 0, pollMs: 100, waitMs: 30_000, holdWaitMs: 0, latestMarker: path.join(work, 'latest') })
const calls = () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : [])
/** The executable the update ran, copied out by the fake daemon as it ran (`$0`). */
const BUILT = () => path.join(state, 'built')

/**
 * The installed build and a new one of the same length: the new one's version line and the
 * pad at `changeAt` (a share of it) differ, so only those blocks change.
 */
function pair(o: { changeAt?: number[]; version?: string; oldPad?: string } = {}): { base: string; fresh: Buffer; gz: Buffer } {
  const pad = crypto.randomBytes(1_600_000).toString('base64')
  const onUpdate = [`cat "$0" > '${BUILT()}'`]
  const base = labDaemon({ work, state }, { file: 'installed-daemon', version: 'walnut-daemon-0ld000000000', padText: o.oldPad ?? pad, onUpdate })
  let next = pad
  for (const at of o.changeAt ?? [0.5]) {
    const i = Math.floor(next.length * at)
    next = next.slice(0, i) + 'Z'.repeat(1000) + next.slice(i + 1000)
  }
  const fresh = fs.readFileSync(labDaemon({ work, state }, { version: o.version ?? LAB_VERSION, padText: next, onUpdate }))
  return { base, fresh, gz: zlib.gzipSync(fresh) }
}

const host = (o: Parameters<typeof labHost>[1] = {}) => labHost({ work, home, made }, o)
const chunkWrites = (h: { writes: string[] }) => h.writes.filter((p) => /\/chunk_\d{4}$/.test(p))
const deltaLines = (h: { lines: string[] }) => h.lines.filter((l) => l.includes("W_D='"))

describe('a daemon update sent as the blocks that differ from the installed file', () => {
  it('sends only the changed blocks and builds the exact new file from the installed one', async () => {
    const { base, fresh, gz } = pair()
    const h = host()
    await updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(h, fast()), 'user')
    expect(calls()).toHaveLength(1)
    expect(fs.readFileSync(BUILT()).equals(fresh)).toBe(true)
    // The version line's block and the changed pad's block or two, out of about nine.
    const [line] = deltaLines(h)
    const changed = /W_D=' ([\d ]+) '/.exec(line)![1].split(' ').map(Number)
    expect(changed[0]).toBe(0)
    expect(changed.length).toBeLessThanOrEqual(3)
    expect(Math.ceil(fresh.length / DELTA_BLOCK_BYTES)).toBeGreaterThan(6)
    expect(chunkWrites(h).length).toBeLessThan(Math.ceil(gz.length / 262_144))
    expect(new Set(chunkWrites(h).map((p) => path.dirname(p)))).toEqual(new Set([chunkDirOf('delta')]))
    // Applied: nothing of it stays on the host.
    expect(left()).toEqual([])
  }, 60_000)

  it('a daemon binary (not a walnut file) goes up as a delta the same way', async () => {
    const { base, fresh } = pair()
    const binary = path.join(work, 'new-daemon')
    fs.writeFileSync(binary, fresh, { mode: 0o755 })
    const h = host()
    await updateRemoteDaemonService({ binary, base }, LAB_VERSION, createNetUpdateIo(h, fast()), 'user')
    expect(deltaLines(h)).toHaveLength(1)
    expect(fs.readFileSync(BUILT()).equals(fresh)).toBe(true)
    expect(left()).toEqual([])
  }, 60_000)

  it('a base that changed after it was hashed builds wrong, the whole file goes up at once, and the next update sends it whole', async () => {
    // A byte of a block no delta sends (block 1: the version line is block 0, the pad's change the middle),
    // or the base cut short (its size no longer the hashed one).
    for (const change of ['byte', 'size'] as const) {
      const made0 = pair()
      // A base path of its own: a base that built wrong is remembered by its path and version.
      const base = `${made0.base}-${change}`
      fs.renameSync(made0.base, base)
      const { fresh, gz } = made0
      const h = host({
        beforeRun: (line) => {
          if (!line.includes("W_D='")) return
          const b = fs.readFileSync(base)
          if (change === 'byte') b[DELTA_BLOCK_BYTES + 10] ^= 0xff
          fs.writeFileSync(base, change === 'byte' ? b : b.subarray(0, b.length - 5))
        },
      })
      await updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(h, fast()), 'user')
      expect(deltaLines(h)).toHaveLength(1)
      expect(calls()).toHaveLength(1)
      expect(fs.readFileSync(BUILT()).equals(fresh)).toBe(true)
      // Both chunk dirs are gone: the delta's proved wrong, the whole file's was applied.
      expect(left()).toEqual([])
      // This base built wrong for this version: the next try does not plan a delta from it.
      const again = host()
      await updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(again, fast()), 'user')
      expect(again.lines.some((l) => l.includes('delta=hashed'))).toBe(false)
      expect(chunkWrites(again)).toHaveLength(Math.ceil(gz.length / 262_144))
      for (const f of ['calls', 'count']) fs.rmSync(path.join(state, f), { force: true })
      removeMade()
    }
  }, 120_000)

  it('no installed file, or most blocks changed, sends the whole file', async () => {
    for (const shape of ['nobase', 'most'] as const) {
      const { base, fresh, gz } = pair(shape === 'most' ? { oldPad: crypto.randomBytes(1_600_000).toString('base64') } : {})
      if (shape === 'nobase') fs.rmSync(base)
      const h = host()
      await updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(h, fast()), 'user')
      expect(deltaLines(h)).toEqual([])
      expect(chunkWrites(h)).toHaveLength(Math.ceil(gz.length / 262_144))
      expect(fs.readFileSync(BUILT()).equals(fresh)).toBe(true)
      fs.rmSync(path.join(state, 'calls'), { force: true })
      fs.rmSync(path.join(state, 'count'), { force: true })
      removeMade()
    }
  }, 90_000)

  it('a delta whose file prints another version fails, and the whole file is not sent after it', async () => {
    const { base, gz } = pair({ version: 'walnut-daemon-000000000000' })
    const h = host()
    await expect(updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(h, fast()), 'user'))
      .rejects.toThrow('Uploaded daemon version differs; the installed service was not changed')
    expect(deltaLines(h)).toHaveLength(1)
    const dirs = new Set(chunkWrites(h).map((p) => path.dirname(p)))
    expect(dirs.size).toBe(1)
    expect(calls()).toEqual([])
  }, 60_000)

  it('a delta cut mid-upload sends only its missing chunks on the next try', async () => {
    const { base, fresh, gz } = pair({ changeAt: [0.2, 0.5, 0.8] })
    const first = host({ corrupt: (p) => /chunk_0001$/.test(p) })
    await expect(updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(first, fast()), 'user'))
      .rejects.toThrow('the installed service was not changed')
    expect(chunkWrites(first).map((p) => p.slice(-4))).toEqual(['0000', '0001', '0001', '0001'])
    expect(new Set(chunkWrites(first).map((p) => path.dirname(p)))).toEqual(new Set([chunkDirOf('delta')]))
    const second = host()
    await updateRemoteDaemonService({ binary: null, gz, base }, LAB_VERSION, createNetUpdateIo(second, fast()), 'user')
    expect(deltaLines(second)).toHaveLength(1)
    expect(chunkWrites(second).map((p) => p.slice(-4))[0]).toBe('0001')
    expect(fs.readFileSync(BUILT()).equals(fresh)).toBe(true)
  }, 90_000)
})
