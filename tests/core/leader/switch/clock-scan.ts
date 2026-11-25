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

/** The `open ... close` span that starts at the first `open` at or after `at` (balanced), with its start. */
export function spanFrom(code: string, at: number, open = '(', close = ')'): { from: number; text: string } {
  let i = code.indexOf(open, at)
  const from = i
  if (i < 0) return { from: -1, text: '' }
  for (let depth = 0; i < code.length; i++) {
    if (code[i] === open) depth++
    else if (code[i] === close && --depth === 0) break
  }
  return { from, text: code.slice(from, i + 1) }
}

/**
 * Where a `setTimeout(` arms its own function again: a call of a function (or method, or arrow kept in a name)
 * inside whose body it stands, named in the timer's own call (`setTimeout(tick, ms)`, `setTimeout(() => this.look(id), ms)`).
 * A self re-arming timer is a clock in all but name.
 */
export function rearmingIn(code: string): number[] {
  const out: number[] = []
  const defs: Array<{ name: string; from: number; to: number }> = []
  const defRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>|^\s*(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=]*)?\{)/gm
  for (const m of code.matchAll(defRe)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (!name || /^(if|for|while|switch|catch|function|return)$/.test(name)) continue
    const brace = code.indexOf('{', m.index! + m[0].length - 1)
    if (brace < 0) continue
    const body = spanFrom(code, brace, '{', '}')
    defs.push({ name, from: body.from, to: body.from + body.text.length })
  }
  for (const m of code.matchAll(/(?<![\w.])setTimeout\(/g)) {
    const at = m.index!
    const call = spanFrom(code, at).text
    const inside = defs.filter((d) => d.from < at && at < d.to)
    if (inside.some((d) => new RegExp(`(?<![\\w$])${d.name.replace(/\$/g, '\\$')}\\b`).test(call))) out.push(at)
  }
  return out
}

/** Every file under `root`/src with a self re-arming setTimeout: its relative path and how many. */
export function rearmingFiles(root: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of sourcesUnder(path.join(root, 'src'))) {
    const n = rearmingIn(codeOf(fs.readFileSync(file, 'utf8'))).length
    if (n) out[path.relative(root, file)] = n
  }
  return out
}
