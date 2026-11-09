/**
 * A `LaunchGate.shared.whenActive { ... }` closure inside a SwiftUI view stays
 * short. Its body is type-checked together with the modifier chain it sits in,
 * once for each `whenActive` overload (sync and async), and CI's compiler gave
 * up on a long one with "unable to type-check this expression in reasonable
 * time" (2026-11-09, WalnutApp.swift: the store hydration, 18 statements, in
 * MainTabView's chain; the error moved between lines from run to run). Longer
 * work goes in a named method the closure calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')
const MAX_CODE_LINES = 3

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return swiftFiles(p)
    return e.name.endsWith('.swift') ? [p] : []
  })
}

/** Each whenActive closure in a file that declares a View, with its code lines. */
function closures(file: string): { at: string; lines: number }[] {
  const src = fs.readFileSync(file, 'utf8')
  if (!/:\s*(?:some\s+)?View\b/.test(src)) return []
  const out: { at: string; lines: number }[] = []
  const re = /whenActive\s*\{/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let end = open
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = src.slice(open + 1, end).replace(/^\s*\[[^\]]*\]\s*in\b/, '')
    const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).length
    const line = src.slice(0, m.index).split('\n').length
    out.push({ at: `${path.relative(ROOT, file)}:${line}`, lines })
  }
  return out
}

describe('whenActive closures in SwiftUI views', () => {
  const all = swiftFiles(APP).flatMap(closures)

  it('finds the closures it guards', () => {
    expect(all.some((c) => c.at.startsWith('ios-native/Walnut/App/WalnutApp.swift'))).toBe(true)
  })

  it(`holds at most ${MAX_CODE_LINES} code lines each; longer work is a named method`, () => {
    expect(all.filter((c) => c.lines > MAX_CODE_LINES)).toEqual([])
  })
})
