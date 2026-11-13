/**
 * The whole-file read's byte ceiling is a designed answer, not a fault.
 *
 * 2026-11-13: a chronic log alarm fired on "DaemonFileReader: whole-file read
 * exceeds the byte ceiling" (2,224, 1,889, 1,567 a day). Every one came from a
 * caller that already handles the refusal (the history read degrades to a bounded
 * tail, the ACP journal to a tail window, plan extraction to a tail scan), and
 * each refusal rode out as a chain of warns: the reader's, the transport's
 * ("JSONL read via daemon failed") and the caller's own.
 *
 * Guards for the whole class:
 *  1. The refusal has ONE identity (src/core/byte-ceiling.ts): no caller matches
 *     the message text by hand, so a new caller cannot miss the shared rule.
 *  2. A warn line that names the ceiling must be a real fault and is listed here
 *     with its reason; a new one fails until it is justified or logged at info.
 *  3. The reader's fail-fast refusal (size known before reading) does not warn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { byteCeilingError, isByteCeilingError } from '../../src/core/byte-ceiling.js'

const SRC = path.resolve(__dirname, '../../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Warn lines naming the ceiling that report a real fault, each with why. */
const ALLOWED_CEILING_WARNS: Record<string, string> = {
  // The size was unknown (no stat) or the file grew past the ceiling mid-read:
  // bytes were transferred for nothing, which a caller with a stat never does.
  'DaemonFileReader: read exceeded the byte ceiling — refusing': 'bytes moved before the refusal',
  // The tail may show a rewound-away branch as live: a correctness loss.
  'rewound transcript over the byte ceiling — bounded tail is served UNFILTERED': 'served history may be wrong',
}

describe('byte ceiling refusals', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('has one identity: no source matches the refusal text by hand', () => {
    const offenders = sourceFiles(SRC)
      .filter(f => !f.endsWith(path.join('core', 'byte-ceiling.ts')))
      .filter(f => /(?:includes|indexOf|startsWith|endsWith)\(\s*['"`][^'"`]*byte ceiling|\/[^/\n]*byte ceiling[^/\n]*\/[gimsuy]*\.test\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('warns only for the listed real faults (a designed degrade logs at info)', () => {
    const found = new Set<string>()
    const re = /\.warn\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*?ceiling(?:(?!\1)[^\\]|\\.)*?)\1/gs
    for (const f of sourceFiles(SRC)) {
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(re)) found.add(m[2])
    }
    const unlisted = [...found].filter(msg => !(msg in ALLOWED_CEILING_WARNS))
    expect(unlisted).toEqual([])
    // A listed warn that no longer exists is dropped from the list.
    expect(Object.keys(ALLOWED_CEILING_WARNS).filter(msg => !found.has(msg))).toEqual([])
  })

  it('recognises its own error and nothing else', () => {
    expect(isByteCeilingError(byteCeilingError(1024, '/x.jsonl', 4096))).toBe(true)
    expect(isByteCeilingError(new Error('fs.readRange transport failure: timeout'))).toBe(false)
    expect(isByteCeilingError(undefined)).toBe(false)
  })
})
