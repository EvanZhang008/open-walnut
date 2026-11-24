/**
 * A changes checkpoint (changes-checkpoint.ts) holds a parse state, so it is
 * fenced by what produced that state: CHANGES_PARSER_VERSION. A build id would
 * throw every checkpoint away at every deploy, and the first compute after it
 * would reparse whole transcripts (2026-11-23: 2 GB read right after one Mac
 * deploy). This pins the source of everything that shapes a parse state: a
 * change to it must bump the version, or old checkpoints would resume with
 * the old meaning. Its comments count too: a needless bump only costs one
 * reparse per session.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CHANGES_PARSER_VERSION } from '../../src/providers/session-changes-core.js'

const root = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`)
  return text.slice(a, b)
}

function parserSource(): string {
  const core = read('src/providers/session-changes-core.ts')
  return [
    between(core, '// ── Public result types', 'export function mergeFileMapInto('),
    between(core, 'async function streamParseHostLocal(', '// ── Post-parse phase'),
    // What the saved subCache holds (subagent transcripts), saved with the checkpoint.
    between(core, '// 2. Subagent JSONLs', 'if (opts.checkpointDir && (!resumed'),
    read('src/core/bash-file-ops.ts'),
  ].join('\n\u0000\n')
}

// Update both together: bump the version, then put the new hash here.
const PINNED = { version: 'changes-parser-2', sha256: 'bb68626942786c5e35f2b35863a0bae9b5ac9c0628223b825280a69444216949' }

describe('changes parser version', () => {
  it('changes with the parser source', () => {
    const sha256 = createHash('sha256').update(parserSource()).digest('hex')
    expect({ version: CHANGES_PARSER_VERSION, sha256 },
      'The changes parser changed. Bump CHANGES_PARSER_VERSION in src/providers/session-changes-core.ts, then set PINNED in this test to the new version and hash.',
    ).toEqual(PINNED)
  })

  it('a person opening a session\'s own edits marks it viewed, a git comparison does not', () => {
    // Without this call the prewarmer silently warms nothing (session-changes-prewarm.ts).
    const src = read('src/core/sessions/session-lifecycle.ts')
    const fn = between(src, 'export async function getSessionChanges(', '\n}\n')
    expect(fn).toMatch(/if \(!GIT_BASES\.has\(base\)\) \{[\s\S]{0,300}?noteSessionChangesViewed\(sessionId, record\.host\)/)
  })

  it('is what the session daemon fences checkpoints with (never its build version)', () => {
    const src = read('src/providers/daemon-standalone.ts')
    expect(src).toContain("'changes-checkpoints'")
    expect(src).not.toMatch(/checkpointVersion\s*:/)
  })
})
