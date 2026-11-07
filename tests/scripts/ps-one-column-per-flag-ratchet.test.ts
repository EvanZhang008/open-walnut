/**
 * Every `ps` column with a blank header gets its own `-o`.
 *
 * Linux procps-ng 3.3.10 (Amazon Linux 2) reads everything after a column's `=` as that
 * column's header, commas included: `ps -o pid=,ppid=` prints ONE column headed ",ppid=",
 * then the pids. macOS BSD ps splits at the comma, so a list like that works on the Mac
 * and silently loses every column but the first on such a host (2026-11-07: a host
 * daemon's process snapshot for the approvals caller proof parsed to zero rows there, so
 * every ask from that host read "not checked"). `ps -o pid= -o ppid=` works on both.
 *
 * This scans every tracked source, script and test (Swift under desktop/ and ios-native/
 * runs only on Apple systems and is left out) for a `-o` list, or a quoted column list,
 * with a blank-headed column followed by another one.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')
const COLUMN = String.raw`[a-z%]+`
// `-o pid=,ppid=` / `-axo pid=,comm=` in a shell line or prose.
const SHELL_LIST = new RegExp(String.raw`-[A-Za-z]*o\s+${COLUMN}=,${COLUMN}`)
// `'pid=,ppid='` as a quoted literal of column names only (an argv element or a constant).
const QUOTED_LIST = new RegExp(String.raw`(['"\x60])(?:${COLUMN}=?,)*${COLUMN}=,${COLUMN}=?(?:,${COLUMN}=?)*\1`)

export function joinedBlankColumns(text: string): number[] {
  const lines: number[] = []
  text.split('\n').forEach((line, i) => {
    if (SHELL_LIST.test(line) || QUOTED_LIST.test(line)) lines.push(i + 1)
  })
  return lines
}

const SELF = path.relative(ROOT, __filename)

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts', 'packages', 'tests', 'web/src', 'bin'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  return out.split('\0').filter((f) => f && /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|bash|zsh|py)$/.test(f) && f !== SELF)
}

describe('ps columns: one -o per blank-headed column', () => {
  it('finds the joined forms and leaves the split ones', () => {
    expect(joinedBlankColumns(`execFile('ps', ['-Ao', 'pid=,ppid=,comm='])`)).toEqual([1])
    expect(joinedBlankColumns(`ps -eo pid=,command= | grep x`)).toEqual([1])
    expect(joinedBlankColumns(`const COLS = 'pid=,lstart='`)).toEqual([1])
    expect(joinedBlankColumns(`/** \`ps -o pgid=,stat=\` */`)).toEqual([1])
    expect(joinedBlankColumns(`execFile('ps', ['-Ao', 'pid=', '-o', 'ppid=', '-o', 'comm='])`)).toEqual([])
    expect(joinedBlankColumns(`ps -eo pid= -o command= | grep x`)).toEqual([])
    // A named header only on the last column is fine on both systems.
    expect(joinedBlankColumns(`ps -o pid,comm=`)).toEqual([])
    expect(joinedBlankColumns(`const q = 'a=1,b=2'`)).toEqual([])
  })

  it('no tracked file joins blank-headed ps columns', () => {
    const found: string[] = []
    for (const f of trackedFiles()) {
      let text: string
      try { text = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
      if (!text.includes('=,')) continue
      for (const n of joinedBlankColumns(text)) found.push(`${f}:${n}`)
    }
    expect(found, 'write `-o a= -o b=`, one -o per column: procps 3.3.10 reads `a=,b=` as one column headed ",b="').toEqual([])
  })
})
