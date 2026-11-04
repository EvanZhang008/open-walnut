/**
 * dist/cli-fast.js is bun's CommonJS build with bytecode (scripts/build-cli-fast.mjs):
 * a data command loads compiled code instead of parsing ~20 MB of JavaScript.
 * The parts that need no build: the entry stays free of top-level await (CommonJS
 * has none, so one would fail every build), the dependencies it loads from disk
 * stay CommonJS dependencies, and the files land so that a reader never meets an
 * old .jsc. tests/scripts/cli-fast-bytecode.test.ts builds and runs it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_FAST_FILES, CLI_FAST_FROM_DISK, checkFromDisk, installCliFast } from '../../scripts/build-cli-fast.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fast-ratchet-'))
  roots.push(dir)
  return dir
}

/** `await` (or `for await`) outside every function body of a module: its top-level awaits. */
function topLevelAwaits(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return
    const isAwait = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
    if (isAwait) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      found.push(`${path.relative(ROOT, file)}:${line + 1}: ${node.getText().split('\n')[0]}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('src/cli-fast.ts stays loadable as CommonJS', () => {
  it('has no top-level await (its program is main(); one at the top would fail every build)', () => {
    expect(topLevelAwaits(path.join(ROOT, 'src/cli-fast.ts'))).toEqual([])
  })

  it('the check sees a top-level await, and not one inside a function', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'x.ts')
    fs.writeFileSync(file, "async function f() { await g() }\nif (x) { const m = await import('./m.js') }\nfor await (const c of s) {}\n")
    expect(topLevelAwaits(file).map((hit) => hit.replace(/^.*x\.ts:/, ''))).toEqual([
      "2: await import('./m.js')",
      '3: for await (const c of s) {}',
    ])
  })

  it('tsup no longer builds it: tsup.config.ts runs the bun build before the stamp', () => {
    const config = fs.readFileSync(path.join(ROOT, 'tsup.config.ts'), 'utf8')
    expect(config).not.toMatch(/^\s*'src\/cli-fast\.ts',/m)
    expect(config).toContain('onSuccess: afterBuild')
    const after = config.slice(config.indexOf('async function afterBuild'))
    expect(after.indexOf('buildCliFast()')).toBeGreaterThan(0)
    expect(after.indexOf('buildCliFast()')).toBeLessThan(after.indexOf('stampBuildInfo()'))
  })
})

describe('the dependencies cli-fast loads from node_modules', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  it('are CommonJS dependencies of this package', () => {
    expect(CLI_FAST_FROM_DISK.length).toBeGreaterThan(0)
    expect(() => checkFromDisk(ROOT, pkg)).not.toThrow()
  })

  it('refuses one that is not a dependency, and an ES-only package', () => {
    expect(() => checkFromDisk(ROOT, pkg, ['left-pad-not-a-dep'])).toThrow(/not in package\.json dependencies/)
    // chalk 5 is ES-only: as an external, `import chalk from 'chalk'` reads as its namespace.
    expect(() => checkFromDisk(ROOT, pkg, ['chalk'])).toThrow(/ES module package/)
  })
})

describe('installCliFast', () => {
  const built = () => new Map(CLI_FAST_FILES.map((name) => [name, Buffer.from(`new ${name}\n`)]))

  it('replaces all three files, the old bytecode gone before the entry lands and the new one placed last', () => {
    const dir = tmpDir()
    for (const name of CLI_FAST_FILES) fs.writeFileSync(path.join(dir, name), `old ${name}\n`)
    const seen: string[] = []
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const name = path.basename(String(to))
      seen.push(`${name} (old .jsc ${fs.existsSync(path.join(dir, 'cli-fast.js.jsc')) ? 'present' : 'gone'})`)
      return rename(from, to)
    })
    installCliFast(built(), dir)
    expect(seen).toEqual([
      'cli-fast.js.map (old .jsc gone)',
      'cli-fast.js (old .jsc gone)',
      'cli-fast.js.jsc (old .jsc gone)',
    ])
    for (const name of CLI_FAST_FILES) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(`new ${name}\n`)
    expect(fs.readdirSync(dir).sort()).toEqual([...CLI_FAST_FILES].sort())
  })

  it('removes the temp files a killed build left, never a running one\'s', () => {
    const dir = tmpDir()
    // Far above any pid_max: no process has it. The parent of this test runs.
    const dead = path.join(dir, 'cli-fast.js.map.999999999.tmp')
    const live = path.join(dir, `cli-fast.js.${process.ppid}.tmp`)
    for (const f of [dead, live]) fs.writeFileSync(f, 'partial')
    installCliFast(built(), dir)
    expect(fs.existsSync(dead)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
  })

  it('leaves the old files and no temp files when a write fails', () => {
    const dir = tmpDir()
    for (const name of CLI_FAST_FILES) fs.writeFileSync(path.join(dir, name), `old ${name}\n`)
    const files = built()
    files.delete('cli-fast.js.jsc')
    expect(() => installCliFast(files, dir)).toThrow()
    for (const name of CLI_FAST_FILES) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(`old ${name}\n`)
    expect(fs.readdirSync(dir).sort()).toEqual([...CLI_FAST_FILES].sort())
  })
})
