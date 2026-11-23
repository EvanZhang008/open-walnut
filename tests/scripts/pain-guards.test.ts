/**
 * scripts/pain-guards.mjs: the guard tests a pain registry names are checked and run, and each one's
 * result is what really happened: passed, gone (no_file), renamed (no_test), a browser spec CI runs.
 * The passing case runs tests/fixtures/pain-guards/sample.test.ts, which the quick tier runs too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..', '..')

describe('pain-guards', () => {
  it('reads each named test or describe block as passed, no_file, no_test or ci_only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pain-guards-test-'))
    const registry = path.join(dir, 'pains.json')
    const out = path.join(dir, 'out.json')
    const entry = (id: string, file: string, name: string) => ({ id, title: id, test: { file, name } })
    fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, entries: [
      entry('pn-pass', 'tests/fixtures/pain-guards/sample.test.ts', 'passes for the guard runner'),
      // A describe block's title names its tests (2026-11-23 audit: pn-23 read as no_test).
      entry('pn-block', 'tests/fixtures/pain-guards/sample.test.ts', 'pain guards fixture'),
      entry('pn-gone', 'tests/fixtures/pain-guards/missing.test.ts', 'anything'),
      entry('pn-renamed', 'tests/fixtures/pain-guards/sample.test.ts', 'a title nobody wrote'),
      entry('pn-helper', 'tests/helpers/mock-constants.ts', 'not a test'),
      { id: 'pn-none', title: 'no test named' },
    ] }))
    const run = spawnSync('bun', ['scripts/pain-guards.mjs', '--registry', registry, '--out', out], { cwd: root, encoding: 'utf-8', timeout: 180_000 })
    expect(run.status, run.stderr).toBe(0)
    const results = JSON.parse(fs.readFileSync(out, 'utf-8')).results
    expect(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, (v as { result: string }).result]))).toEqual({
      'pn-pass': 'passed', 'pn-block': 'passed', 'pn-gone': 'no_file', 'pn-renamed': 'no_test', 'pn-helper': 'no_test',
    })
    fs.rmSync(dir, { recursive: true, force: true })
  }, 200_000)

  it('leaves a browser spec to CI, and reads one with no such title as no_test (--root: another checkout)', () => {
    // The spec lives in a scratch checkout, so no test tier ever runs it as a test of this repo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pain-guards-spec-'))
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tests', 'pier.spec.ts'), "import { test } from '@playwright/test'\ntest('opens the pier page', async () => {})\n")
    const registry = path.join(dir, 'pains.json')
    const out = path.join(dir, 'out.json')
    fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, entries: [
      { id: 'pn-spec', title: 'x', test: { file: 'tests/pier.spec.ts', name: 'opens the pier page' } },
      { id: 'pn-spec-gone', title: 'x', test: { file: 'tests/pier.spec.ts', name: 'a title nobody wrote' } },
    ] }))
    const run = spawnSync('bun', ['scripts/pain-guards.mjs', '--registry', registry, '--out', out, '--root', dir], { cwd: root, encoding: 'utf-8', timeout: 60_000 })
    expect(run.status, run.stderr).toBe(0)
    const results = JSON.parse(fs.readFileSync(out, 'utf-8')).results
    expect(results['pn-spec'].result).toBe('ci_only')
    expect(results['pn-spec-gone'].result).toBe('no_test')
    fs.rmSync(dir, { recursive: true, force: true })
  }, 90_000)
})
