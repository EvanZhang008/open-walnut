/**
 * A folder listing the user's typing or a closed picker left behind is cancelled, never only
 * ignored. The page sends one read of a URL at a time (web/src/api/same-read-turn.ts,
 * 2026-11-22), so an abandoned list-dirs read held the same search, typed again, in its queue
 * for up to 20 s: the @? folder search reopened on a stuck host showed nothing, not its error.
 *
 * The members are read from source, so a new caller fails here until it is decided:
 *  - only web/src/api/sessions.ts builds a list-dirs URL (listDirs), so every listing has one
 *    shape and one way to cancel;
 *  - every listDirs / listDirsCached call outside it passes a `signal`, unless FIRE_AND_FORGET
 *    says why nobody ever leaves it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')
const OWNER = 'api/sessions.ts'

/** Calls with no caller that can leave them, and why (file -> reason). */
const FIRE_AND_FORGET: Record<string, string> = {}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = sources(WEB_SRC).map((full) => ({ rel: path.relative(WEB_SRC, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') }))

/** Each `listDirs(` / `listDirsCached(` call's argument text, up to its closing parenthesis. */
function calls(text: string): string[] {
  const found: string[] = []
  const re = /\blistDirs(?:Cached)?\(/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue
    let depth = 1
    let i = m.index + m[0].length
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
    }
    found.push(text.slice(m.index, i))
  }
  return found
}

describe('list-dirs reads the caller leaves are cancelled', () => {
  it('only the API module builds a list-dirs URL', () => {
    const builders = files.filter((f) => f.rel !== OWNER && /\/api\/sessions\/list-dirs\?/.test(f.text)).map((f) => f.rel)
    expect(builders).toEqual([])
  })

  it('every listDirs call outside the API module passes a signal', () => {
    const members = files.filter((f) => f.rel !== OWNER).flatMap((f) => calls(f.text).map((call) => ({ file: f.rel, call })))
    // The callers known today: the composer's @? folder search, the folder picker, and the new
    // task draft's check that its folder is still there (it aborts on every change).
    expect(new Set(members.map((m) => m.file))).toEqual(new Set([
      'components/chat/FileMentionPopup.tsx',
      'components/sessions/path-selector/useLiveDirs.ts',
      'components/sessions/useFolderGone.ts',
    ]))
    const unsignalled = members.filter((m) => !/\bsignal\b/.test(m.call) && !FIRE_AND_FORGET[m.file])
    expect(unsignalled).toEqual([])
  })
})
