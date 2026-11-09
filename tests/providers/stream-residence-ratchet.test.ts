/**
 * Stream retention (src/core/stream-retention.ts) drops a finished session's
 * stream file after two days and journals its sid first. So "its stream file
 * exists" is no longer proof that a session lived on this host: the spawn
 * journal is (livedHere in both daemon twins). Before 2026-11-09, bridge
 * resume, the host's trigger resume and the host-start `ran` check each tested
 * the file, and would have refused a session whose stream retention had taken.
 *
 * This ratchet lists every test of a stream file's existence in each twin. A
 * new one fails here: use livedHere for "did this session run here", or add it
 * below with why it needs the file itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SITE = /existsSync\((?:path\.join\(STREAMS_DIR, [A-Za-z.]+ \+ '\.jsonl'\)|jsonlPath)\)/

/** Functions allowed to test the file itself, per twin. */
const ALLOWED: Record<string, Record<string, string>> = {
  'src/providers/daemon-standalone.ts': {
    livedHere: 'the residence check itself: the file, then the spawn journal',
    cmdAttach: 'attach folds the file, so it needs the file',
  },
  'src/providers/daemon-source.ts': {
    livedHere: 'the residence check itself: the file, then the spawn journal',
    cmdAttach: 'attach folds the file, so it needs the file',
  },
}

function enclosingFunction(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const m = lines[i].match(/^(?:async )?function (\w+)/)
    if (m) return m[1]
  }
  return '(top level)'
}

describe('stream residence ratchet', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file}: only livedHere and attach test a stream file's existence`, () => {
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
      const sites = lines.flatMap((l, i) => (SITE.test(l) ? [{ line: i + 1, fn: enclosingFunction(lines, i) }] : []))
      const strays = sites.filter((s) => !(s.fn in allowed))
      expect(strays, `use livedHere(sid) instead: ${JSON.stringify(strays)}`).toEqual([])
      expect(new Set(sites.map((s) => s.fn))).toEqual(new Set(Object.keys(allowed)))
    })
  }
})
