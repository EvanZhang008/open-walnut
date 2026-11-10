/**
 * The Mac app's Swift sources are listed in three places: desktop/build.sh, desktop/build-release.sh
 * and scripts/lib/desktop-app-sources.sh (which the window tests compile). A file one of them misses
 * breaks the build or the tests that ship it (2026-11-10: the window tests did not compile, because
 * their own lists lacked WalnutIntents.swift). This fails when the three disagree, and when a window
 * test compiles an app file by name instead of through the shared list.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const rel = (p: string) => path.relative(ROOT, p)

/** The files a build script's SOURCES=( ... ) array names, repo-relative. */
function buildSources(script: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, script), 'utf8')
  const block = /^SOURCES=\(\n([\s\S]*?)^\)/m.exec(text)
  expect(block, `${script} has a SOURCES=( ... ) array`).toBeTruthy()
  return [...block![1].matchAll(/"\$SCRIPT_DIR\/([^"]+\.swift)"/g)].map((m) => path.normalize(path.join('desktop', m[1]))).sort()
}

describe('the Mac app sources', () => {
  const shared = execFileSync('bash', [path.join(ROOT, 'scripts/lib/desktop-app-sources.sh'), ROOT], { encoding: 'utf8' })
    .trim().split('\n').map(rel).sort()

  it('the shared list is every app file in desktop/, and the two src/data helpers', () => {
    expect(shared).toContain('desktop/main.swift')
    expect(shared).toContain('src/data/walnut-calendar.swift')
    expect(shared).not.toContain('desktop/make-icon.swift')
  })

  for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
    it(`${script} builds the same files`, () => {
      expect(buildSources(script)).toEqual(shared)
    })
  }

  for (const script of ['scripts/test-desktop-update-windows.sh', 'scripts/test-desktop-popout.sh']) {
    it(`${script} compiles the app through the shared list`, () => {
      const text = fs.readFileSync(path.join(ROOT, script), 'utf8')
      expect(text).toContain('scripts/lib/desktop-app-sources.sh')
      const swiftc = text.slice(text.indexOf('swiftc '), text.indexOf(' -o ', text.indexOf('swiftc ')))
      expect(swiftc.match(/\$ROOT\/(desktop|src\/data)\/[^"]+\.swift/g) ?? []).toEqual([])
    })
  }
})
