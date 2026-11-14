/**
 * The repo files a script imports by a relative path (or sources, for `. scripts/x.sh`),
 * followed through the files they import. A test that copies scripts into a sandbox, and a
 * workflow job with a sparse checkout, carry these too, or the script dies at its first
 * import (2026-11-13: ci-gate.mjs began importing scripts/lib/gh-transient.mjs, and the
 * release script tests copied only ci-gate.mjs).
 */
import fs from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

export function localImports(rel: string, seen = new Set<string>()): Set<string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*\.\s+(scripts\/\S+\.sh)/gm)) {
    const spec = m[1] ?? m[2]
    const dep = spec ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : m[3]!
    if (seen.has(dep) || !fs.existsSync(path.join(REPO_ROOT, dep))) continue
    seen.add(dep)
    localImports(dep, seen)
  }
  return seen
}

/** `files` (paths under scripts/) and every file under scripts/ they import, as paths under scripts/. */
export function withLocalImports(files: readonly string[]): string[] {
  const out = new Set(files)
  for (const f of files) {
    for (const dep of localImports(`scripts/${f}`)) if (dep.startsWith('scripts/')) out.add(dep.slice('scripts/'.length))
  }
  return [...out]
}
