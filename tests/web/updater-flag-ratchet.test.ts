/**
 * No web code reads, right after a React state setter, a flag its updater sets. React runs a
 * `setX((prev) => …)` updater when it renders, not when it is queued, so the flag still reads
 * false there. useSessionStream adopted a stream snapshot that way and never seeded its text
 * accumulator: a column opened mid-reply lost the reply's head when the next delta came
 * (2026-11-10). Do the work inside the updater (once: StrictMode calls it twice), or decide
 * from a value that does not wait for the render.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : []
  })
}

/** The body of the block whose `{` is at `open`, and the index after its `}`. */
function block(text: string, open: number): { body: string; end: number } {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return { body: text.slice(open + 1, i), end: i + 1 }
  }
  return { body: text.slice(open + 1), end: text.length }
}

/** A `let` flag assigned inside a later `setX((prev) => …)` updater and read after that updater. */
function updaterFlagReads(text: string): string[] {
  const found: string[] = []
  for (const decl of text.matchAll(/\blet (\w+)(?:\s*:[^=;\n]+)?(?:\s*=\s*(?:false|null|undefined)\b)?\s*;?\s*$/gm)) {
    const name = decl[1]
    const from = decl.index! + decl[0].length
    const updater = /\bset[A-Z]\w*\(\s*\(?\s*\w+(?:\s*:[^)=]+)?\s*\)?\s*=>\s*\{/g
    updater.lastIndex = from
    for (let m = updater.exec(text); m && m.index - from < 3000; m = updater.exec(text)) {
      const { body, end } = block(text, m.index + m[0].length - 1)
      updater.lastIndex = end
      if (new RegExp(`\\blet ${name}\\b`).test(body)) continue
      if (!new RegExp(`(^|[^.\\w])${name}\\s*=(?![=>])`).test(body)) continue
      if (/flushSync\(\s*\(\)\s*=>\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index))) continue
      if (new RegExp(`\\b${name}\\b`).test(text.slice(end, end + 1500))) {
        found.push(`${name} (line ${text.slice(0, decl.index).split('\n').length})`)
        break
      }
    }
  }
  return found
}

describe('a state updater\'s flag is never read right after the setter', () => {
  it('finds the shape it guards', () => {
    expect(updaterFlagReads(`let applied = false;\n  setBlocks((prev) => {\n    applied = true;\n    return prev;\n  });\n  if (applied) seed();`))
      .toEqual(['applied (line 1)'])
    expect(updaterFlagReads(`let adopted: boolean = false\n  setRows((prev: Row[]) => {\n    adopted = true\n    return prev\n  })\n  if (adopted) seed()`))
      .toEqual(['adopted (line 1)'])
    expect(updaterFlagReads(`setOpen((prev) => {\n  let touched = false;\n  touched = true;\n  return prev;\n});`)).toEqual([])
    expect(updaterFlagReads(`let seen = false;\n  setA((prev) => prev);\n  setRows((prev) => {\n    seen = true;\n    return prev;\n  });\n  log(seen);`))
      .toEqual(['seen (line 1)'])
  })

  it('no file in web/src has it', () => {
    const offenders = files(path.join(root, 'web/src')).flatMap((file) =>
      updaterFlagReads(fs.readFileSync(file, 'utf8')).map((hit) => `${path.relative(root, file)}: ${hit}`))
    expect(offenders, 'a flag set inside a setX((prev) => ...) updater reads false right after the setter').toEqual([])
  })
})
