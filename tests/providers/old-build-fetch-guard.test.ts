/**
 * Guard: a test file that reads the old 1fe1fd194 build fetches it in a beforeAll with
 * OLD_BUILD_FETCH_MS, never inside a test. CI's clone is shallow, so the first read fetches the
 * commit from the remote, and a slow fetch timed two quick-tier tests out at 15 s (2026-11-03).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') testFiles(p, out) } else if (/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * A file reads an old commit when it uses the old-build helpers or runs `git archive` itself (an
 * argv `'git', [..., 'archive'` or a shell line `` `git ... archive ${...}` ``): an archive of a
 * commit a shallow clone may lack. Prose that only mentions either does not count. 2026-11-04:
 * replica-old-mac-e2e ran its own `git archive 1fe1fd194 | tar` without the helper, so on CI's
 * shallow clone a failed beforeAll skipped every test of it, unseen until the e2e baseline
 * counted such files.
 */
function readsAnOldCommit(text: string): boolean {
  return text.includes('helpers/v1-daemon-sources')
    || /['"]git['"],\s*\[[^\]]*['"]archive['"]/.test(text)
    || /`git [^`\n]*\barchive \$\{/.test(text)
}

describe('the old build is fetched before the tests that read it', () => {
  const readers = testFiles(path.join(ROOT, 'tests'))
    .filter((f) => f !== __filename && readsAnOldCommit(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f))

  it('finds the readers at all', () => {
    expect(readers).toEqual(expect.arrayContaining(['tests/providers/offline-host-journal-v2.test.ts', 'tests/providers/offline-journal-migration-claim.test.ts', 'tests/e2e/replica-old-mac-e2e.test.ts', 'tests/integration/journal-v2-twins.test.ts']))
  })

  it('every reader fetches it in a beforeAll with the fetch budget', () => {
    const missing = readers.filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return !/beforeAll\(/.test(text) || !/beforeAll\([^\n]*\n?[^\n]*OLD_BUILD_FETCH_MS\)|}, OLD_BUILD_FETCH_MS\)/.test(text)
    })
    expect(missing, 'add beforeAll(() => ensureOldBuild(), OLD_BUILD_FETCH_MS) to these files').toEqual([])
  })
})
