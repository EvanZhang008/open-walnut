/**
 * Walnut's own code never names a note by the old vault's absolute path (~/.open-walnut/notes/...):
 * it asks notesRoot() / resolveNotePath (src/core/notes/note-paths.ts), which follow the one tree.
 * 2026-11-20: the first live move of the notes broke a trigger script that read
 * ~/.open-walnut/notes/walnut/reviews. Scripts and prompts outside the repo keep working through
 * the old places' links (src/core/artifacts/unify/old-places.ts); inside the repo, a new
 * hard-coded path fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const OLD_VAULT = /\.open-walnut\/notes\b|['"]\.open-walnut['"]\s*,\s*['"]notes['"]/

/** Files that may say it, each with why. */
const ALLOWED: Record<string, string> = {
  'src/web/routes/notes-v2.ts': 'a header comment on where the vault lived',
  'src/web/routes/file-content-replica-copy.ts': 'a comment quoting a path a replica receives',
  'src/core/notes-migration.ts': 'a comment on a one-time migration of that era',
  'src/core/artifacts/unify/old-places.ts': 'the header names the incident that made the links',
  'src/core/agent-registry.ts': 'the notes agent globs a folder by absolute path; the old place links into the tree',
}

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* files(p) }
    else if (/\.(ts|tsx|md|json|sh|py|mjs)$/.test(e.name)) yield p
  }
}

describe('no hard-coded old vault path in Walnut', () => {
  it('names the notes through the vault root, never ~/.open-walnut/notes', () => {
    const hits: string[] = []
    for (const dir of ['src', 'web/src', 'scripts']) {
      for (const f of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/')
        if (ALLOWED[rel]) continue
        fs.readFileSync(f, 'utf-8').split('\n').forEach((line, i) => { if (OLD_VAULT.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`) })
      }
    }
    expect(hits, 'ask notesRoot()/resolveNotePath instead (src/core/notes/note-paths.ts)').toEqual([])
  })

  it('keeps the allowlist honest: every allowed file still says it', () => {
    for (const rel of Object.keys(ALLOWED)) expect(OLD_VAULT.test(fs.readFileSync(path.join(ROOT, rel), 'utf-8')), rel).toBe(true)
  })
})
