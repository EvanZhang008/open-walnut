/**
 * The one rule of what a replica's notes copy leaves out (core/replication/keep-rule.ts):
 * a folder, or one note with or without `.md`, any letter case. The daemon's twin
 * (providers/host-replica-core.ts, inlined into both daemons) must answer the same for
 * every entry and path, so a note the Mac leaves out is refused the same way everywhere.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanKeepEntries, cleanKeepEntry, leftOut, pictureMayBeLeftOut } from '../../../src/core/replication/keep-rule.js'
import { createHostReplica } from '../../../src/providers/host-replica-core.js'

const daemon = createHostReplica({
  fs, path, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'keep-rule-')), now: () => 1,
  keyOf: (v) => v.replace(/[^a-z0-9]/gi, '_'), hash: (s) => s.slice(0, 12), log: () => {},
})

const ENTRIES = ['health', 'Finance/Taxes', 'journal/2026-10-01.md', ' /work/plans/ ', './drafts', 'a\\b', '', 'Notes.md']
const PATHS = [
  'health/Checkup.md', 'HEALTH/x/y.md', 'healthy/a.md', 'health.md', 'health',
  'Finance/Taxes.md', 'finance/taxes.md', 'Finance/Taxes/2025.md', 'Finance/Taxes 2025.md',
  'journal/2026-10-01.md', 'journal/2026-10-01.md.md', 'journal/2026-10-02.md',
  'work/plans/q1.md', 'work/plansx.md', 'drafts/a.md', 'a/b/c.md', 'a/bc.md', 'Notes.md', 'notes.md', 'Notes.md.md',
  'pictures/health/xray.png', 'health/xray.png',
]

describe('keep rule', () => {
  it('a folder and everything under it, one note with or without .md, any case', () => {
    expect(leftOut('health/Checkup.md', ['health'])).toBe(true)
    expect(leftOut('Health/sub/a.md', ['health'])).toBe(true)
    expect(leftOut('healthy/a.md', ['health'])).toBe(false)
    expect(leftOut('health.md', ['health'])).toBe(true)
    expect(leftOut('Finance/Taxes.md', ['finance/taxes'])).toBe(true)
    expect(leftOut('Finance/Taxes 2025.md', ['finance/taxes'])).toBe(false)
    expect(leftOut('journal/2026-10-01.md', ['journal/2026-10-01.md'])).toBe(true)
    expect(leftOut('journal/2026-10-01.md.md', ['journal/2026-10-01.md'])).toBe(false)
    expect(leftOut('anything.md', [])).toBe(false)
  })

  it('entries are cleaned as typed: slashes forward, no ./ or slashes at the ends, empty ones dropped', () => {
    expect(cleanKeepEntry(' /work/plans/ ')).toBe('work/plans')
    expect(cleanKeepEntry('./drafts')).toBe('drafts')
    expect(cleanKeepEntry('a\\b')).toBe('a/b')
    expect(cleanKeepEntries(['', ' ', 'x', 3])).toEqual(['x', '3'])
    expect(cleanKeepEntries('health')).toEqual([])
  })

  it('the daemon twin answers the same for every entry and path', () => {
    for (const p of PATHS) {
      for (const e of ENTRIES) expect(daemon.leftOut(p, [e]), `${p} / ${JSON.stringify(e)}`).toBe(leftOut(p, [e]))
      expect(daemon.leftOut(p, ENTRIES), p).toBe(leftOut(p, ENTRIES))
    }
  })
})

describe('a picture the copy does not have', () => {
  it('may be left out only where the entries reach: by its path, from the note\'s folder, or anywhere for a bare name', () => {
    const left = ['health', 'work/review.md']
    // Nothing left out: always a plain miss.
    expect(pictureMayBeLeftOut('scan.png', 'notes/a.md', [])).toBe(false)
    // A path into a left-out folder, as written or from the note's folder.
    expect(pictureMayBeLeftOut('health/_attachment/xray.png', 'daily/2026-10-22.md', left)).toBe(true)
    expect(pictureMayBeLeftOut('_attachment/xray.png|300', 'Health/Checkup.md', left)).toBe(true)
    expect(pictureMayBeLeftOut('../health/xray.png', 'daily/today.md', left)).toBe(true)
    // A path elsewhere: a broken link, 404.
    expect(pictureMayBeLeftOut('_attachment/plan.png', 'work/plan.md', left)).toBe(false)
    expect(pictureMayBeLeftOut('../work/x.png', 'daily/today.md', left)).toBe(false)
    // A bare name resolves anywhere in the vault: it may be in a left-out folder.
    expect(pictureMayBeLeftOut('xray.png', 'daily/today.md', left)).toBe(true)
  })
})
