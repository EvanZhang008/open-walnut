/**
 * scripts/publish-serve-root-dist.mjs: after a deploy from a clean clone, the
 * build that serves is copied into the checkout's dist/, because the `walnut`
 * CLI runs the op registry from that bundle (2026-10-05: sessions read op text
 * two deploys old). Pinned here on throwaway trees; nothing real is touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { publishDist } from '../../scripts/publish-serve-root-dist.mjs'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'publish-serve-root-dist.mjs')
const DEV_PROD = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh'), 'utf-8')
const roots: string[] = []
// The new build's cli-fast.js: just enough of the CLI to answer the publish's
// probe (scripts/cli-fast-probe.mjs: `--version`, `tools list`, then a
// `tools call` that finds no server).
const NEW_FAST = [
  'const a = process.argv.slice(2)',
  "if (a[0] === '--version') console.log('9.9.9 (new)')",
  "else if (a[1] === 'list') console.log('Available operations:\\n  task_list')",
  "else { console.error('Walnut server not running at http://127.0.0.1:9/api/v1'); process.exit(1) }",
  '',
].join('\n')
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function write(p: string, body: string, mode?: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  if (mode !== undefined) fs.chmodSync(p, mode)
}

/** A build (`from`) and a checkout whose dist/ holds an older build (`to`). */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-dist-')))
  roots.push(root)
  const from = path.join(root, 'stage', 'dist')
  const checkout = path.join(root, 'checkout')
  const to = path.join(checkout, 'dist')
  write(path.join(checkout, 'package.json'), '{}')
  write(path.join(from, 'cli.js'), 'new cli\n')
  write(path.join(from, 'cli-fast.js'), NEW_FAST)
  write(path.join(from, 'build-info.json'), '{"commit":"new"}')
  write(path.join(from, 'data', 'skills', 'walnut-trigger', 'SKILL.md'), 'new skill\n')
  write(path.join(from, 'daemon-binaries', 'daemon-darwin-arm64'), 'bin', 0o755)
  write(path.join(from, 'web', 'static', 'index.html'), '<script src="assets/index-new.js"></script>')
  write(path.join(from, 'web', 'static', 'assets', 'index-new.js'), 'new asset')
  // Test data: a Unicode file name ("notes" in Chinese) under data/.
  write(path.join(from, 'data', '\u7b14\u8bb0.md'), 'unicode\n')

  write(path.join(to, 'cli.js'), 'old cli\n')
  write(path.join(to, 'cli-fast.js'), 'old fast\n')
  write(path.join(to, 'tools-V7WAW7MY.js'), 'old chunk from a split build')
  write(path.join(to, 'web', 'static', 'index.html'), '<script src="assets/index-old.js"></script>')
  write(path.join(to, 'web', 'static', 'assets', 'index-old.js'), 'old asset')
  write(path.join(to, 'web', 'static', 'old-dir', 'x.css'), 'old')
  write(path.join(to, 'data', 'skills', 'retired-skill', 'SKILL.md'), 'a skill the build no longer ships')
  return { root, from, to, checkout }
}

const read = (p: string) => fs.readFileSync(p, 'utf-8')
// Copy-order tests skip the probe (three bun runs per publish); the tests below
// that are about it run the real one.
const NO_PROBE = { probe: null }

describe('publishDist', () => {
  it('copies the build over the checkout dist, entries last, keeping files the build lacks', () => {
    const { from, to } = fixture()
    const { order, pruned } = publishDist(from, to, NO_PROBE)
    expect(read(path.join(to, 'cli.js'))).toBe('new cli\n')
    expect(read(path.join(to, 'cli-fast.js'))).toBe(NEW_FAST)
    expect(read(path.join(to, 'data', 'skills', 'walnut-trigger', 'SKILL.md'))).toBe('new skill\n')
    expect(read(path.join(to, 'data', '\u7b14\u8bb0.md'))).toBe('unicode\n')
    expect(read(path.join(to, 'build-info.json'))).toContain('"new"')
    // Outside web/static nothing is deleted, the way a `clean: false` build leaves it.
    expect(read(path.join(to, 'tools-V7WAW7MY.js'))).toContain('old chunk')
    // The two entries are the last two writes, after every file they could load.
    expect(order.slice(-2).sort()).toEqual(['cli-fast.js', 'cli.js'])
    expect(order.slice(0, -2)).not.toContain('cli.js')
    expect(pruned.length).toBeGreaterThan(0)
  })

  it('moves the bytecode with its entry: the old one gone before the entries land, the new one after them', () => {
    const { from, to } = fixture()
    write(path.join(from, 'cli-fast.js.jsc'), 'new bytecode')
    write(path.join(to, 'cli-fast.js.jsc'), 'old bytecode')
    const oldBytecode: Record<string, boolean> = {}
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      const rel = path.relative(to, String(dst))
      if (rel === 'cli-fast.js' || rel === 'cli.js') oldBytecode[rel] = fs.existsSync(path.join(to, 'cli-fast.js.jsc'))
      return rename(src, dst)
    })
    const { order } = publishDist(from, to, NO_PROBE)
    expect(oldBytecode).toEqual({ 'cli.js': false, 'cli-fast.js': false })
    expect(order.at(-1)).toBe('cli-fast.js.jsc')
    expect(order.slice(-3, -1).sort()).toEqual(['cli-fast.js', 'cli.js'])
    expect(read(path.join(to, 'cli-fast.js.jsc'))).toBe('new bytecode')
  })

  it('drops the bytecode of the entry it replaces when the build has none (an older build going back)', () => {
    const { from, to } = fixture()
    write(path.join(to, 'cli-fast.js.jsc'), 'bytecode of a newer build')
    publishDist(from, to, NO_PROBE)
    expect(fs.existsSync(path.join(to, 'cli-fast.js.jsc'))).toBe(false)
    expect(read(path.join(to, 'cli-fast.js'))).toBe(NEW_FAST)
  })

  it('mirrors web/static and data exactly, as a build empties both first', () => {
    const { from, to } = fixture()
    publishDist(from, to, NO_PROBE)
    expect(fs.existsSync(path.join(to, 'data', 'skills', 'retired-skill'))).toBe(false)
    expect(read(path.join(to, 'data', 'skills', 'walnut-trigger', 'SKILL.md'))).toBe('new skill\n')
    expect(read(path.join(to, 'web', 'static', 'index.html'))).toContain('index-new.js')
    expect(fs.existsSync(path.join(to, 'web', 'static', 'assets', 'index-new.js'))).toBe(true)
    expect(fs.existsSync(path.join(to, 'web', 'static', 'assets', 'index-old.js'))).toBe(false)
    expect(fs.existsSync(path.join(to, 'web', 'static', 'old-dir'))).toBe(false)
  })

  it('keeps file modes and replaces links and type changes', () => {
    const { from, to } = fixture()
    fs.symlinkSync('daemon-binaries/daemon-darwin-arm64', path.join(from, 'daemon-latest'))
    // The checkout has a directory where the build has a file, and a file where it has a directory.
    write(path.join(to, 'build-info.json', 'stray'), 'x')
    write(path.join(to, 'daemon-binaries'), 'a file in the way')
    publishDist(from, to, NO_PROBE)
    expect(fs.statSync(path.join(to, 'daemon-binaries', 'daemon-darwin-arm64')).mode & 0o777).toBe(0o755)
    expect(fs.readlinkSync(path.join(to, 'daemon-latest'))).toBe('daemon-binaries/daemon-darwin-arm64')
    expect(read(path.join(to, 'build-info.json'))).toContain('"new"')
  })

  it('leaves no temp files behind and is the same on a second run', () => {
    const { from, to } = fixture()
    publishDist(from, to, NO_PROBE)
    const once = fs.readdirSync(to, { recursive: true }).map(String).sort()
    publishDist(from, to, NO_PROBE)
    const twice = fs.readdirSync(to, { recursive: true }).map(String).sort()
    expect(twice).toEqual(once)
    expect(once.filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('leaves build-binary staging out: it is not part of what the CLI runs', () => {
    // The compiled-file deploy publishes the dist the file was built from, which
    // also holds dist/binary-stage (the runtime tree, sidecars, the archive).
    const { from, to } = fixture()
    write(path.join(from, 'binary-stage', 'assets.wna'), 'archive')
    write(path.join(from, 'binary-stage', 'root', 'dist', 'cli.js'), 'placeholder')
    const { order } = publishDist(from, to, NO_PROBE)
    expect(fs.existsSync(path.join(to, 'binary-stage'))).toBe(false)
    expect(order.some((rel) => rel.startsWith('binary-stage'))).toBe(false)
    expect(read(path.join(to, 'cli.js'))).toBe('new cli\n')
  })

  it('creates dist when the checkout has none', () => {
    const { from, to } = fixture()
    fs.rmSync(to, { recursive: true, force: true })
    publishDist(from, to, NO_PROBE)
    expect(read(path.join(to, 'cli-fast.js'))).toBe(NEW_FAST)
  })

  it('refuses an unfinished build, a non-checkout target and a copy onto itself, writing nothing', () => {
    const { from, to, root } = fixture()
    fs.writeFileSync(path.join(from, 'cli-fast.js'), '')
    expect(() => publishDist(from, to)).toThrow(/missing or empty/)
    expect(read(path.join(to, 'cli.js'))).toBe('old cli\n')
    fs.writeFileSync(path.join(from, 'cli-fast.js'), NEW_FAST)
    expect(() => publishDist(from, path.join(root, 'nowhere', 'dist'))).toThrow(/not a checkout/)
    expect(() => publishDist(from, from)).toThrow(/onto itself/)
  })

  it('publishes nothing when the new CLI does not run, so the old one stays', () => {
    const { from, to } = fixture()
    const before = fs.readdirSync(to, { recursive: true }).map(String).sort()
    fs.writeFileSync(path.join(from, 'cli-fast.js'), "throw new Error('a module failed to load')\n")
    expect(() => publishDist(from, to)).toThrow(/the new CLI does not run \(probed twice\), so it is not published: .*--version failed \(exit 1\): .*a module failed to load/)
    // It answers --version, but its data commands do not work.
    fs.writeFileSync(path.join(from, 'cli-fast.js'), "if (process.argv[2] === '--version') console.log('9.9.9')\nelse process.exit(3)\n")
    expect(() => publishDist(from, to)).toThrow(/tools list failed \(exit 3\)/)
    expect(read(path.join(to, 'cli-fast.js'))).toBe('old fast\n')
    expect(read(path.join(to, 'cli.js'))).toBe('old cli\n')
    expect(fs.readdirSync(to, { recursive: true }).map(String).sort()).toEqual(before)
  })

  it('probes once more before refusing: the build probed the same files seconds before', () => {
    const { from, to } = fixture()
    const calls: string[] = []
    const flaky = (file: string) => {
      calls.push(file)
      if (calls.length === 1) throw new Error('--version failed (spawnSync bun ETIMEDOUT)')
      return { version: '9.9.9', fromBytecode: true }
    }
    const { probeRetried } = publishDist(from, to, { probe: flaky })
    expect(calls).toEqual([path.join(from, 'cli-fast.js'), path.join(from, 'cli-fast.js')])
    expect(probeRetried).toMatch(/ETIMEDOUT/)
    expect(read(path.join(to, 'cli-fast.js'))).toBe(NEW_FAST)

    const again = fixture()
    let tries = 0
    const broken = () => { tries++; throw new Error('tools call task_get failed (exit 70)') }
    expect(() => publishDist(again.from, again.to, { probe: broken })).toThrow(/probed twice\), so it is not published: tools call task_get failed \(exit 70\)/)
    expect(tries).toBe(2)
    expect(read(path.join(again.to, 'cli-fast.js'))).toBe('old fast\n')
    const third = fixture()
    expect(publishDist(third.from, third.to, { probe: () => null }).probeRetried).toBe(null)
  })

  it('runs as a command and reports what it did; a failure exits non-zero', () => {
    const { from, to } = fixture()
    const ok = spawnSync(process.execPath, [SCRIPT, from, to], { encoding: 'utf-8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/^Published the serving build to .*: \d+ files, \d+ stale files removed/)
    const bad = spawnSync(process.execPath, [SCRIPT, path.join(from, 'nope'), to], { encoding: 'utf-8' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/missing or empty/)
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' }).status).toBe(2)
  })
})

describe('dev-prod.sh publishes the serving build', () => {
  const at = (s: string) => DEV_PROD.indexOf(s)
  const call = '"$JS_BIN" "$REPO_ROOT/scripts/publish-serve-root-dist.mjs" "$publish_from" "$publish_to"'

  it('only for a deploy from a clone, from the build that passed every check, before the success stamp', () => {
    expect(at(call)).toBeGreaterThan(0)
    const guard = DEV_PROD.lastIndexOf('if [[ "$SERVE_ROOT" != "$REPO_ROOT" ]]; then', at(call))
    expect(guard).toBeGreaterThan(0)
    expect(at(call) - guard).toBeLessThan(700)
    // The compiled file is all a deploy serves: it publishes the dist it was built from.
    const pick = DEV_PROD.slice(guard, at(call))
    expect(pick).toContain('publish_from="$REPO_ROOT/dist"')
    expect(pick).not.toContain('$STAGE_DIR/dist"')
    // Into this checkout, except in a rehearsal, which writes only into its own dirs.
    expect(pick).toContain('publish_to="$SERVE_ROOT/dist"')
    expect(pick).toMatch(/if \[\[ "\$REHEARSAL" == "1" \]\]; then[\s\S]*publish_to="\$TMPDIR\/rehearsal-serve-root\/dist"/)
    expect(at(call)).toBeGreaterThan(at('if ! snapshot_lkg; then'))
    expect(at(call)).toBeGreaterThan(at('Live render FAILED'))
    expect(at(call)).toBeLessThan(at('date +%s > "$SUCCESS_STAMP"'))
  })

  it('never fails the deploy', () => {
    expect(DEV_PROD).toContain(`if ! ${call}; then`)
    const after = DEV_PROD.slice(at(call), at('date +%s > "$SUCCESS_STAMP"'))
    expect(after).not.toMatch(/\bexit\b|rollback_to_lkg|stop_new_server/)
  })

  // The script's own tail, from the publish to its last line, run in bash with
  // the real publish script: a clone (REPO_ROOT) whose dist is the new build, and
  // the checkout (SERVE_ROOT) the CLI runs from.
  function deployTail(newFast: string) {
    const { root, from, to, checkout } = fixture()
    const clone = path.join(root, 'stage')
    for (const f of ['publish-serve-root-dist.mjs', 'cli-fast-probe.mjs']) {
      write(path.join(clone, 'scripts', f), read(path.join(import.meta.dirname, '..', '..', 'scripts', f)))
    }
    fs.writeFileSync(path.join(from, 'cli-fast.js'), newFast)
    const tail = DEV_PROD.slice(at('CLI_NOT_PUBLISHED=""'))
    expect(tail.length).toBeLessThan(3000)
    const r = spawnSync('bash', ['-c', `set -euo pipefail\nlistener_pids() { echo 4242; }\n${tail}`], {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH, SERVE_ROOT: checkout, REPO_ROOT: clone, REHEARSAL: '0', TMPDIR: root,
        JS_BIN: process.execPath, SUCCESS_STAMP: path.join(root, 'stamp'), RUNTIME_DESC: 'test',
      },
    })
    return { ...r, to }
  }

  it('a CLI it could not publish ends the deploy\'s output, loudly; the old one stays', () => {
    const bad = deployTail("throw new Error('a module failed to load')\n")
    expect(bad.status, bad.stderr).toBe(0)
    const last = bad.stdout.trim().split('\n').at(-1)
    expect(last).toMatch(new RegExp(`^Deploy incomplete: the server runs the new build, but the walnut CLI in ${bad.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was NOT updated`))
    expect(bad.stderr).toMatch(/probed twice\), so it is not published/)
    expect(read(path.join(bad.to, 'cli-fast.js'))).toBe('old fast\n')

    const good = deployTail(NEW_FAST)
    expect(good.status, good.stderr).toBe(0)
    expect(good.stdout.trim().split('\n').at(-1)).toBe('Server ready (PID: 4242, test)')
    expect(good.stdout).not.toContain('Deploy incomplete')
    expect(read(path.join(good.to, 'cli-fast.js'))).toBe(NEW_FAST)
  })
})
