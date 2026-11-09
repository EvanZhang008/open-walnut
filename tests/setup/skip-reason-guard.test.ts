/**
 * No test is skipped for good without saying why and since when.
 *
 * A bare `it.skip(...)` runs nowhere and reads green: 2026-11-09's grooming found
 * one from 2026-08-10 for a page feature that no longer existed, one "BUG" skip
 * from 2026-09-24 that asserted the opposite of the behaviour its sibling pins,
 * and seven `skipIf(ON_BUN)` tests that could not run since Walnut refused Node.
 *
 * The rule, for every tracked test file (vitest and Playwright): an unconditional
 * `skip`, `todo` or `fixme` (and `xit` / `xdescribe` / `xtest`) carries, on its own
 * line or the line just above it, `// skip: YYYY-MM-DD <reason of 10+ chars>`.
 * A skip with a condition passes as it is: `skipIf(...)` / `runIf(...)`,
 * Playwright's `test.skip(condition, 'reason')`, `cond ? describe : describe.skip`,
 * or a skip on a line that starts with `if (...)` / `else`. An `.only` never passes,
 * dated or not: it silently turns off every other test in its file.
 *
 * Fast by construction: one `git grep -l` picks the few files that name any of
 * these words, and only those are read.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gitChildEnv } from '../../src/lib/git-env.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const SELF = path.relative(REPO, fileURLToPath(import.meta.url))
const MARK = /\/\/\s*skip:\s*(\d{4}-\d{2}-\d{2})\s+(\S.{9,})/

interface Finding { line: number; kind: string; text: string; why: string }

/**
 * The source with every comment, string body and regex body blanked to spaces
 * (quotes, backticks and newlines kept), so a match in the result is code and its
 * offset is the original's.
 */
function codeOnly(src: string): string {
  const parts: string[] = []
  let kept = 0
  const blank = (from: number, to: number) => {
    if (to <= from) return
    parts.push(src.slice(kept, from), src.slice(from, to).replace(/[^\n]/g, ' '))
    kept = to
  }
  let i = 0
  let prev = '' // last significant code char, to tell a regex from a division
  const templates: number[] = [] // brace depth at each open `${`
  let depth = 0
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, Math.min(j, src.length)); i = j + 1; prev = c; continue
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop()
      let j = i + 1
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1
      blank(i + 1, Math.min(j, src.length))
      if (src[j] === '$') { templates.push(depth); i = j + 2; prev = '{'; continue }
      i = j + 1; prev = '`'; continue
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\b(return|typeof|case|in|of|void|throw|new|delete)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, cls = false
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      blank(i + 1, j); i = j + 1; prev = '/'; continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') prev = c
    i++
  }
  parts.push(src.slice(kept))
  return parts.join('')
}

/** Where the argument list opened at `open` (a `(`) ends its first argument and the whole list. */
function args(code: string, open: number): { firstEnd: number; close: number } {
  let d = 0, firstEnd = -1
  for (let k = open; k < code.length; k++) {
    const c = code[k]
    if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return { firstEnd: firstEnd < 0 ? k : firstEnd, close: k } }
    else if (c === ',' && d === 1 && firstEnd < 0) firstEnd = k
  }
  return { firstEnd: firstEnd < 0 ? code.length : firstEnd, close: code.length }
}

const CALL = /\b(?:it|test|describe|suite|bench)(?:\.\w+)*?\.(skip|todo|fixme|only)\b(?!If|\w)|(?<![\w.$])(x(?:it|describe|test))\s*\(/g
const QUICK = new RegExp(CALL.source)
const FUNCTION_START = /^\s*(?:async\b|function\b|\([^()]*\)\s*=>|\w+\s*=>)/

/** Every unconditional skip, todo, fixme or only in `src` without its dated reason. */
function findUnmarkedSkips(src: string): Finding[] {
  const code = codeOnly(src)
  const lines = src.split('\n')
  const starts: number[] = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1)
  const lineOf = (off: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1 } return lo }
  const found: Finding[] = []
  for (const m of code.matchAll(CALL)) {
    const kind = m[1] ?? m[2]
    const at = m.index!
    const ln = lineOf(at)
    const prefix = code.slice(starts[ln], at)
    const after = code.slice(at + m[0].length).match(/^\s*(.)/)?.[1] ?? ''
    let conditional = false
    if (kind === 'only') conditional = false
    else if (/^\s*(?:\}\s*)?(?:if\s*\(|else\b)/.test(prefix) || /&&|\|\||\?\s*$|\?[^.]/.test(prefix) || /^\s*:/.test(prefix)) conditional = true
    else if (m[2]) conditional = false
    else if (after === '(' && kind !== 'todo') {
      const open = at + m[0].length + code.slice(at + m[0].length).indexOf('(')
      const { firstEnd, close } = args(code, open)
      const first = code.slice(open + 1, firstEnd).trim()
      const second = firstEnd < close ? code.slice(firstEnd + 1, close) : ''
      // Playwright's test.skip(condition[, reason]); a title is a string, or comes before a function.
      if (first && !/^['"`]/.test(first) && !FUNCTION_START.test(second)) conditional = true
    }
    if (conditional) continue
    const marked = [lines[ln], ln > 0 ? lines[ln - 1] : ''].some((l) => {
      const mk = MARK.exec(l)
      return !!mk && !Number.isNaN(Date.parse(mk[1])) && Date.parse(mk[1]) <= Date.now()
    })
    if (marked && kind !== 'only') continue
    found.push({
      line: ln + 1, kind, text: lines[ln].trim().slice(0, 120),
      why: kind === 'only' ? 'an .only turns off every other test in the file' : 'no `// skip: YYYY-MM-DD <reason>` on this line or the one above',
    })
  }
  return found
}

/** Tracked test sources that may hold one: a fixed-string git grep (~0.1 s), then the matcher's own words. */
function candidateFiles(): { file: string; src: string }[] {
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-lF', '-e', '.skip', '-e', '.only', '-e', '.todo', '-e', '.fixme', '-e', 'xit(', '-e', 'xdescribe(', '-e', 'xtest(',
      '--', 'tests', '*.test.*', '*.spec.*', ':!src', ':!web/src', ':!docs', ':!ios-native'],
    { cwd: REPO, encoding: 'utf8', env: gitChildEnv(), maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
  const picked: { file: string; src: string }[] = []
  for (const file of new Set(out.split('\n'))) {
    if (!file || file === SELF || file.includes('/fixtures/') || !/\.(?:[cm]?[jt]sx?)$/.test(file)) continue
    const full = path.join(REPO, file)
    if (!fs.existsSync(full)) continue
    const src = fs.readFileSync(full, 'utf8')
    if (QUICK.test(src)) picked.push({ file, src })
  }
  return picked
}

describe('the skip matcher', () => {
  const one = (src: string) => findUnmarkedSkips(src).map((f) => `${f.line}:${f.kind}`)

  it('flags a bare skip, todo, fixme, x-prefixed test and only', () => {
    expect(one("it.skip('a', () => {})")).toEqual(['1:skip'])
    expect(one("describe.skip('a', () => {\n  it('b', () => {})\n})")).toEqual(['1:skip'])
    expect(one("it.todo('later')")).toEqual(['1:todo'])
    expect(one("test.fixme('a', async ({ page }) => {})")).toEqual(['1:fixme'])
    expect(one("test.describe.skip('a', () => {})")).toEqual(['1:skip'])
    expect(one('test.skip()')).toEqual(['1:skip'])
    expect(one("xit('a', () => {})\nxdescribe('b', () => {})")).toEqual(['1:xit', '2:xdescribe'])
    expect(one("it.only('a', () => {})")).toEqual(['1:only'])
    expect(one("it.skip.each([1])('a %s', () => {})")).toEqual(['1:skip'])
  })

  it('passes a skip with a dated reason on its line or the line above, and never an only', () => {
    expect(one("// skip: 2026-11-09 needs a GPU on the host\nit.skip('a', () => {})")).toEqual([])
    expect(one("it.skip('a', () => {}) // skip: 2026-11-09 needs a GPU on the host")).toEqual([])
    expect(one("// skip: 2026-11-09 short\nit.skip('a', () => {})")).toEqual(['2:skip'])
    expect(one("// skip: someday, it needs a GPU on the host\nit.skip('a', () => {})")).toEqual(['2:skip'])
    expect(one("// skip: 2999-01-01 needs a GPU on the host\nit.skip('a', () => {})")).toEqual(['2:skip'])
    expect(one("// skip: 2026-11-09 needs a GPU on the host\n\nit.skip('a', () => {})")).toEqual(['3:skip'])
    expect(one("// skip: 2026-11-09 focus while debugging it\nit.only('a', () => {})")).toEqual(['2:only'])
  })

  it('passes a skip with a condition', () => {
    expect(one("it.skipIf(process.platform !== 'darwin')('a', () => {})")).toEqual([])
    expect(one("describe.runIf(HAVE_BIN)('a', () => {})")).toEqual([])
    expect(one("test.skip(browserName !== 'webkit', 'WebKit only')")).toEqual([])
    expect(one("test.skip(({ browserName }) => browserName !== 'chromium', 'needs a fake device')")).toEqual([])
    expect(one("  test.skip(await rows.count() === 0, 'no rows')")).toEqual([])
    expect(one("test.fixme(isMobile, 'broken on phones')")).toEqual([])
    expect(one('const d = hasBinary ? describe : describe.skip')).toEqual([])
    expect(one("(runLive ? describe : describe.skip)('LIVE', () => {})")).toEqual([])
    expect(one("const d = ok\n  ? describe\n  : describe.skip")).toEqual([])
    expect(one("if (!key) { it.skip('no key', () => {}); return }")).toEqual([])
    expect(one("if (bin) suite(bin)\nelse describe.skip('needs the binary', () => {})")).toEqual([])
    expect(one("it('a', (ctx) => { if (!found) ctx.skip() })")).toEqual([])
  })

  it('does not count a skip inside a string, a template, a comment or a regex', () => {
    expect(one(`const s = "it.skip('a', () => {})"`)).toEqual([])
    expect(one("const s = 'describe.only(\"a\")'")).toEqual([])
    expect(one('const t = `it.skip(${name}) and test.only(x)`')).toEqual([])
    expect(one('const t = `${`it.skip()`}`; it.skip(\'a\', () => {})')).toEqual(['1:skip'])
    expect(one("// it.skip('a', () => {})\n/* test.only('b') */")).toEqual([])
    expect(one('const re = /\\b(it|test)\\.skip\\(/g')).toEqual([])
    expect(one("const half = total / 2; it.skip('a', () => {})")).toEqual(['1:skip'])
    expect(one("const s = 'don\\'t'; it.skip('a', () => {})")).toEqual(['1:skip'])
  })
})

describe('tracked test files', () => {
  it('skip nothing for good without a dated reason, and leave no .only', () => {
    const bad: string[] = []
    for (const { file, src } of candidateFiles()) {
      for (const f of findUnmarkedSkips(src)) bad.push(`${file}:${f.line}  ${f.text}\n    (${f.why})`)
    }
    expect(bad, [
      'Unconditional skips without a dated reason. For each one:',
      '  1. make it run, or',
      '  2. delete it when what it tests is gone (or another test covers it), or',
      '  3. keep it skipped with `// skip: YYYY-MM-DD <why, 10+ chars>` on its line or the line above.',
      'A skip that has a real condition (skipIf/runIf, test.skip(condition, reason)) needs nothing. Remove every .only.',
      '',
      ...bad,
    ].join('\n')).toEqual([])
  })
})
