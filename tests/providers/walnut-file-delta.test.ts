/**
 * The walnut file sent as a delta (walnut-file-delta.ts + slotDeltaInstallScript):
 * the host scripts run for real under /bin/sh in a temp dir, so the bytes the
 * host builds are checked against the new file itself, block by block.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import {
  DELTA_BLOCK_BYTES, DELTA_MAX_CHANGED_SHARE, blockHashScript, parseBlockHashes, planWalnutFileDelta,
} from '../../src/providers/walnut-file-delta.js'
import { parseSlotAnswer, slotDeltaInstallScript, slotDeltaPath } from '../../src/providers/daemon-file-slot.js'

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

function sh(script: string): { out: string; err: string; code: number | null } {
  const r = spawnSync('/bin/sh', ['-s'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { out: r.stdout, err: r.stderr, code: r.status }
}

/** A file of `blocks` blocks (the last `tail` bytes long when set), each block's bytes seeded by its index. */
function fileOf(blocks: number, seed: (i: number) => number, tail?: number): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < blocks; i++) {
    const len = i === blocks - 1 && tail ? tail : DELTA_BLOCK_BYTES
    const b = Buffer.alloc(len)
    let x = seed(i) * 2654435761 >>> 0
    for (let j = 0; j < len; j += 4) { x = (x * 1103515245 + 12345) >>> 0; b.writeUInt32LE(x, Math.min(j, len - 4)) }
    parts.push(b)
  }
  return Buffer.concat(parts)
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-delta-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function roundTrip(oldFile: Buffer, newFile: Buffer) {
  const slot = path.join(dir, 'daemon-linux-x64')
  fs.writeFileSync(slot, oldFile, { mode: 0o755 })
  const hashed = sh(blockHashScript(slot))
  const base = parseBlockHashes(hashed.out)
  expect(base).not.toBeNull()
  const plan = await planWalnutFileDelta(zlib.gzipSync(newFile), base!.hashes)
  return { slot, base: base!, plan }
}

describe('walnut file delta', () => {
  it('sends only the changed blocks, and the host builds the new file byte for byte', async () => {
    // Like two builds: the front (the runtime) is the same, a block early on and the tail differ, the file grew.
    const oldFile = fileOf(40, (i) => i, 1000)
    const newFile = fileOf(43, (i) => (i === 0 || i >= 30 ? i + 1000 : i), 3333)
    const { slot, base, plan } = await roundTrip(oldFile, newFile)
    expect(base.hashes).toHaveLength(40)
    expect(plan).not.toBeNull()
    expect(plan!.blocks).toBe(43)
    expect(plan!.changed).toEqual([0, ...Array.from({ length: 13 }, (_, k) => 30 + k)])
    expect(plan!.size).toBe(newFile.length)
    expect(plan!.payloadSha256).toBe(sha(plan!.payload))

    const remote = slotDeltaPath(slot)
    fs.writeFileSync(remote, plan!.payload)
    // A cut upload's chunks of the delta, left beside it: the install removes them.
    fs.mkdirSync(`${remote}.chunks-abc`)
    const run = sh(slotDeltaInstallScript(slot, remote, sha(newFile), {
      blocks: plan!.blocks, changed: plan!.changed, blockBytes: DELTA_BLOCK_BYTES,
    }))
    expect(run.err).toBe('')
    expect(parseSlotAnswer(run.out)).toBe('installed')
    expect(sha(fs.readFileSync(slot))).toBe(sha(newFile))
    expect((fs.statSync(slot).mode & 0o777).toString(8)).toBe('755')
    expect(fs.readdirSync(dir).sort()).toEqual(['daemon-linux-x64'])
  })

  it('a file that shrank is built right too', async () => {
    const oldFile = fileOf(20, (i) => i)
    const newFile = fileOf(12, (i) => (i === 11 ? 99 : i), 777)
    const { slot, plan } = await roundTrip(oldFile, newFile)
    expect(plan!.changed).toEqual([11])
    fs.writeFileSync(slotDeltaPath(slot), plan!.payload)
    const run = sh(slotDeltaInstallScript(slot, slotDeltaPath(slot), sha(newFile), { blocks: plan!.blocks, changed: plan!.changed, blockBytes: DELTA_BLOCK_BYTES }))
    expect(parseSlotAnswer(run.out)).toBe('installed')
    expect(fs.readFileSync(slot).equals(newFile)).toBe(true)
  })

  it('a payload that does not build the expected file leaves the slot as it was', async () => {
    const oldFile = fileOf(10, (i) => i)
    const newFile = fileOf(10, (i) => (i === 3 ? 50 : i))
    const { slot, plan } = await roundTrip(oldFile, newFile)
    fs.writeFileSync(slotDeltaPath(slot), plan!.payload)
    const run = sh(slotDeltaInstallScript(slot, slotDeltaPath(slot), sha(Buffer.from('another build')), { blocks: plan!.blocks, changed: plan!.changed, blockBytes: DELTA_BLOCK_BYTES }))
    expect(run.code).toBe(1)
    expect(run.err).toContain('broken')
    expect(fs.readFileSync(slot).equals(oldFile)).toBe(true)
    expect(fs.existsSync(`${slot}.part`)).toBe(false)
    expect(fs.existsSync(`${slot}.delta.raw`)).toBe(false)
    expect(fs.existsSync(slotDeltaPath(slot))).toBe(false)
  })

  it('most blocks changed: no delta, the whole file goes', async () => {
    const oldFile = fileOf(10, (i) => i)
    const newFile = fileOf(10, (i) => (i < Math.ceil(10 * DELTA_MAX_CHANGED_SHARE) + 1 ? i + 500 : i))
    const { plan } = await roundTrip(oldFile, newFile)
    expect(plan).toBeNull()
  })

  it('a slot with no file answers no delta', () => {
    expect(parseBlockHashes(sh(blockHashScript(path.join(dir, 'missing'))).out)).toBeNull()
    expect(sh(blockHashScript(path.join(dir, 'missing'))).out).toContain('delta=nobase')
  })

  it('an answer cut short or out of order is no delta', () => {
    const h = 'a'.repeat(64)
    expect(parseBlockHashes(`size=${DELTA_BLOCK_BYTES * 2}\nb 0 ${h}\ndelta=hashed`)).toBeNull()
    expect(parseBlockHashes(`size=${DELTA_BLOCK_BYTES * 2}\nb 1 ${h}\nb 0 ${h}\ndelta=hashed`)).toBeNull()
    expect(parseBlockHashes(`size=${DELTA_BLOCK_BYTES * 2}\nb 0 ${h}\nb 1 ${h}`)).toBeNull()
    expect(parseBlockHashes(`banner from an rc file\nsize=${DELTA_BLOCK_BYTES * 2}\nb 0 ${h}\nb 1 ${h}\ndelta=hashed`)?.hashes).toEqual([h, h])
  })

  it('refuses a block index outside the file', () => {
    expect(() => slotDeltaInstallScript('/tmp/x', '/tmp/x.delta.gz', 'a'.repeat(64), { blocks: 3, changed: [3], blockBytes: DELTA_BLOCK_BYTES })).toThrow()
    expect(() => slotDeltaInstallScript('/tmp/x', '/tmp/x.delta.gz', 'a'.repeat(64), { blocks: 3, changed: [-1], blockBytes: DELTA_BLOCK_BYTES })).toThrow()
  })
})
