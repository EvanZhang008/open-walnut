/**
 * Every trigger check run the daemon starts names the Walnut whose trigger it is.
 *
 * A run's `walnut` calls go out as `external`, which names no Walnut on a host two Walnuts share;
 * the daemon routes them by CheckCaller.home, set where it mints the run (trigger-check-core.ts
 * createCheckCallers). 2026-11-25: with no home on the run, every check's call on a shared host
 * waited 90 s for a server and its CLI gave up after 12 s (daemon-check-calls-two-walnuts.test.ts).
 * So every `checkCallers.mint(` in src/providers passes a `home`, and a new way of starting a check
 * run that forgets it fails here.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadSources } from '../helpers/source-files.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MINT = /\bcheckCallers\s*\.\s*mint\s*\(/g

/** Each `checkCallers.mint(...)` call's argument text, balanced on parentheses; `line` counts in the text given (comments out). */
function mintCalls(code: string): Array<{ line: number; arg: string }> {
  const out: Array<{ line: number; arg: string }> = []
  for (const m of code.matchAll(MINT)) {
    const open = m.index! + m[0].length
    let depth = 1
    let i = open
    while (i < code.length && depth > 0) {
      const ch = code[i]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      i += 1
    }
    out.push({ line: code.slice(0, m.index).split('\n').length, arg: code.slice(open, i - 1) })
  }
  return out
}

const namesHome = (arg: string) => /\bhome\b/.test(arg)

describe('every check run names its Walnut', () => {
  it('the scan reads a call\'s argument and tells one with no home', () => {
    const calls = mintCalls("const c = checkCallers.mint({ kind: 'armed', id: f(x) })\nconst d = checkCallers.mint({ ...t, ...(h ? { home: h } : {}) })")
    expect(calls.map((c) => c.line)).toEqual([1, 2])
    expect(calls.map((c) => namesHome(c.arg))).toEqual([false, true])
  })

  it('each checkCallers.mint( in src/providers passes a home', async () => {
    const src = await loadSources(ROOT, ['src/providers'])
    const sites = src.files.flatMap((file) => mintCalls(src.code(file)).map((c) => ({ file, ...c })))
    // The armed run (daemon-trigger-runs.ts) and the test run (daemon-trigger-commands.ts) at least.
    expect(sites.map((s) => s.file).sort()).toEqual(expect.arrayContaining(['src/providers/daemon-trigger-commands.ts', 'src/providers/daemon-trigger-runs.ts']))
    const missing = sites.filter((s) => !namesHome(s.arg)).map((s) => `${s.file}: checkCallers.mint(${s.arg.trim()})`)
    expect(missing, 'pass the Walnut whose trigger the run is as `home` (CheckCaller.home)').toEqual([])
  })

  it('the daemon keeps its run registry under the one name the scan reads', async () => {
    // A registry made under another name would mint runs this guard never sees.
    const src = await loadSources(ROOT, ['src/providers'])
    const made = src.files.filter((f) => f !== 'src/providers/trigger-check-core.ts' && /\bcreateCheckCallers\s*\(/.test(src.code(f)))
    for (const file of made) {
      const decl = [...src.code(file).matchAll(/(\w+)\s*=\s*createCheckCallers\s*\(/g)].map((m) => m[1])
      expect(decl, file).toEqual(['checkCallers'])
    }
    expect(made).toEqual(['src/providers/daemon-standalone.ts'])
  })
})
