/**
 * The leader's clocks, read from the source (switch-stop-writers-ratchet.test.ts): every periodic timer of a file
 * under src/, wherever it is started: a `setInterval(` or a `runPeriodic(`. A `setTimeout(` that arms itself again
 * cannot be told from a one-shot by its text: the ratchet lists those it knows by name (REARMING).
 */
import fs from 'node:fs'
import path from 'node:path'

/** A file's code without its comments and string contents (a comment naming a call is not a call). */
export function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
}

/** Where each timer starts in `code`: its offset and kind. */
export function clocksIn(code: string): Array<{ at: number; kind: 'interval' | 'periodic' }> {
  const out: Array<{ at: number; kind: 'interval' | 'periodic' }> = []
  for (const m of code.matchAll(/(?<![\w.])setInterval\(/g)) out.push({ at: m.index!, kind: 'interval' })
  for (const m of code.matchAll(/(?<![\w.])runPeriodic\(/g)) {
    // The definition and its imports are not a start.
    const before = code.slice(Math.max(0, m.index! - 20), m.index!)
    if (/function\s+$/.test(before)) continue
    out.push({ at: m.index!, kind: 'periodic' })
  }
  return out.sort((a, b) => a.at - b.at)
}

export function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourcesUnder(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Every file under `root`/src with at least one clock: its relative path and how many. */
export function clockFiles(root: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of sourcesUnder(path.join(root, 'src'))) {
    const n = clocksIn(codeOf(fs.readFileSync(file, 'utf8'))).length
    if (n) out[path.relative(root, file)] = n
  }
  return out
}
