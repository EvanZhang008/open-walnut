/**
 * The session daemon runtime's value-import graph (daemon-standalone.ts and every module it loads at
 * run time; type-only imports left out). Shared by the ratchets that hold what the runtime may
 * contain: tests/providers/daemon-runtime-child-process-ratchet.test.ts (who starts children) and
 * tests/providers/daemon-task-logic-ratchet.test.ts (which task logic is still in it).
 */
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(__dirname, '../..')
export const STANDALONE = 'src/providers/daemon-standalone.ts'
export const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Comments out (a `//` or `/*` only where a comment can start: line start or after a space). */
export function stripComments(text: string): string {
  return text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Whether `index` on its line sits inside a quoted string (an odd count of a quote before it). */
export function insideString(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const before = text.slice(lineStart, index).replace(/\\./g, '')
  return ['"', "'", '`'].some((q) => before.split(q).length % 2 === 0)
}

/** The relative specifiers a module loads at run time (type-only imports left out). */
export function valueImports(text: string, file: string): string[] {
  const out: string[] = []
  // The clause holds no quote or `;`, so a match never runs on into the next statement.
  const stat = /^\s*(import|export)\s+(type\s+)?([^'"`;]*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (let m; (m = stat.exec(text));) {
    if (m[2]) continue
    const braces = /^\{([\s\S]*)\}$/.exec(m[3]!.trim())
    const names = braces ? braces[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null
    if (names && names.length > 0 && names.every((n) => n.startsWith('type '))) continue
    out.push(m[4]!)
  }
  for (let m, side = /^\s*import\s+['"]([^'"]+)['"]/gm; (m = side.exec(text));) out.push(m[1]!)
  // import('x') as a value: `import('x').Name` is a type position, `.then` is not.
  for (let m, dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)(\.(\w+))?/g; (m = dyn.exec(text));) {
    if (m[3] && m[3] !== 'then') continue
    // daemon-standalone.ts's own entry (after the runtime) loads the walnut CLI: that program, not the runtime.
    if (file === STANDALONE && m.index > text.indexOf('// ── The daemon as a program of its own')) continue
    out.push(m[1]!)
  }
  for (let m, req = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g; (m = req.exec(text));) if (!insideString(text, m.index)) out.push(m[1]!)
  return out
}

export function resolveImport(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(ROOT, from)), spec)
  for (const c of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(ROOT, c)
  }
  return null
}

/** The runtime's import graph: its files, each file's resolved value imports, and what did not resolve; `visit` sees each file's text once. */
export function walkDaemonImports(visit?: (file: string, text: string) => void): { files: Set<string>; imports: Map<string, string[]>; unresolved: string[] } {
  const files = new Set<string>()
  const imports = new Map<string, string[]>()
  const unresolved: string[] = []
  const queue = [STANDALONE]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.has(file)) continue
    files.add(file)
    const text = read(file)
    visit?.(file, text)
    const out: string[] = []
    imports.set(file, out)
    for (const spec of valueImports(stripComments(text), file)) {
      if (!spec.startsWith('.')) continue
      const next = resolveImport(file, spec)
      if (next) { out.push(next); queue.push(next) }
      else unresolved.push(`${file} -> ${spec}`)
    }
  }
  return { files, imports, unresolved }
}

