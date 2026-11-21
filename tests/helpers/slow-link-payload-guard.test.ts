/**
 * A test that times a slow link while Walnut's own reader moves a file over it (a session's
 * history, the file viewer's /api/file-content) builds that file from noise (incompressible.ts),
 * never from a repeated line or pad. Those reads come gzipped from another host
 * (fs-read-range-gz-v1), so repeated text packs about a hundred times and "a long read" ends in
 * seconds: 2026-11-21, host-read-silent-link-e2e (3MB in 4s) and cloud-host-silent-link.spec.ts
 * (a 5MB history in under 20s, never "Still loading this conversation from Cloud").
 *
 * The class, found from the source: every test file that sets a link slow and reads through
 * Walnut's reader. A `.repeat(` there is the bug, unless its count is a small literal (a short
 * separator). Tests that send daemon commands straight (fs.read, fs.writePart, fs.readRange with
 * no gz) move plain bytes and are not members.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SKIP = new Set(['node_modules', 'dist', '.git'])

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourcesUnder(p, out)
    else if (/\.(ts|mts|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const SETS_SLOW = /setMode\(\s*'slow'|setLink\(\s*'slow'|slowLink\(/
/** Walnut's own readers of another host's files: the history and file routes. */
const READS_THROUGH_WALNUT = /\/api\/file-content|\/api\/file-history|\/history\b|seedColumns\(/
/** A repeat whose count is not a small literal. */
const BIG_REPEAT = /\.repeat\(\s*(?!(?:[1-9]|[1-5]\d|6[0-4])\s*\))[^)]/

function members(): Array<{ rel: string; text: string }> {
  return sourcesUnder(path.join(ROOT, 'tests'))
    .filter((f) => f !== __filename)
    .map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf-8') }))
    .filter((f) => SETS_SLOW.test(f.text) && READS_THROUGH_WALNUT.test(f.text))
}

describe('slow-link tests that read through Walnut move incompressible files', () => {
  it('the check finds the shape it guards against', () => {
    expect(BIG_REPEAT.test("const pad = 'x'.repeat(4000)")).toBe(true)
    expect(BIG_REPEAT.test('line.repeat(Math.ceil((600 * 1024) / line.length))')).toBe(true)
    expect(BIG_REPEAT.test("'-'.repeat(40)")).toBe(false)
    expect(BIG_REPEAT.test('`a line ${noise(39)}`')).toBe(false)
  })

  it('finds the tests it covers', () => {
    const rels = members().map((m) => m.rel)
    expect(rels).toContain(path.join('tests', 'e2e', 'browser', 'cloud-host-silent-link.spec.ts'))
    expect(rels).toContain(path.join('tests', 'e2e', 'host-read-silent-link-e2e.test.ts'))
  })

  it('none builds its payload from repeated text', () => {
    const hits = members().flatMap((m) => m.text.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => BIG_REPEAT.test(l.line))
      .map((l) => `${m.rel}:${l.n}: ${l.line}`))
    expect(hits, 'build the file from noise() in tests/helpers/incompressible.ts').toEqual([])
  })
})
