/**
 * Every pack of a checkout that may be shared says what it may bundle (2026-11-12: a move from a
 * shared checkout shipped 2,240 commits of its main, and the first-start placement probe packed the
 * same checkout the same way). A `packWorkspace(` call in src/ passes `noBundle` (what it is and its
 * own files only), `haves` (only what the target lacks) or `asDir: true` (a plain folder), or it is
 * one of the few listed below with the reason it is never a shared checkout. The calls are read
 * from the source, so a new one fails here until it says which.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(import.meta.dirname, '..', '..', '..', 'src')

/** Calls with none of the options, per file, and why each is fine. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'core/transfer/workspace.ts': { count: 1, why: 'moveWorkspace: an isolated workspace (task_transfer), never a shared checkout' },
  'core/transfer/target-base.ts': { count: 2, why: 'packAgainstTarget: the old way only where the target holds no copy to base on, or a copy lacks the base' },
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** The argument text of each `packWorkspace(` call in `src` (the definition left out). */
function calls(src: string): string[] {
  const out: string[] = []
  const re = /packWorkspace\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}

describe('packWorkspace callers say what a pack may bundle', () => {
  const found = files(SRC).map((f) => ({ file: path.relative(SRC, f), calls: calls(fs.readFileSync(f, 'utf8')) })).filter((x) => x.calls.length)

  it('finds the callers (the scan itself works)', () => {
    const names = found.map((x) => x.file)
    for (const f of ['core/transfer/task-work.ts', 'core/sessions/start-placement.ts', 'core/transfer/move-resume.ts', 'core/transfer/target-base.ts']) expect(names).toContain(f)
  })

  it('each call passes noBundle, haves or asDir, or is listed with its reason', () => {
    const bare: Record<string, number> = {}
    for (const { file, calls: cs } of found) {
      const n = cs.filter((c) => !/\bnoBundle\b|\bhaves\b|asDir: true/.test(c)).length
      if (n) bare[file] = n
    }
    expect(bare).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.count])))
  })
})
