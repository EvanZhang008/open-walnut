/**
 * The editor's own content hash must equal the server's, byte for byte.
 *
 * This equivalence is the whole basis of the write guard: the editor sends a token
 * DERIVED FROM the bytes it edited, and the server compares it to a token derived
 * from the bytes on disk. If the two functions ever disagree, every automatic write
 * 409s (annoying but safe) or, far worse, a mismatch is papered over somewhere and
 * the guard silently stops guarding.
 */
import { describe, it, expect } from 'vitest'
import { computeContentHash } from '../../src/utils/file-ops.js'
import { computeContentHashClient } from '../../web/src/utils/content-hash'

const CASES: Array<[string, string]> = [
  ['empty', ''],
  ['one char', 'a'],
  ['ascii line', '# Doc\n\nthe original body\n'],
  // Exactly 55 / 56 / 64 / 119 / 120 bytes: the SHA-256 padding boundaries, where
  // a hand-written implementation gets it wrong if it does.
  ['55 bytes', 'x'.repeat(55)],
  ['56 bytes', 'x'.repeat(56)],
  ['63 bytes', 'x'.repeat(63)],
  ['64 bytes', 'x'.repeat(64)],
  ['65 bytes', 'x'.repeat(65)],
  ['119 bytes', 'x'.repeat(119)],
  ['120 bytes', 'x'.repeat(120)],
  ['128 bytes', 'x'.repeat(128)],
  ['multibyte', '设计文档 · v2 — 架构\n\nこれはテストです\n'],
  ['emoji + combining', 'á 👩‍👩‍👧‍👦 😀\n'],
  ['crlf', 'line one\r\nline two\r\n'],
  ['nul and control bytes', 'a\u0000b\u0001c\u001f\n'],
  ['lone surrogate is replaced the same way', 'ok \uD800 tail'],
]

describe('computeContentHashClient matches the server', () => {
  for (const [name, content] of CASES) {
    it(name, () => {
      expect(computeContentHashClient(content)).toBe(computeContentHash(content))
    })
  }

  it('a realistic document (40 KB of markdown)', () => {
    const doc = `# Design\n\n${'a paragraph another writer added, with some **bold** and a [link](x).\n'.repeat(600)}`
    expect(doc.length).toBeGreaterThan(40_000)
    expect(computeContentHashClient(doc)).toBe(computeContentHash(doc))
  })

  it('a one-character difference changes the hash (it is not a length check)', () => {
    const a = 'x'.repeat(1000)
    const b = `${'x'.repeat(999)}y`
    expect(computeContentHashClient(a)).not.toBe(computeContentHashClient(b))
  })

  it('is 12 lowercase hex characters', () => {
    expect(computeContentHashClient('anything')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('agrees on 200 pseudo-random strings', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rnd() * 300)
      let s = ''
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rnd() * 0x2e80) + 1)
      expect(computeContentHashClient(s)).toBe(computeContentHash(s))
    }
  })
})
