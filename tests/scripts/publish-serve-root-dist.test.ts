/**
 * scripts/publish-serve-root-dist.mjs: after a deploy from a clean clone, the
 * build that serves is copied into the checkout's dist/, because the `walnut`
 * CLI runs the op registry from that bundle (2026-10-05: sessions read op text
 * two deploys old). Pinned here on throwaway trees; nothing real is touched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { publishDist } from '../../scripts/publish-serve-root-dist.mjs'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'publish-serve-root-dist.mjs')
const DEV_PROD = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh'), 'utf-8')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

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
  write(path.join(from, 'cli-fast.js'), 'new fast\n')
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

describe('publishDist', () => {
  it('copies the build over the checkout dist, entries last, keeping files the build lacks', () => {
    const { from, to } = fixture()
    const { order, pruned } = publishDist(from, to)
    expect(read(path.join(to, 'cli.js'))).toBe('new cli\n')
    expect(read(path.join(to, 'cli-fast.js'))).toBe('new fast\n')
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

  it('mirrors web/static and data exactly, as a build empties both first', () => {
    const { from, to } = fixture()
    publishDist(from, to)
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
    publishDist(from, to)
    expect(fs.statSync(path.join(to, 'daemon-binaries', 'daemon-darwin-arm64')).mode & 0o777).toBe(0o755)
    expect(fs.readlinkSync(path.join(to, 'daemon-latest'))).toBe('daemon-binaries/daemon-darwin-arm64')
    expect(read(path.join(to, 'build-info.json'))).toContain('"new"')
  })

  it('leaves no temp files behind and is the same on a second run', () => {
    const { from, to } = fixture()
    publishDist(from, to)
    const once = fs.readdirSync(to, { recursive: true }).map(String).sort()
    publishDist(from, to)
    const twice = fs.readdirSync(to, { recursive: true }).map(String).sort()
    expect(twice).toEqual(once)
    expect(once.filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('creates dist when the checkout has none', () => {
    const { from, to } = fixture()
    fs.rmSync(to, { recursive: true, force: true })
    publishDist(from, to)
    expect(read(path.join(to, 'cli-fast.js'))).toBe('new fast\n')
  })

  it('refuses an unfinished build, a non-checkout target and a copy onto itself, writing nothing', () => {
    const { from, to, root } = fixture()
    fs.writeFileSync(path.join(from, 'cli-fast.js'), '')
    expect(() => publishDist(from, to)).toThrow(/missing or empty/)
    expect(read(path.join(to, 'cli.js'))).toBe('old cli\n')
    fs.writeFileSync(path.join(from, 'cli-fast.js'), 'new fast\n')
    expect(() => publishDist(from, path.join(root, 'nowhere', 'dist'))).toThrow(/not a checkout/)
    expect(() => publishDist(from, from)).toThrow(/onto itself/)
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
  const call = '"$NODE_BIN" "$REPO_ROOT/scripts/publish-serve-root-dist.mjs" "$STAGE_DIR/dist" "$SERVE_ROOT/dist"'

  it('only for a deploy from a clone, from the stage that passed every check, before the success stamp', () => {
    expect(at(call)).toBeGreaterThan(0)
    const guard = DEV_PROD.lastIndexOf('if [[ "$SERVE_ROOT" != "$REPO_ROOT" ]]; then', at(call))
    expect(guard).toBeGreaterThan(0)
    expect(at(call) - guard).toBeLessThan(200)
    expect(at(call)).toBeGreaterThan(at('if ! snapshot_lkg; then'))
    expect(at(call)).toBeGreaterThan(at('Live render FAILED'))
    expect(at(call)).toBeLessThan(at('date +%s > "$SUCCESS_STAMP"'))
  })

  it('never fails the deploy', () => {
    expect(DEV_PROD).toContain(`if ! ${call}; then`)
    const after = DEV_PROD.slice(at(call), at('date +%s > "$SUCCESS_STAMP"'))
    expect(after).not.toMatch(/\bexit\b|rollback_to_lkg|stop_new_server/)
  })
})
