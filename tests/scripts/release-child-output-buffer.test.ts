/**
 * A child process's output is cut at 1 MB unless the call names a bigger maxBuffer, and the
 * call then throws ENOBUFS. 2026-11-28 (Release runs 46087167625, 46087557590): the stable's
 * plan read `git log v0.6.37..<nightly>`, 2,423 commits and 1.57 MB of subjects and bodies,
 * and failed with "spawnSync git ENOBUFS", so 0.6.38 was not promoted. The output grows with
 * every commit between two releases, so every call in the scripts the release workflows run
 * that reads a child's output names its maxBuffer. This file finds those scripts from the
 * workflows themselves (and what they import), and fails on a new call without one.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.join(import.meta.dirname, '..', '..')
const WORKFLOWS = ['release.yml', 'binary-matrix.yml']

/** The scripts the release workflows run, and every script they import, by relative path. */
function releaseScripts(): string[] {
  const seen = new Set<string>()
  const stack: string[] = []
  for (const wf of WORKFLOWS) {
    const text = fs.readFileSync(path.join(REPO, '.github/workflows', wf), 'utf8')
    for (const m of text.matchAll(/\b(?:bun|node) (scripts\/[\w./-]+\.mjs)\b/g)) stack.push(m[1]!)
  }
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f) || !fs.existsSync(path.join(REPO, f))) continue
    seen.add(f)
    const src = fs.readFileSync(path.join(REPO, f), 'utf8')
    for (const m of src.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]!)))
    }
  }
  return [...seen].sort()
}

/** The text of each execFileSync / spawnSync / execSync call in `src`. */
function childCalls(src: string): string[] {
  const calls: string[] = []
  for (const m of src.matchAll(/\b(?:execFileSync|spawnSync|execSync)\(/g)) {
    let depth = 0
    let j = m.index! + m[0].length - 1
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) break
    }
    calls.push(src.slice(m.index!, j + 1))
  }
  return calls
}

describe('the release scripts read a child process\'s output without the 1 MB cut', () => {
  const scripts = releaseScripts()

  it('finds the release scripts, the stable plan among them', () => {
    expect(scripts).toEqual(expect.arrayContaining(['scripts/stable-promote.mjs', 'scripts/ci-gate.mjs', 'scripts/release.mjs']))
  })

  it('every call that reads its output names a maxBuffer', () => {
    const offenders: string[] = []
    for (const f of scripts) {
      for (const call of childCalls(fs.readFileSync(path.join(REPO, f), 'utf8'))) {
        // stdio: 'inherit' or 'ignore' reads nothing back.
        if (/stdio:\s*'(inherit|ignore)'/.test(call)) continue
        if (!/maxBuffer:/.test(call)) offenders.push(`${f}: ${call.replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('a call with the default buffer fails on the output the stable plan read, and one with a maxBuffer does not', () => {
    const print = ['-e', 'process.stdout.write("x".repeat(1_600_000))']
    expect(() => execFileSync(process.execPath, print, { encoding: 'utf8' })).toThrow(/ENOBUFS|maxBuffer/)
    expect(execFileSync(process.execPath, print, { encoding: 'utf8', maxBuffer: 256 << 20 })).toHaveLength(1_600_000)
  })
})
