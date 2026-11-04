/**
 * dist/cli-fast.js is bun's CommonJS build with bytecode (scripts/build-cli-fast.mjs):
 * a data command loads compiled code instead of parsing ~20 MB of JavaScript.
 * The parts that need no full build: the entry has no top-level await, the build
 * runs strict, only Walnut's own files read the bundle's URL, the dependencies
 * loaded from disk stay CommonJS dependencies, and the files land (after the
 * probe ran the new entry) so that a reader never meets an old .jsc. Small
 * fixture builds stand in for the real one, which
 * tests/scripts/cli-fast-bytecode.test.ts builds and runs.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_FAST_FILES, CLI_FAST_FROM_DISK, bundleCliFast, checkFromDisk, foreignBundleUrlReaders, installCliFast,
} from '../../scripts/build-cli-fast.mjs'
import { BYTECODE_HIT, BYTECODE_PROBE_ENV as PROBE_ENV } from '../../scripts/cli-fast-probe.mjs'
import { BYTECODE_PROBE_ENV, bytecodeHit } from '../../src/binary/selftest.js'
import { topLevelAwaits } from '../helpers/top-level-await.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmpDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fast-ratchet-')))
  roots.push(dir)
  return dir
}

/** A throwaway package for a fixture build: its files by repo-relative path. */
function fixtureRepo(files: Record<string, string>): string {
  const repo = tmpDir()
  for (const [rel, body] of Object.entries({ 'package.json': '{"name":"fixture","version":"1.2.3"}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), body)
  }
  return repo
}

/** Build a fixture's src/entry.ts as cli-fast is built, install it in <repo>/dist and run it. */
async function buildAndRun(repo: string) {
  const files = await bundleCliFast({ repo, entry: 'src/entry.ts', fromDisk: [] })
  installCliFast(files, path.join(repo, 'dist'), { probe: null })
  const r = spawnSync(process.execPath, [path.join(repo, 'dist/cli-fast.js')], { encoding: 'utf8', timeout: 60_000 })
  return { files, ...r }
}

describe('src/cli-fast.ts stays loadable as CommonJS', () => {
  it('has no top-level await (its program is main(); one at the top would fail every build)', () => {
    expect(topLevelAwaits(path.join(ROOT, 'src/cli-fast.ts'), ROOT)).toEqual([])
  })

  it('the check sees a top-level await, and not one inside a function', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'x.ts')
    fs.writeFileSync(file, "async function f() { await g() }\nif (x) { const m = await import('./m.js') }\nfor await (const c of s) {}\n")
    expect(topLevelAwaits(file, dir)).toEqual([
      "x.ts:2: await import('./m.js')",
      'x.ts:3: for await (const c of s) {}',
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

describe('the bundle as the build makes it (fixture builds)', () => {
  it('runs strict, as every ES module does: sloppy-only code throws', async () => {
    const repo = fixtureRepo({
      'src/entry.ts': [
        '// @ts-nocheck',
        "function self() { return this }",
        "console.log(self() === undefined ? 'this: undefined' : 'this: the global')",
        "try { undeclaredProbe = 1; console.log('undeclared: made a global') } catch (e) { console.log('undeclared: ' + e.constructor.name) }",
        "const frozen = Object.freeze({ a: 1 })",
        "try { frozen.a = 2; console.log('frozen: ignored') } catch (e) { console.log('frozen: ' + e.constructor.name) }",
      ].join('\n'),
    })
    const r = await buildAndRun(repo)
    expect(r.files.get('cli-fast.js')!.toString('utf8').split('\n')[1]).toMatch(/^\(function\(exports, require, module, __filename, __dirname\) \{"use strict";/)
    expect(r.stdout).toBe('this: undefined\nundeclared: ReferenceError\nfrozen: TypeError\n')
  })

  it('gives Walnut\'s own files the bundle\'s own URL for import.meta.url', async () => {
    const repo = fixtureRepo({ 'src/entry.ts': "console.log(new URL('.', import.meta.url).pathname)\n" })
    const r = await buildAndRun(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`${path.join(repo, 'dist')}/\n`)
  })

  it('refuses a dependency that reads import.meta.url: it would look for its files in dist/', async () => {
    const repo = fixtureRepo({
      'src/entry.ts': "import { asset } from 'fakedep'\nconsole.log(asset())\n",
      'node_modules/fakedep/package.json': '{"name":"fakedep","version":"1.0.0","type":"module","main":"index.js"}',
      'node_modules/fakedep/index.js': "import fs from 'node:fs'\nexport const asset = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8')\n",
      'node_modules/fakedep/asset.txt': 'beside the package',
    })
    await expect(bundleCliFast({ repo, entry: 'src/entry.ts', fromDisk: [] }))
      .rejects.toThrow(/read import\.meta\.url[\s\S]*\n {2}node_modules\/fakedep\/index\.js$/)
  })

  it('the check reads the bundle by file section, and counts code outside any section', () => {
    const use = 'const here = __walnutBundleUrl'
    const js = ['// @bun @bytecode @bun-cjs', '(function(exports) {"use strict";var __walnutBundleUrl = 1;',
      '// src/a.ts', use, '// walnut-ws:ws', use, '// node_modules/dep/x.js', use, '// packages/p/y.ts', use, '// src/b.ts', use].join('\n')
    expect(foreignBundleUrlReaders(js)).toEqual(['node_modules/dep/x.js', 'packages/p/y.ts'])
    expect(foreignBundleUrlReaders(`(function() {var __walnutBundleUrl = 1;\n${use}\n// src/a.ts\n`)).toEqual(['(code before the first file)'])
  })

  it('reads a section\'s path from the build\'s working directory, which need not be the repo', () => {
    const top = tmpDir()
    const [repo, cwd] = ['repo', 'elsewhere'].map((d) => path.join(top, d))
    for (const d of [repo, cwd]) fs.mkdirSync(d)
    const use = 'const here = __walnutBundleUrl'
    const js = ['// ../repo/src/a.ts', use, '// src/b.ts', use, '// ../repo/node_modules/dep/x.js', use].join('\n')
    expect(foreignBundleUrlReaders(js, { repo, cwd })).toEqual([path.join(cwd, 'src/b.ts'), 'node_modules/dep/x.js'])
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
  const withOld = () => {
    const dir = tmpDir()
    for (const name of CLI_FAST_FILES) fs.writeFileSync(path.join(dir, name), `old ${name}\n`)
    return dir
  }
  const left = (dir: string) => fs.readdirSync(dir).sort()

  it('replaces all three files, the old bytecode gone before the entry lands and the new one placed last', () => {
    const dir = withOld()
    const seen: string[] = []
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const name = path.basename(String(to))
      seen.push(`${name} (old .jsc ${fs.existsSync(path.join(dir, 'cli-fast.js.jsc')) ? 'present' : 'gone'})`)
      return rename(from, to)
    })
    installCliFast(built(), dir, { probe: null })
    expect(seen).toEqual([
      'cli-fast.js.map (old .jsc gone)',
      'cli-fast.js (old .jsc gone)',
      'cli-fast.js.jsc (old .jsc gone)',
    ])
    for (const name of CLI_FAST_FILES) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(`new ${name}\n`)
    expect(left(dir)).toEqual([...CLI_FAST_FILES].sort())
  })

  it('probes the staged entry inside the out dir, its bytecode beside it, before anything moves', () => {
    const dir = withOld()
    let staged = ''
    const said = installCliFast(built(), dir, {
      probe: (file: string) => {
        staged = file
        expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([...CLI_FAST_FILES].sort())
        expect(fs.readFileSync(path.join(dir, 'cli-fast.js'), 'utf8')).toBe('old cli-fast.js\n')
        return { version: '1.2.3', fromBytecode: true }
      },
    })
    expect(path.dirname(path.dirname(staged))).toBe(dir)
    expect(path.basename(staged)).toBe('cli-fast.js')
    expect(said).toEqual({ version: '1.2.3', fromBytecode: true })
    expect(left(dir)).toEqual([...CLI_FAST_FILES].sort())
  })

  it('keeps the old files, and leaves nothing staged, when the probe or a write fails', () => {
    const dir = withOld()
    expect(() => installCliFast(built(), dir, { probe: () => { throw new Error('cli-fast.js --version failed (exit 1)') } }))
      .toThrow(/--version failed/)
    const files = built()
    files.delete('cli-fast.js.jsc')
    expect(() => installCliFast(files, dir, { probe: null })).toThrow()
    for (const name of CLI_FAST_FILES) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(`old ${name}\n`)
    expect(left(dir)).toEqual([...CLI_FAST_FILES].sort())
  })

  it('removes the staging dir a killed build left, never a running one\'s', () => {
    const dir = tmpDir()
    // Far above any pid_max: no process has it. The parent of this test runs.
    const dead = path.join(dir, 'cli-fast.999999999.tmp')
    const live = path.join(dir, `cli-fast.${process.ppid}.tmp`)
    for (const d of [dead, live]) {
      fs.mkdirSync(d)
      fs.writeFileSync(path.join(d, 'cli-fast.js.map'), 'partial')
    }
    installCliFast(built(), dir, { probe: null })
    expect(fs.existsSync(dead)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
  })
})

describe('the probe', () => {
  it('reads bytecode use the way the compiled file\'s selftest does', () => {
    expect(PROBE_ENV).toBe(BYTECODE_PROBE_ENV)
    const hit = '[Disk Cache] Cache miss for sourceCode\n[Disk Cache] Cache hit for sourceCode\n'
    for (const text of [hit, '[Disk Cache] Cache miss for sourceCode\n']) expect(BYTECODE_HIT.test(text)).toBe(bytecodeHit(text))
  })
})
