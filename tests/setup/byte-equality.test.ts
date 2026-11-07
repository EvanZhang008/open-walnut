/**
 * tests/setup/byte-equality.ts: `toEqual` on bytes compares bytes (2026-11-07: vitest's deep
 * equality took 14 to 19 s on a 2 to 3 MB Buffer, and the files-cloud media tests timed out
 * on a loaded machine). Every vitest config that loads the setup files loads it, so a new
 * config cannot quietly bring the slow compare back.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { bytesEqual } from './byte-equality.js'

const ROOT = path.resolve(__dirname, '..', '..')

describe('byte equality', () => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 73)
  for (let i = 0; i < big.length; i++) big[i] = i % 251

  it('compares multi-megabyte buffers as bytes, at once', () => {
    const started = performance.now()
    expect(Buffer.from(big)).toEqual(big)
    expect(Buffer.from(big.subarray(17, 2_097_173))).toEqual(big.subarray(17, 2_097_173))
    expect(new Uint8Array(big)).toEqual(new Uint8Array(big))
    // Seconds per compare without the tester; well under one with it, even on a loaded host.
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('still tells different bytes and lengths apart', () => {
    const other = Buffer.from(big)
    other[other.length - 1] ^= 1
    expect(bytesEqual(other, big)).toBe(false)
    expect(bytesEqual(big.subarray(1), big)).toBe(false)
    expect(Buffer.from('abc')).not.toEqual(Buffer.from('abd'))
  })

  it('leaves mixed kinds and non-bytes to vitest', () => {
    expect(bytesEqual(Buffer.from('abc'), new Uint8Array([97, 98, 99]))).toBeUndefined()
    expect(bytesEqual('abc', 'abc')).toBeUndefined()
    expect(bytesEqual(new Uint16Array(2), new Uint16Array(2))).toBeUndefined()
  })

  it('every vitest config that loads bun-compat.ts loads byte-equality.ts too', () => {
    const configs = fs.readdirSync(ROOT).filter((name) => /^vitest(\..+)?\.config\.ts$/.test(name))
    expect(configs).toContain('vitest.config.ts')
    const missing = configs.filter((name) => {
      const text = fs.readFileSync(path.join(ROOT, name), 'utf8')
      return text.includes('tests/setup/bun-compat.ts') && !text.includes('tests/setup/byte-equality.ts')
    })
    expect(missing).toEqual([])
  })
})
