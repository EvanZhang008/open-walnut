/**
 * The checkout's CLI entry (bin/open-walnut.js, package.json `bin`) runs on bun:
 * Walnut's SQLite is bun:sqlite and its terminal bun's pty. Started on Node
 * (`node bin/open-walnut.js`, an old global link), it says so at once and
 * exits 1, before it loads any of dist/, instead of failing at the first
 * database open with an error that names no runtime.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('bin/open-walnut.js runs on bun', () => {
  it('both bin files start with a bun shebang', () => {
    for (const file of ['bin/open-walnut.js', 'bin/walnut.js']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[0], file).toBe('#!/usr/bin/env bun')
    }
  })

  it('on a runtime that is not bun, it names bun and exits 1 without loading dist/', () => {
    // This process is bun; without process.versions.bun the entry sees what Node would show it.
    const bin = path.join(ROOT, 'bin/open-walnut.js')
    const r = spawnSync(process.execPath, ['-e', `delete process.versions.bun; await import(${JSON.stringify(bin)})`, 'tasks', '--json'], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Walnut runs on bun')
    expect(r.stderr).toContain('curl -fsSL https://bun.sh/install | bash')
    expect(r.stderr).not.toContain('cannot load')
    expect(r.stdout).toBe('')
  })
})
