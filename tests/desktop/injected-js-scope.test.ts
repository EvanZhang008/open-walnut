/**
 * Every script a Swift file runs in a web page keeps its names to itself (2026-11-12: the nightly
 * Mac app window test failed with "SyntaxError: Can't create duplicate variable: 't'", because two
 * evaluateJavaScript calls on the same page each declared `const t` at the top level, and a page
 * keeps a classic script's top-level let, const and class names for its whole life). A top-level
 * `var` or function is allowed again, `const`, `let` and `class` are not, so a script that needs
 * its own names wraps them in a function: `(() => { const t = ...; return true })()`.
 *
 * Enumerated from the source: every string literal in every tracked Swift file (the Mac app, its
 * native tests, the iOS app) that reads as page script is checked.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const swiftFiles = execFileSync('git', ['ls-files', '*.swift'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)

/** Swift string literals of a file: single-line "..." and multi-line """...""" (interpolations kept as text). */
function swiftStrings(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  let i = 0
  const lineAt = (at: number) => code.slice(0, at).split('\n').length
  while (i < code.length) {
    if (code.startsWith('//', i)) { const nl = code.indexOf('\n', i); i = nl < 0 ? code.length : nl; continue }
    if (code.startsWith('"""', i)) {
      const end = code.indexOf('"""', i + 3)
      if (end < 0) break
      out.push({ line: lineAt(i), text: code.slice(i + 3, end) })
      i = end + 3
      continue
    }
    if (code[i] === '"') {
      let j = i + 1
      let depth = 0
      while (j < code.length && code[j] !== '\n') {
        if (code[j] === '\\' && code[j + 1] === '(') { depth++; j += 2; continue }
        if (depth > 0 && code[j] === ')') { depth--; j++; continue }
        if (code[j] === '\\') { j += 2; continue }
        if (depth === 0 && code[j] === '"') break
        j++
      }
      out.push({ line: lineAt(i), text: code.slice(i + 1, j) })
      i = j + 1
      continue
    }
    i++
  }
  return out
}

const PAGE_SCRIPT = /\b(document|window)\.|\bquerySelector\b/

/** The let/const/class names a script declares at its top level (outside every bracket). */
function topLevelDeclarations(js: string): string[] {
  const found: string[] = []
  let depth = 0
  let quote: string | null = null
  let atStatement = true
  for (let i = 0; i < js.length; i++) {
    const c = js[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; atStatement = false; continue }
    if (c === '(' || c === '{' || c === '[') { depth++; atStatement = c === '{'; continue }
    if (c === ')' || c === '}' || c === ']') { depth--; atStatement = c === '}' && depth === 0; continue }
    if (c === ';' || c === '\n') { atStatement = true; continue }
    if (/\s/.test(c)) continue
    if (atStatement && depth === 0) {
      const m = /^(const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(js.slice(i))
      if (m) found.push(`${m[1]} ${m[2]}`)
    }
    atStatement = false
  }
  return found
}

describe('injected page scripts keep their names to themselves', () => {
  it('the scanner reads a top-level declaration and ignores a wrapped one', () => {
    expect(topLevelDeclarations("const t=document.createElement('x');true")).toEqual(['const t'])
    expect(topLevelDeclarations("(() => { const t=document.body; return true })()")).toEqual([])
    expect(topLevelDeclarations("let a = 1; if (a) { let b = 2 }")).toEqual(['let a'])
    expect(topLevelDeclarations("'const x'; window.y = 1")).toEqual([])
    expect(swiftStrings('let s = "a\\(f("q"))b"\nlet m = """\nconst t = 1\n"""').map((s) => s.text))
      .toEqual(['a\\(f("q"))b', '\nconst t = 1\n'])
  })

  it('no Swift file runs a page script with a top-level let, const or class', () => {
    const bad: string[] = []
    let scripts = 0
    for (const f of swiftFiles) {
      for (const s of swiftStrings(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
        if (!PAGE_SCRIPT.test(s.text)) continue
        scripts++
        for (const d of topLevelDeclarations(s.text)) bad.push(`${f}:${s.line}  ${d}`)
      }
    }
    expect(scripts, 'the scan found no page scripts at all: the Swift string reader broke').toBeGreaterThan(20)
    expect(bad, 'wrap the script in a function, (() => { const t = ...; return true })(), so a second run on the same page does not throw "duplicate variable"').toEqual([])
  })
})
