/**
 * Ratchet: a session record is rebuilt from a transcript only where this Walnut holds evidence it
 * owned the session (src/core/sessions/session-record-recovery.ts), never on a read.
 *
 * 2026-11-16: GET /api/sessions/:id rebuilt a missing row from any transcript on disk. One agent's
 * script looked up 2998 transcript ids through it and minted 129 records: 111 for Walnut's own
 * helper calls (entrypoint walnut-utility) and 18 for sessions other Walnut servers (ephemeral and
 * smoke-test servers) and ad-hoc `claude -p` probes wrote into the same ~/.claude/projects. Two
 * log alarms fired: "session record self-healed from canonical JSONL" and the route's 404s.
 *
 * Every file that names recoverSessionRecordFromJsonl (an import or a call, an alias included) is
 * listed below with the evidence it holds and how many times it names it. A new caller fails here
 * until it is listed with its evidence; a lookup route never is one.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const DEFINITION = 'src/core/sessions/session-record-recovery.ts'
const NAME = /\brecoverSessionRecordFromJsonl\b/g

/** Each file that names the function, the number of mentions in its code, and its evidence. */
const CALLERS: Record<string, { mentions: number; evidence: string }> = {
  'src/providers/claude-code-session.ts': {
    mentions: 3,
    evidence: 'processNext delivers a message this Walnut\'s own queue holds for the session',
  },
}

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The file without its comment lines (a doc line naming the function is no call). */
function code(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
}

describe('session record recovery: who may rebuild a record', () => {
  const found: Record<string, number> = {}
  for (const dir of ['src', 'web/src', 'scripts']) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      if (rel === DEFINITION) continue
      const n = code(fs.readFileSync(file, 'utf8')).match(NAME)?.length ?? 0
      if (n) found[rel] = n
    }
  }

  it('is named only by the listed callers, each with its count', () => {
    expect(found, 'a new caller of recoverSessionRecordFromJsonl must hold evidence this Walnut owned the session; list it in CALLERS').toEqual(
      Object.fromEntries(Object.entries(CALLERS).map(([f, c]) => [f, c.mentions])),
    )
  })

  it('is never named by a web route or the web client (a read never writes a record)', () => {
    expect(Object.keys(found).filter((f) => f.startsWith('src/web/') || f.startsWith('web/'))).toEqual([])
  })
})
