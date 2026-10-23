/**
 * scripts/dev-ephemeral.sh with a compiled file (`--file <path>`): the file's
 * runtime trees go to $TMPDIR/walnut-ephemeral-runtime, never the data home,
 * and the launcher prunes old ones there (the file prunes nothing under
 * WALNUT_RUNTIME_DIR). A stand-in "file" reports what it was started with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-ephemeral.sh')

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
