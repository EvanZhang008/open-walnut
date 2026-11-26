/**
 * Every Walnut Health item raised through raiseHealthItem says which shape it is
 * (src/core/notifications/health-items.ts): a CONDITION that stands and recovers (a recoveryKey in
 * the call, or raised through healthConditions, whose items are recovered by key), or an EVENT that
 * happened once (`{ once: true }`). An event raised without `once` is counted again each time it is
 * told again (a server restart replaying a host's hello), and keeps "Background errors keep
 * happening" in alarm long after it happened (2026-11-26, a host's launcher put-back).
 *
 * The call sites are enumerated from the source, so a new caller that names neither fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** The text of one call: from `raiseHealthItem(` to its closing paren. */
function callText(src: string, start: number): string {
  let depth = 0
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

/** healthConditions' own raise: its items are recovered by their key (recover()). */
const CONDITION_HELPER = 'src/core/notifications/health-items.ts'

describe('Walnut Health items name their shape', () => {
  it('every raiseHealthItem call is a condition (recoveryKey) or an event ({ once: true })', () => {
    const calls: string[] = []
    const bad: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const src = fs.readFileSync(file, 'utf8')
      const rel = path.relative(ROOT, file)
      for (const m of src.matchAll(/\braiseHealthItem\(/g)) {
        const before = src.slice(Math.max(0, m.index! - 30), m.index!)
        if (/function\s+$/.test(before)) continue // the definition
        const text = callText(src, m.index!)
        const line = src.slice(0, m.index!).split('\n').length
        calls.push(`${rel}:${line}`)
        if (rel === CONDITION_HELPER) continue
        if (/\bonce:\s*true\b/.test(text) || /\brecoveryKey\b/.test(text)) continue
        bad.push(`${rel}:${line}`)
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(bad, 'say { once: true } for an event, or give the item a recoveryKey for a condition').toEqual([])
  })
})
