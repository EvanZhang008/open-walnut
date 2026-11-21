/**
 * scripts/pain-guards.mjs: the guard tests a pain registry names are checked and run, and each one's
 * result is what really happened: passed, gone (no_file), renamed (no_test), a browser spec CI runs.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..', '..')

describe('pain-guards', () => {
  it('reads each named test as passed, no_file, no_test or ci_only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pain-guards-test-'))
    const registry = path.join(dir, 'pains.json')
    const out = path.join(dir, 'out.json')
    const entry = (id: string, file: string, name: string) => ({ id, title: id, test: { file, name } })
    fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, entries: [
      entry('pn-pass', 'tests/fixtures/pain-guards/sample.test.ts', 'passes for the guard runner'),
      entry('pn-gone', 'tests/fixtures/pain-guards/missing.test.ts', 'anything'),
      entry('pn-renamed', 'tests/fixtures/pain-guards/sample.test.ts', 'a title nobody wrote'),
      entry('pn-helper', 'tests/helpers/mock-constants.ts', 'not a test'),
      entry('pn-spec', 'tests/e2e/browser/drawing-composer.spec.ts', 'draw, edit, export, theme, reopen, change elsewhere, conflict and attach'),
      entry('pn-spec-gone', 'tests/e2e/browser/drawing-composer.spec.ts', 'this spec title does not exist'),
      { id: 'pn-none', title: 'no test named' },
    ] }))
    const run = spawnSync('bun', ['scripts/pain-guards.mjs', '--registry', registry, '--out', out], { cwd: root, encoding: 'utf-8', timeout: 180_000 })
    expect(run.status, run.stderr).toBe(0)
    const results = JSON.parse(fs.readFileSync(out, 'utf-8')).results
    expect(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, (v as { result: string }).result]))).toEqual({
      'pn-pass': 'passed', 'pn-gone': 'no_file', 'pn-renamed': 'no_test', 'pn-helper': 'no_test', 'pn-spec': 'ci_only', 'pn-spec-gone': 'no_test',
    })
    fs.rmSync(dir, { recursive: true, force: true })
  }, 200_000)
})
