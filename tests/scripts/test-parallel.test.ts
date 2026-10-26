/**
 * scripts/test-parallel.mjs (`bun run test`, documented as everything) runs the
 * tiers CI runs: quick, slow, e2e, then the frontend script that runs all four
 * web-rooted configs. Until 2026-10-24 it ran unit + integration + e2e + three
 * frontend configs and so missed 201 files CI runs and the notes-roundtrip config.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('bun run test', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-parallel.mjs'), '--list'], { cwd: ROOT, encoding: 'utf-8' })

  it('runs quick, slow, e2e and the frontend script, in that order', () => {
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([
      { name: 'quick', args: ['run', '--config', 'vitest.quick.config.ts'] },
      { name: 'slow', args: ['run', '--config', 'vitest.slow.config.ts'] },
      { name: 'e2e', args: ['run', '--config', 'vitest.e2e.config.ts'] },
      { name: 'frontend', script: 'scripts/test-frontend.mjs' },
    ])
  })

  it('names the same frontend script CI runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts['test:frontend:ci']).toBe('bun scripts/test-frontend.mjs')
    expect(pkg.scripts.test).toBe('bun scripts/test-parallel.mjs')
  })
})
