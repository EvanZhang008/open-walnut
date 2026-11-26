/**
 * Every error class declared under src/, and whether it says what it is: a refusal carries a
 * `status` and a `code` (src/lib/coded-refusal.ts), its own or its base class's.
 * Read from the source, so a new class is found the day it is written
 * (tests/core/coded-refusal-classes.test.ts).
 */
import fs from 'node:fs'
import path from 'node:path'

export interface ErrorClass { file: string; name: string; base: string; coded: boolean }

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

export function scanErrorClasses(root: string): ErrorClass[] {
  const found: Array<ErrorClass & { own: boolean }> = []
  for (const file of sourceFiles(path.join(root, 'src')).sort()) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/^([ \t]*)(?:export )?(?:abstract )?class (\w+) extends (\w*Error)\b[^{\n]*\{/gm)) {
      const line = src.slice(m.index!, src.indexOf('\n', m.index!) === -1 ? undefined : src.indexOf('\n', m.index!))
      const close = src.indexOf(`\n${m[1]}}`, m.index!)
      const body = line.trimEnd().endsWith('}') ? line : src.slice(m.index!, close === -1 ? m.index! + 1500 : close)
      const own = /\bstatus\b/.test(body) && /\bcode\b/.test(body)
      found.push({ file: path.relative(root, file).split(path.sep).join('/'), name: m[2], base: m[3], coded: own, own })
    }
  }
  // A class is coded through its base too (the first class of that name: bases are named once).
  const byName = new Map<string, ErrorClass>()
  for (const c of found) if (!byName.has(c.name)) byName.set(c.name, c)
  const coded = (c: ErrorClass, seen = new Set<string>()): boolean => {
    if (c.coded) return true
    const base = byName.get(c.base)
    if (!base || seen.has(c.name)) return false
    seen.add(c.name)
    return coded(base, seen)
  }
  return found.map(({ own: _own, ...c }) => ({ ...c, coded: coded(c) }))
}

/** The name of every class that carries no status and code, sorted (a name declared twice is listed twice). */
export function uncodedErrorClasses(root: string): string[] {
  return scanErrorClasses(root).filter((c) => !c.coded).map((c) => c.name).sort()
}
