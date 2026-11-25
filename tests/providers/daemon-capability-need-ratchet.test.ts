/**
 * Ratchet: a feature that refuses or degrades without a daemon capability asks for it through
 * needCapability (src/providers/daemon-capability-need.ts), so a daemon that lacks it is updated
 * past the 2 h update gap (daemon-update-gap.ts) instead of leaving the feature cut off. A plain
 * `hasCapability` stays a read (an optional probe with a fallback that works).
 *
 * The class, found in the source: every line that refuses for a missing daemon capability (a
 * DaemonNeedsUpgradeError, a daemon_needs_upgrade / daemon_upgrade / daemon-upgrade /
 * daemon_too_old answer, the PTY's "needs an update" sentence, or the "older than this Walnut",
 * "too old for/to" and "needs an update before" words). Its capability check sits on that line
 * or in the three above it; one there that is a bare `hasCapability(` with no `needCapability(`
 * fails this test. Review r1 of the update-gap change, medium 3 (2026-11-25).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const REFUSAL = /new DaemonNeedsUpgradeError\(|'daemon_needs_upgrade'|'daemon[-_]upgrade'|'daemon_too_old'|ptyStreamMissingSentence\(|older than this Walnut|too old (for|to)\b|needs an update before/
const WINDOW = 3

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line)

/** Every refusal site, and whether its capability check (if it has one there) goes through needCapability. */
function refusalSites(): Array<{ at: string; checked: boolean; routed: boolean }> {
  const out: Array<{ at: string; checked: boolean; routed: boolean }> = []
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (isComment(line) || !REFUSAL.test(line)) return
      const near = lines.slice(Math.max(0, i - WINDOW), i + 1).filter((l) => !isComment(l)).join('\n')
      out.push({ at: `${path.relative(ROOT, file)}:${i + 1}`, checked: /\bhasCapability\b|\bneedCapability\(/.test(near), routed: /\bneedCapability\(/.test(near) })
    })
  }
  return out
}

describe('a refusal for a missing daemon capability asks for it through needCapability', () => {
  it('finds the class, and every capability check in it goes through needCapability', () => {
    const sites = refusalSites()
    // The class is not empty: the scan still reads what it was written for.
    expect(sites.filter((s) => s.checked).length).toBeGreaterThan(15)
    expect(sites.filter((s) => s.checked && !s.routed).map((s) => s.at),
      'a refusal whose capability check is a bare hasCapability: use needCapability(conn, cap), so the daemon is updated past the gap').toEqual([])
  })

  it('hasCapability stays a read, and the PTY refusal asks', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-connection.ts'), 'utf8')
    expect(src).toMatch(/hasCapability\(cap: string\): boolean \{ return this\._capabilities\?\.includes\(cap\) \?\? false \}/)
    expect(src).toMatch(/if \(!needCapability\(this, PTY_STREAM_CAPABILITY\)\) return Promise\.reject\(/)
  })
})
