/**
 * Ratchet: nothing outside the memory stores themselves names the project memory tree
 * (`memory/projects/`).
 *
 * 2026-10-31, the Memory page: the tree held an empty folder for every project a session
 * ever started in with no folder of its own ("imported from devbox", "routines", three
 * "zz test heron <time>" folders from a test run's Org leads), because four start paths
 * used `memory/projects/<project>/` as the fallback working directory and made it. The
 * fallback is now the task's own directory (task-dir-place.ts `localFallbackFolder`).
 *
 * A NEW file that reaches for PROJECTS_MEMORY_DIR fails here: a session's folder, a
 * scratch dir or a test run's output does not belong in the user's memory tree. Add a
 * file to the list only when it reads or keeps the memory store itself, with why.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

const ALLOWED: Record<string, string> = {
  'src/constants.ts': 'defines the path',
  'src/core/project-memory.ts': 'the legacy project memory store itself (reads)',
  'src/core/memory.ts': 'lists the memory tree for the Memory page and search (reads)',
  'src/core/memory-dir-migration.ts': 'the one-time flatten of that store',
  'src/core/init.ts': 'a comment saying the tree is never recreated at boot',
  'src/core/sessions/task-dir-place.ts': 'recognises an old session that ran there, so no task inherits it and the launcher never suggests it',
  'src/core/frequent-dirs.ts': 'drops old memory folders from the launcher suggestions',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|cjs)$/.test(entry.name)) out.push(p)
  }
  return out
}

describe('memory tree writers ratchet', () => {
  it('only the memory stores name memory/projects', () => {
    // Code only: comments that mention the path are history, not a writer.
    const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const users = walk(path.join(ROOT, 'src'))
      .filter((f) => /\bPROJECTS_(MEMORY_)?DIR\b|['"`]memory['"`],\s*['"`]projects['"`]|memory\/projects/.test(code(f)))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((f) => !(f in ALLOWED))
    expect(users, 'a new file reaches for the project memory tree; see this file').toEqual([])
  })

  it('no session start path falls back to the memory tree', () => {
    for (const f of [
      'src/core/sessions/task-launch-plan.ts',
      'src/core/sessions/task-start.ts',
      'src/core/sessions/quick-start.ts',
      'src/core/org/org-store.ts',
      'src/providers/claude-code-session.ts',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(src, f).not.toMatch(/PROJECTS_MEMORY_DIR|taskMemoryFolder/)
    }
  })
})
