/**
 * The real dist/cli-fast.js build (scripts/build-cli-fast.mjs), run the way a
 * user runs it: bun's CommonJS bundle with its bytecode beside it, through
 * bin/open-walnut.js too. Built once into a throwaway package layout inside
 * node_modules/.cache, so the dependencies it loads from disk resolve the way
 * they do from a checkout's dist/. Nothing outside that directory is touched.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPathsIn, moduleRoots } from '../../scripts/binary-build-checks.mjs'
import { CLI_FAST_FILES, CLI_FAST_PRAGMA, bundleCliFast, installCliFast } from '../../scripts/build-cli-fast.mjs'
import { publishDist } from '../../scripts/publish-serve-root-dist.mjs'
import { BYTECODE_PROBE_ENV, bytecodeHit } from '../../src/binary/selftest.js'
import { topLevelAwaits } from '../helpers/top-level-await.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string
const STAMP = { version: VERSION, commit: 'abc123def', branch: null, builtAt: '2026-11-04T12:00:00.000Z', dirty: false }
let cache = ''
let built = new Map<string, Buffer>()
let home = ''

/** A package layout (bin/, dist/) holding the build, or a variant of it. */
function layout(name: string): string {
  const dir = path.join(cache, name)
  installCliFast(built, path.join(dir, 'dist'), { probe: null })
  fs.writeFileSync(path.join(dir, 'dist', 'build-info.json'), JSON.stringify(STAMP))
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'bin/open-walnut.js'), path.join(dir, 'bin/open-walnut.js'))
  return dir
}

function run(file: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      // Nothing listens there: the data commands fail fast instead of finding a server.
      OPEN_WALNUT_API_URL: 'http://127.0.0.1:9',
      WALNUT_SESSION_ID: '', WALNUT_AGENT_SOCKET: '', WALNUT_CLI_DIRECT: '',
      ...env,
    },
  })
}

/** `--version` with bun saying, per module, whether it came from bytecode (src/binary/selftest.ts). */
function probe(file: string) {
  const r = run(file, ['--version'], { [BYTECODE_PROBE_ENV]: '1' })
  return { status: r.status, stdout: r.stdout, fromBytecode: bytecodeHit(r.stderr) }
}

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, 'node_modules', '.cache'), { recursive: true })
  cache = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache', 'cli-fast-test-'))
  home = path.join(cache, 'home')
  fs.mkdirSync(home)
  built = await bundleCliFast({ repo: ROOT })
}, 120_000)
afterAll(() => { if (cache) fs.rmSync(cache, { recursive: true, force: true }) })

describe('dist/cli-fast.js as bun builds it', () => {
  it('is a CommonJS bundle with its bytecode beside it, carrying no path of the build machine', () => {
    const js = built.get('cli-fast.js')!.toString('utf8')
    const [first, second] = js.split('\n')
    expect(first).toBe(CLI_FAST_PRAGMA)
    // Strict, as an ES bundle is (tests/scripts/cli-fast-build-ratchet.test.ts runs a fixture of it).
    expect(second).toMatch(/^\(function\(exports, require, module, __filename, __dirname\) \{"use strict";var __walnutBundleUrl = /)
    expect(built.get('cli-fast.js.jsc')!.length).toBeGreaterThan(1024 * 1024)
    expect(js.endsWith('//# sourceMappingURL=cli-fast.js.map\n')).toBe(true)
    const roots = [ROOT, fs.realpathSync(ROOT), ...moduleRoots(ROOT).map((r: { real: string }) => r.real), os.homedir()]
    expect([...buildPathsIn(built.get('cli-fast.js')!, roots).keys()]).toEqual([])
  })

  it('has no top-level await in any Walnut module it takes in (CommonJS has none)', () => {
    const map = JSON.parse(built.get('cli-fast.js.map')!.toString('utf8')) as { sources: string[] }
    const own = map.sources.filter((s) => /^(src|packages)\/.*\.(ts|tsx|js|mjs)$/.test(s))
    expect(own.length).toBeGreaterThan(500)
    expect(own).toContain('src/cli-fast.ts')
    expect(own.flatMap((rel) => topLevelAwaits(path.join(ROOT, rel), ROOT))).toEqual([])
  })

  it('passes the probe the build and the publish run on it, from its bytecode', () => {
    const dir = path.join(cache, 'probe')
    const said = installCliFast(built, path.join(dir, 'dist'))
    expect(said).toMatchObject({ fromBytecode: true })
    expect(said!.version).toMatch(new RegExp(`^${VERSION.replace(/\./g, '\\.')}`))
  })

  it('starts from its bytecode: the speed is the point', () => {
    const dir = layout('bytecode')
    expect(probe(path.join(dir, 'dist/cli-fast.js'))).toMatchObject({ status: 0, fromBytecode: true })
    expect(probe(path.join(dir, 'bin/open-walnut.js'))).toMatchObject({ status: 0, fromBytecode: true })
  })

  it('--version reads the build stamp beside the bundle, so import.meta.url is the bundle\'s own place', () => {
    const dir = layout('version')
    const r = run(path.join(dir, 'dist/cli-fast.js'), ['--version'])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(new RegExp(`^${VERSION.replace(/\./g, '\\.')} \\(abc123def, \\d{4}-\\d{2}-\\d{2}\\)\\n$`))
  })

  it('answers tools list, and an unknown op the way it did', () => {
    const dir = layout('tools')
    const list = run(path.join(dir, 'dist/cli-fast.js'), ['tools', 'list'])
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout).toContain('Available operations')
    expect(list.stdout).toContain('task_list')
    const unknown = run(path.join(dir, 'dist/cli-fast.js'), ['tools', 'call', 'no_such_op', '{}'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toMatch(/unknown op: no_such_op/i)
    expect(unknown.stdout).toBe('')
  })

  it('runs the source when the .jsc is not its own (another bun, a broken copy)', () => {
    const dir = layout('foreign-jsc')
    fs.writeFileSync(path.join(dir, 'dist/cli-fast.js.jsc'), Buffer.alloc(4096, 7))
    const r = probe(path.join(dir, 'dist/cli-fast.js'))
    expect(r).toMatchObject({ status: 0, fromBytecode: false })
    expect(r.stdout).toContain('abc123def')
    fs.rmSync(path.join(dir, 'dist/cli-fast.js.jsc'))
    const none = run(path.join(dir, 'dist/cli-fast.js'), ['--version'])
    expect(none.status, none.stderr).toBe(0)
    expect(none.stdout).toContain('abc123def')
  })

  it('reaches the full CLI from its default branch, and a failure there exits 70 with the reason', () => {
    const dir = layout('default-branch')
    fs.writeFileSync(path.join(dir, 'dist/cli.js'), "console.log('full cli ran:', process.argv.slice(2).join(' '))\n")
    const ok = run(path.join(dir, 'dist/cli-fast.js'), ['--help'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toBe('full cli ran: --help\n')
    fs.writeFileSync(path.join(dir, 'dist/cli.js'), "throw new Error('the full CLI broke')\n")
    const bad = run(path.join(dir, 'dist/cli-fast.js'), ['--help'])
    expect(bad.status).toBe(70)
    expect(bad.stderr).toBe('walnut: the full CLI broke\n')
  })
})

describe('bin/open-walnut.js on the CommonJS entry', () => {
  it('runs it, and keeps its guards: empty, unreadable, and a half-written bundle', () => {
    const dir = layout('bin')
    const bin = path.join(dir, 'bin/open-walnut.js')
    const entry = path.join(dir, 'dist/cli-fast.js')
    const ok = run(bin, ['--version'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toContain('abc123def')

    // Half written, its own full .jsc beside it: bun refuses bytecode made from
    // other source, parses what is there, and the import fails loudly.
    const full = built.get('cli-fast.js')!
    fs.writeFileSync(entry, full.subarray(0, Math.floor(full.length / 2)))
    const half = run(bin, ['--version'])
    expect(half.status).toBe(70)
    expect(half.stderr).toMatch(/^walnut: cannot load \.\.\/dist\/cli-fast\.js: /)
    expect(half.stdout).toBe('')

    fs.writeFileSync(entry, '')
    const empty = run(bin, ['--version'])
    expect(empty.status).toBe(70)
    expect(empty.stderr).toContain('../dist/cli-fast.js is empty (build in progress?)')

    fs.rmSync(entry)
    const missing = run(bin, ['tools', 'list'])
    expect(missing.status).toBe(70)
    expect(missing.stderr).toMatch(/^walnut: cannot read \.\.\/dist\/cli-fast\.js: /)
  })

  it('is published into a checkout when it runs, and refused, the old CLI kept, when it does not', () => {
    const from = path.join(layout('publish-from'), 'dist')
    fs.writeFileSync(path.join(from, 'cli.js'), "console.log('full cli')\n")
    const checkout = path.join(cache, 'publish-checkout')
    fs.mkdirSync(path.join(checkout, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'package.json'), '{}')
    fs.writeFileSync(path.join(checkout, 'dist', 'cli-fast.js'), 'old fast\n')
    const { order } = publishDist(from, path.join(checkout, 'dist'))
    expect(order.at(-1)).toBe('cli-fast.js.jsc')
    // Buffer.equals: toEqual walks 18 MB a byte at a time, for minutes.
    expect(fs.readFileSync(path.join(checkout, 'dist', 'cli-fast.js')).equals(built.get('cli-fast.js')!)).toBe(true)

    const full = built.get('cli-fast.js')!
    fs.writeFileSync(path.join(from, 'cli-fast.js'), full.subarray(0, Math.floor(full.length / 2)))
    fs.writeFileSync(path.join(checkout, 'dist', 'cli-fast.js'), 'old fast\n')
    expect(() => publishDist(from, path.join(checkout, 'dist'))).toThrow(/the new CLI does not run, so it is not published/)
    expect(fs.readFileSync(path.join(checkout, 'dist', 'cli-fast.js'), 'utf8')).toBe('old fast\n')
  })

  it('leaves the build as three files: entry, bytecode, source map', () => {
    expect([...built.keys()].sort()).toEqual([...CLI_FAST_FILES].sort())
  })
})
