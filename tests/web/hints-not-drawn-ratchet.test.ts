/**
 * No chat draws a message hint (2026-11-01, the user, of the line under his message
 * that said what Walnut added: "just remove this, no idea why we need this"). The
 * hints are for the model; the session's Raw input & output shows them. A history
 * row still carries `hints` (question numbers and the raw view read the kinds), so
 * this fails when a web component or page reads a message's `hints`, which is how
 * the line came in (SessionMessage drew MessageHintsRow from `message.hints`).
 * The server half (no `added` hint items, no hint words in any read) is
 * tests/web/routes/hints-never-raw.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../web/src')
const DIRS = ['components', 'pages']

/** Reads of a message's hints that are not drawing it, with why. */
const ALLOWED: Record<string, string> = {
  // The /api/v1/hints registry rows of Settings, not a message's.
  'components/settings/sections/MessageHintsGroup.tsx': 'the registry list in Settings',
}

/** The code of a file, its comments taken out (a comment may name `.hints`). */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** `x.hints`, `x?.hints`, `x['hints']`, `{ hints } = x`: a read of a row's hints. */
const READS_HINTS = /\??\.hints\b|\[['"]hints['"]\]|\{[^}]*\bhints\b[^}]*\}\s*=/

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

describe('no chat draws a message hint', () => {
  it('no web component or page reads a row\'s hints', () => {
    const readers = DIRS.flatMap((d) => files(path.join(ROOT, d)))
      .filter((f) => READS_HINTS.test(code(f)))
      .map((f) => path.relative(ROOT, f))
    expect(readers.filter((f) => !ALLOWED[f])).toEqual([])
    // An allowance whose file no longer reads hints is stale.
    expect(Object.keys(ALLOWED).filter((f) => !readers.includes(f))).toEqual([])
  })

  it('the component that drew them is gone', () => {
    expect(fs.existsSync(path.join(ROOT, 'components/sessions/MessageHintsRow.tsx'))).toBe(false)
  })
})
