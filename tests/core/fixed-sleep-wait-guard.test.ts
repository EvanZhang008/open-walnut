/**
 * A quick-tier test never sleeps a fixed number of ms and then asserts what the
 * work it waited for produced. On a loaded host the work is not done yet, and the
 * test fails for no reason in the code (2026-11-07: the voice archive copies and
 * the plugin-load push failed 3 of 3 runs on clean main under load, which refused
 * lands). Wait on the work instead: the promise or event the code exposes, or
 * `vi.waitFor` on the state it leaves.
 *
 * The scan finds a standalone sleep statement (`await new Promise(r => setTimeout(r, N))`,
 * `await sleep(N)`, `await delay(N)`, `await setTimeout(N)`, N a number or a
 * CONSTANT expression, not 0 or 1) with an `expect(` in the 3 lines after it. A
 * sleep that only lets time pass for a negative check ("nothing happened within
 * X"), one where the time itself is under test, and one under fake timers are
 * legitimate: they are listed in fixed-sleep-wait-allowlist.ts with a reason. The
 * list only shrinks: an entry that no longer matches a site must go.
 *
 * tests/helpers/fake-child.test.ts guards the narrower case of a fake child's exit
 * emitted right after a fixed sleep; this one covers every expect.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SLOW_TEST_DIRS, SLOW_TEST_FILES } from '../setup/slow-tests.js'
import { FIXED_SLEEP_ALLOWLIST } from './fixed-sleep-wait-allowlist.js'

const ARG = String.raw`(?:[\d_]+|[A-Z][A-Z0-9_]*)(?:\s*[-+*/]\s*(?:[\d_]+|[A-Z][A-Z0-9_]*))*`
const SLEEP = new RegExp(
  String.raw`^\s*await\s+(?:new\s+Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\1\s*,\s*(${ARG})\s*\)\s*;?\s*\}?\s*\)` +
  String.raw`|(?:sleep|delay|wait|pause)\(\s*(${ARG})\s*\)|setTimeout\(\s*(${ARG})\s*\))\s*;?\s*(?:\/\/.*)?$`,
)
const EXPECT = /\bexpect(?:\.soft)?\s*\(/

/** The sleep's argument when `line` is a standalone fixed sleep of 2 ms or more, else null. */
export function fixedSleepArg(line: string): string | null {
  const m = SLEEP.exec(line)
  if (!m) return null
  const arg = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  return /^[01]$/.test(arg) ? null : arg
}

/** Sites in one file's text: the trimmed sleep line of each fixed sleep followed within 3 lines by an expect. */
export function fixedSleepSites(text: string): Array<{ line: number; sleep: string }> {
  const lines = text.split('\n')
  const sites: Array<{ line: number; sleep: string }> = []
  lines.forEach((line, i) => {
    if (fixedSleepArg(line) === null) return
    if (lines.slice(i + 1, i + 4).some((next) => EXPECT.test(next))) sites.push({ line: i + 1, sleep: line.trim() })
  })
  return sites
}

/** Frontend-rooted suites the quick config leaves to their own configs (vitest.quick.config.ts). */
const FRONTEND_DIRS = ['tests/web/notes-roundtrip/', 'tests/web/diff-view/', 'tests/web/markdown/', 'tests/web/workflow-graph/']

function quickTierFiles(repo: string): string[] {
  const slowDirs = SLOW_TEST_DIRS.map((dir) => dir.replace(/\*\*$/, ''))
  const slowFiles = new Set<string>(SLOW_TEST_FILES)
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.test.ts') || entry.name.endsWith('.live.test.ts')) continue
      const rel = path.relative(repo, full).split(path.sep).join('/')
      if (slowFiles.has(rel) || [...slowDirs, ...FRONTEND_DIRS].some((dir) => rel.startsWith(dir))) continue
      out.push(rel)
    }
  }
  walk(path.join(repo, 'tests'))
  return out.sort()
}

describe('fixed sleep then expect', () => {
  it('finds the shapes a test writes', () => {
    expect(fixedSleepArg('    await new Promise((r) => setTimeout(r, 50))')).toBe('50')
    expect(fixedSleepArg('await new Promise<void>((resolve) => setTimeout(resolve, 1_500));')).toBe('1_500')
    expect(fixedSleepArg('  await new Promise(r => { setTimeout(r, 20) })')).toBe('20')
    expect(fixedSleepArg('  await sleep(WINDOW_MS + 10) // past the window')).toBe('WINDOW_MS + 10')
    expect(fixedSleepArg('  await setTimeout(30)')).toBe('30')
    // A turn yield, a computed wait and a sleep inside a fake are not this shape.
    expect(fixedSleepArg('  await new Promise((r) => setTimeout(r, 0))')).toBeNull()
    expect(fixedSleepArg('  await sleep(ms)')).toBeNull()
    expect(fixedSleepArg("  if (op === 'x') await new Promise((r) => setTimeout(r, 6_000))")).toBeNull()
    expect(fixedSleepSites('await sleep(50)\nfoo()\n\nexpect(x).toBe(1)')).toEqual([{ line: 1, sleep: 'await sleep(50)' }])
    expect(fixedSleepSites('await sleep(50)\na()\nb()\nc()\nexpect(x).toBe(1)')).toEqual([])
  })

  it('no quick-tier test waits a fixed time and then asserts the work it waited for', () => {
    const repo = path.resolve(__dirname, '../..')
    const allowed = new Map<string, number>()
    const key = (file: string, sleep: string) => `${file}\t${sleep}`
    for (const entry of FIXED_SLEEP_ALLOWLIST) {
      expect(entry.reason.trim().length, `reason for ${entry.file}: ${entry.sleep}`).toBeGreaterThanOrEqual(10)
      allowed.set(key(entry.file, entry.sleep), (allowed.get(key(entry.file, entry.sleep)) ?? 0) + 1)
    }
    const offenders: string[] = []
    for (const file of quickTierFiles(repo)) {
      if (file === 'tests/core/fixed-sleep-wait-guard.test.ts') continue
      for (const site of fixedSleepSites(fs.readFileSync(path.join(repo, file), 'utf8'))) {
        const k = key(file, site.sleep)
        const left = allowed.get(k) ?? 0
        if (left > 0) allowed.set(k, left - 1)
        else offenders.push(`${file}:${site.line}  ${site.sleep}`)
      }
    }
    expect(offenders, 'wait on the work (its promise or event, or vi.waitFor on its state), not on a clock; '
      + 'a legitimate negative or time-under-test wait goes in fixed-sleep-wait-allowlist.ts with its reason').toEqual([])
    const stale = [...allowed].filter(([, n]) => n > 0).map(([k, n]) => `${k.replace('\t', ': ')} (x${n})`)
    expect(stale, 'these allowlist entries match no site any more: remove them').toEqual([])
  })
})
