/**
 * scripts/dev-ephemeral.sh with a compiled file (`--file <path>`): the file's
 * runtime trees go to $TMPDIR/walnut-ephemeral-runtime, never the data home,
 * and the launcher prunes old ones there (the file prunes nothing under
 * WALNUT_RUNTIME_DIR). A stand-in "file" reports what it was started with.
 * Without --file it builds dist/ and runs it on bun; a stand-in bun records that.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard-core.js'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-ephemeral.sh')
const BUN_PIN = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { packageManager: string }).packageManager.replace(/^bun@/, '')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ephemeral-')))
  dirs.push(root)
  const file = path.join(root, 'walnut-test')
  fs.writeFileSync(file, '#!/bin/sh\nprintf "RUNTIME=%s ARGS=%s BUN_BE_BUN=%s\\n" "$WALNUT_RUNTIME_DIR" "$*" "${BUN_BE_BUN-unset}"\n', { mode: 0o755 })
  const tmpdir = path.join(root, 'tmp')
  fs.mkdirSync(tmpdir)
  return { root, file, tmpdir, trees: path.join(tmpdir, 'walnut-ephemeral-runtime') }
}

function launch(file: string, tmpdir: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, '--file', file], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: tmpdir, ...extra } })
}

describe('dev-ephemeral.sh --file', () => {
  it('runs the file as an ephemeral server with its runtime trees in TMPDIR', () => {
    const s = setup()
    // BUN_BE_BUN=1 would make the file run as the bun CLI: it is dropped.
    const r = launch(s.file, s.tmpdir, { BUN_BE_BUN: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(`RUNTIME=${s.trees} ARGS=web --ephemeral BUN_BE_BUN=unset`)
  })

  it('keeps the newest trees and any from the last day, and prunes the rest', () => {
    const s = setup()
    fs.mkdirSync(s.trees, { recursive: true })
    const day = 86_400_000
    // Oldest first: four from days ago, then two from the last hour.
    const made: Array<[string, number]> = [
      ['0.6.10-aaaaaaaaaaaa', 9], ['0.6.11-bbbbbbbbbbbb', 8], ['0.6.12-cccccccccccc', 7], ['0.6.13-dddddddddddd', 6],
      ['0.6.14-eeeeeeeeeeee', 0.02], ['0.6.14-ffffffffffff', 0.01],
    ]
    for (const [name, daysAgo] of made) {
      const d = path.join(s.trees, name)
      fs.mkdirSync(path.join(d, 'dist'), { recursive: true })
      const t = new Date(Date.now() - daysAgo * day)
      fs.utimesSync(d, t, t)
    }
    const r = launch(s.file, s.tmpdir)
    expect(r.status, r.stderr).toBe(0)
    // Newest three kept (two recent, the newest old one); older ones go.
    expect(fs.readdirSync(s.trees).sort()).toEqual(['0.6.13-dddddddddddd', '0.6.14-eeeeeeeeeeee', '0.6.14-ffffffffffff'])
  })

  it('never prunes a tree from the last day, however many there are', () => {
    const s = setup()
    fs.mkdirSync(s.trees, { recursive: true })
    for (let i = 0; i < 5; i++) {
      const d = path.join(s.trees, `0.6.14-recent${i}`)
      fs.mkdirSync(d)
      const t = new Date(Date.now() - (5 - i) * 60_000)
      fs.utimesSync(d, t, t)
    }
    const r = launch(s.file, s.tmpdir, { WALNUT_EPHEMERAL_KEEP_TREES: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readdirSync(s.trees)).toHaveLength(5)
  })

  it('refuses a path that is not an executable file', () => {
    const s = setup()
    const r = launch(path.join(s.root, 'missing'), s.tmpdir)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/is not an executable walnut file/)
  })
})

describe('dev-ephemeral.sh source build', () => {
  /**
   * Stand-ins: a bun of the pinned version (scripts/lib/find-bun.sh asks it) that
   * records every other call, and a node that fails loudly if anything runs it.
   */
  function tools() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ephemeral-src-')))
    dirs.push(root)
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const log = path.join(root, 'calls.log')
    fs.writeFileSync(path.join(bin, 'bun'), `#!/bin/sh\n[ "$1" = --version ] && { echo ${BUN_PIN}; exit 0; }\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho "node ran: $*" >&2\nexit 99\n', { mode: 0o755 })
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    return { root, bin, log, home }
  }

  it('builds with bun (build tools on bun too) and runs dist/cli.js on bun, never on node', () => {
    const t = tools()
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf-8', env: { PATH: guardedPath([t.bin], '/usr/bin:/bin'), HOME: t.home, TMPDIR: t.root } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toMatch(/node ran/)
    expect(fs.readFileSync(t.log, 'utf-8').trim().split('\n')).toEqual(['--bun run web:build', 'dist/cli.js web --ephemeral'])
  })

  it('takes WALNUT_BUN first, and names bun when there is none', () => {
    const t = tools()
    const pinned = path.join(t.root, 'pinned-bun')
    fs.copyFileSync(path.join(t.bin, 'bun'), pinned)
    fs.chmodSync(pinned, 0o755)
    fs.rmSync(path.join(t.bin, 'bun'))
    const ok = spawnSync('bash', [SCRIPT], { encoding: 'utf-8', env: { PATH: guardedPath([t.bin], '/usr/bin:/bin'), HOME: t.home, TMPDIR: t.root, WALNUT_BUN: pinned } })
    expect(ok.status, ok.stderr).toBe(0)
    expect(fs.readFileSync(t.log, 'utf-8')).toContain('dist/cli.js web --ephemeral')
    const none = spawnSync('bash', [SCRIPT], { encoding: 'utf-8', env: { PATH: guardedPath([t.bin], '/usr/bin:/bin'), HOME: t.home, TMPDIR: t.root } })
    // Only when no bun sits in the fixed install places of this machine either.
    if (!['/opt/homebrew/bin/bun', '/usr/local/bin/bun'].some((p) => fs.existsSync(p))) {
      expect(none.status).toBe(1)
      expect(none.stderr).toMatch(/needs bun .* or newer .*none was found .*curl -fsSL https:\/\/bun\.sh\/install \| bash/)
      expect(none.stderr).not.toMatch(/node ran/)
    }
  })
})
