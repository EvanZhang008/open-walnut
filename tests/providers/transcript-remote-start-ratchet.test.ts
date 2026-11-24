/**
 * The two ways a session kept in remote storage went wrong on 2026-11-19, held for every place
 * that can repeat them, found from the source:
 *
 * - every fetch from remote storage goes through the archive's restore, where a failure is
 *   remembered (transcript-remote-retry.ts): a second caller of the fetcher would ask the
 *   storage again on every read (about a hundred fetches an hour for one session);
 * - every start of a CLI restores through restoreForStart, which refuses a start whose history
 *   cannot come back: restoreSessionAnywhere swallows that failure, and a start that used it
 *   began a new conversation where the old one belonged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(ts|js|cjs|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}
const files = sourceFiles('src').map((rel) => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') }))
const callsOf = (re: RegExp) => files.flatMap(({ rel, text }) => [...text.matchAll(re)].map(() => rel))

describe('remote history fetches and starts', () => {
  it('the fetcher is called in one place only: the restore that remembers a failure', () => {
    expect(callsOf(/\bawait remoteFetcher\(/g)).toEqual(['src/providers/transcript-archive.ts'])
    const archive = files.find((f) => f.rel === 'src/providers/transcript-archive.ts')!.text
    const at = archive.indexOf('await remoteFetcher(')
    const before = archive.slice(Math.max(0, at - 600), at)
    expect(before).toMatch(/recentRemoteFailure\(/)
  })

  it('every start of a CLI in the daemon restores through restoreForStart', () => {
    const text = files.find((f) => f.rel === 'src/providers/daemon-standalone.ts')!.text
    expect(text).toMatch(/await restoreForStart\(CLAUDE_PROJECTS_DIRS, archivedSource\)/)
  })

  it('restoreSessionAnywhere, which swallows a failed restore, is called only where no CLI starts', () => {
    const allowed: Record<string, string> = {
      // transcript.restore answers a path or none; it starts nothing.
      'src/providers/daemon-standalone.ts': 'cmdTranscriptRestore',
    }
    const callers = [...new Set(callsOf(/\brestoreSessionAnywhere\(/g))].filter((rel) => rel !== 'src/providers/transcript-archive.ts').sort()
    expect(callers).toEqual(Object.keys(allowed).sort())
    expect(callsOf(/\brestoreSessionAnywhere\(CLAUDE_PROJECTS_DIRS/g).filter((r) => r === 'src/providers/daemon-standalone.ts')).toHaveLength(1)
  })
})
