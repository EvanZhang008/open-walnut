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
  CLI_FAST_FILES, CLI_FAST_FROM_DISK, STAGE_MAX_AGE_MS, STAGE_PREFIX, bundleCliFast, checkFromDisk, foreignBundleUrlReaders,
  installCliFast, segmentsOnLines,
} from '../../scripts/build-cli-fast.mjs'
import { BYTECODE_HIT, BYTECODE_PROBE_ENV as PROBE_ENV, probeCliFast } from '../../scripts/cli-fast-probe.mjs'
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

/** A throwaway package for a fixture build: its files by repo-relative path. `dir`: its own dir name. */
function fixtureRepo(files: Record<string, string>, dir?: string): string {
  const repo = dir ? path.join(tmpDir(), dir) : tmpDir()
  for (const [rel, body] of Object.entries({ 'package.json': '{"name":"fixture","version":"1.2.3"}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), body)
  }
  return repo
}

const FAKEDEP = {
  'node_modules/fakedep/package.json': '{"name":"fakedep","version":"1.0.0","type":"module","main":"index.js"}',
  'node_modules/fakedep/index.js': "import fs from 'node:fs'\nexport const asset = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8')\n",
  'node_modules/fakedep/asset.txt': 'beside the package',
}
const OWN_READER = "import { fileURLToPath } from 'node:url'\nconsole.log(fileURLToPath(new URL('.', import.meta.url)))\n"

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
    const repo = fixtureRepo({ 'src/entry.ts': "import { asset } from 'fakedep'\nconsole.log(asset())\n", ...FAKEDEP })
    await expect(bundleCliFast({ repo, entry: 'src/entry.ts', fromDisk: [] }))
      .rejects.toThrow(/read import\.meta\.url[\s\S]*\n {2}node_modules\/fakedep\/index\.js$/)
  })

  it('places each read by the source map: a line of Walnut\'s code shaped like bun\'s file comment moves nothing', async () => {
    // A template string keeps its lines in the bundle, this one exactly a bun file comment.
    const repo = fixtureRepo({ 'src/entry.ts': "export const doc = `\n// node_modules/other/x.js\n`\nconsole.log(doc.length, new URL('.', import.meta.url).pathname)\n" })
    const r = await buildAndRun(repo)
    expect(r.files.get('cli-fast.js')!.toString('utf8').split('\n')).toContain('// node_modules/other/x.js')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`28 ${path.join(repo, 'dist')}/\n`)
  })

  it('does not read bun\'s file comments at all: with them rewritten, the map still names each reader', async () => {
    const repo = fixtureRepo({ 'src/entry.ts': OWN_READER })
    const files = await bundleCliFast({ repo, entry: 'src/entry.ts', fromDisk: [] })
    const js = files.get('cli-fast.js')!.toString('utf8').replace(/^\/\/ (\S+)$/gm, '//| module $1')
    const map = JSON.parse(files.get('cli-fast.js.map')!.toString('utf8'))
    expect(foreignBundleUrlReaders(js, map, { repo })).toEqual([])
    const entry = map.sources.findIndex((s: string) => s.endsWith('src/entry.ts'))
    const asDep = { ...map, sources: map.sources.map((s: string, i: number) => (i === entry ? s.replace('src/entry.ts', 'node_modules/dep/index.js') : s)) }
    expect(foreignBundleUrlReaders(js, asDep, { repo })).toEqual(['node_modules/dep/index.js'])
    expect(foreignBundleUrlReaders(js, { ...map, mappings: '' }, { repo })).toEqual([expect.stringMatching(/^\(code the source map does not place, line \d+\)$/)])
  })

  it('reads the same from a checkout whose path has a space in it', async () => {
    const own = fixtureRepo({ 'src/entry.ts': OWN_READER }, 'my checkout')
    const r = await buildAndRun(own)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`${path.join(own, 'dist')}/\n`)
    const dep = fixtureRepo({ 'src/entry.ts': "import { asset } from 'fakedep'\nconsole.log(asset())\n", ...FAKEDEP }, 'my checkout')
    await expect(bundleCliFast({ repo: dep, entry: 'src/entry.ts', fromDisk: [] }))
      .rejects.toThrow(/read import\.meta\.url[\s\S]*\n {2}node_modules\/fakedep\/index\.js$/)
  })

  it('refuses a build that writes a file beyond the three it installs', async () => {
    const repo = fixtureRepo({
      'src/entry.ts': "import asset from './note.txt' with { type: 'file' }\nconsole.log(asset)\n",
      'src/note.txt': 'an asset bun copies beside the bundle',
    })
    await expect(bundleCliFast({ repo, entry: 'src/entry.ts', fromDisk: [] }))
      .rejects.toThrow(/bun wrote files beyond cli-fast\.js, cli-fast\.js\.jsc, cli-fast\.js\.map[\s\S]*\n {2}note-\w+\.txt \(asset\)$/)
  })

  it('decodes source map segments: columns per line, the source index carried across lines', () => {
    // gB is 16; D is -1; a one-field segment (E: column +2) maps to no source.
    const lines = segmentsOnLines('AAAA,CAAC;ACAA,E;;gBDAA', new Set([0, 1, 2, 3]))
    expect(Object.fromEntries(lines)).toEqual({ 0: [[0, 0], [1, 0]], 1: [[0, 1], [2, -1]], 3: [[16, 0]] })
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
    expect(path.basename(path.dirname(staged))).toMatch(new RegExp(`^${STAGE_PREFIX.replace(/\./g, '\\.')}\\w{6}$`))
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

  it('two builds at once into one out dir (containers with the same pid) stage apart, neither touching the other', () => {
    const dir = withOld()
    const staged: string[] = []
    installCliFast(built(), dir, {
      probe: (outer: string) => {
        staged.push(path.dirname(outer))
        installCliFast(built(), dir, { probe: (inner: string) => { staged.push(path.dirname(inner)); return null } })
        expect(fs.readdirSync(path.dirname(outer)).sort()).toEqual([...CLI_FAST_FILES].sort())
        return null
      },
    })
    expect(new Set(staged).size).toBe(2)
    for (const name of CLI_FAST_FILES) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(`new ${name}\n`)
    expect(left(dir)).toEqual([...CLI_FAST_FILES].sort())
  })

  it('removes a stage older than an hour, whichever build left it, and keeps a newer one', () => {
    const dir = tmpDir()
    const old = path.join(dir, `${STAGE_PREFIX}Killed`)
    const live = path.join(dir, `${STAGE_PREFIX}Others`)
    for (const d of [old, live]) {
      fs.mkdirSync(d)
      fs.writeFileSync(path.join(d, 'cli-fast.js.map'), 'partial')
    }
    const then = new Date(Date.now() - STAGE_MAX_AGE_MS - 60_000)
    fs.utimesSync(old, then, then)
    installCliFast(built(), dir, { probe: null })
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
  })
})

describe('the probe', () => {
  it('reads bytecode use the way the compiled file\'s selftest does', () => {
    expect(PROBE_ENV).toBe(BYTECODE_PROBE_ENV)
    const hit = '[Disk Cache] Cache miss for sourceCode\n[Disk Cache] Cache hit for sourceCode\n'
    for (const text of [hit, '[Disk Cache] Cache miss for sourceCode\n']) expect(BYTECODE_HIT.test(text)).toBe(bytecodeHit(text))
  })

  // An entry that answers the three commands as cli-fast does with no server, and
  // fails (exit 9) when the probe's env points anywhere a real Walnut lives.
  const stub = (callExit: number, callSays: string) => {
    const file = path.join(tmpDir(), 'cli-fast.js')
    fs.writeFileSync(file, `
const a = process.argv.slice(2)
const leaked = ['WALNUT_SERVER_URL', 'OPEN_WALNUT_HOME', 'WALNUT_SESSION_ID', 'WALNUT_AGENT_SOCKET', 'WALNUT_CLI_DIRECT', 'NODE_OPTIONS'].filter((k) => process.env[k])
const daemonDir = process.env.WALNUT_DAEMON_DIR ?? ''
if (leaked.length || !daemonDir.startsWith(process.env.HOME + '/') || process.env.OPEN_WALNUT_API_URL !== 'http://127.0.0.1:9') {
  console.error('reached for a real Walnut: ' + leaked.join(',') + ' daemon dir ' + daemonDir)
  process.exit(9)
}
if (a[0] === '--version') console.log('1.2.3 (stub)')
else if (a[0] === 'tools' && a[1] === 'list') console.log('Available operations:\\n  task_list')
else if (a[0] === 'tools' && a[1] === 'call' && a[2] === 'task_get' && a[3] === '{"id":"probe"}') { console.error(${JSON.stringify(callSays)}); process.exit(${callExit}) }
else process.exit(2)
`)
    return file
  }

  it('runs tools call too: bun loads a module when first used, so the call path can fail alone', () => {
    expect(probeCliFast(stub(1, 'Walnut server not running at http://127.0.0.1:9/api/v1'))).toEqual({ version: '1.2.3 (stub)', fromBytecode: false })
    expect(() => probeCliFast(stub(70, 'walnut: Cannot find module ./tools-daemon-fallback.js')))
      .toThrow(/tools call task_get failed \(exit 70\): walnut: Cannot find module/)
    // A call that reached some server answers 0: not the dead port the probe gave it.
    expect(() => probeCliFast(stub(0, ''))).toThrow(/tools call task_get failed \(exit 0\)/)
  })

  it('reaches no Walnut: none of the caller\'s Walnut env gets in, and the daemon dir is its own', () => {
    vi.stubEnv('WALNUT_SERVER_URL', 'http://127.0.0.1:3456')
    vi.stubEnv('OPEN_WALNUT_HOME', path.join(os.homedir(), '.open-walnut'))
    vi.stubEnv('WALNUT_DAEMON_DIR', '/tmp/open-walnut')
    vi.stubEnv('WALNUT_SESSION_ID', 'a-real-session')
    vi.stubEnv('WALNUT_AGENT_SOCKET', '/tmp/open-walnut/agent.sock')
    vi.stubEnv('OPEN_WALNUT_API_URL', 'http://127.0.0.1:3456')
    vi.stubEnv('NODE_OPTIONS', '--require /nowhere.js')
    try {
      expect(probeCliFast(stub(1, 'Walnut server not running at http://127.0.0.1:9/api/v1')).version).toBe('1.2.3 (stub)')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
