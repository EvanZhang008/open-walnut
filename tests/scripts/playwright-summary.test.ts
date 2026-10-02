/**
 * scripts/playwright-summary.mjs: a Playwright JSON report as CI's step summary,
 * with failing tests keyed `file :: describe › title` (nested describes kept,
 * the file-level suite dropped).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarize, testsOf } from '../../scripts/playwright-summary.mjs'

const REPORT = {
  stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 1 },
  suites: [
    {
      title: 'tasks.spec.ts',
      file: 'tasks.spec.ts',
      specs: [{ title: 'creates a task', file: 'tasks.spec.ts', tests: [{ status: 'expected' }] }],
      suites: [
        {
          title: 'drag and drop',
          file: 'tasks.spec.ts',
          specs: [
            { title: 'reorders', file: 'tasks.spec.ts', tests: [{ status: 'unexpected' }] },
            { title: 'moves to a folder', file: 'tasks.spec.ts', tests: [{ status: 'flaky' }] },
          ],
          suites: [{ title: 'nested', file: 'tasks.spec.ts', specs: [{ title: 'deep', file: 'tasks.spec.ts', tests: [{ status: 'skipped' }] }] }],
        },
      ],
    },
    { title: 'notes.spec.ts', file: 'notes.spec.ts', specs: [{ title: 'opens', file: 'notes.spec.ts', tests: [{ status: 'expected' }] }] },
  ],
}

describe('playwright-summary', () => {
  it('keys every test by file and describe path', () => {
    expect(testsOf(REPORT)).toEqual([
      { key: 'tasks.spec.ts :: creates a task', status: 'expected' },
      { key: 'tasks.spec.ts :: drag and drop › reorders', status: 'unexpected' },
      { key: 'tasks.spec.ts :: drag and drop › moves to a folder', status: 'flaky' },
      { key: 'tasks.spec.ts :: drag and drop › nested › deep', status: 'skipped' },
      { key: 'notes.spec.ts :: opens', status: 'expected' },
    ])
  })

  it('summarizes totals and lists failures and flakes', () => {
    const out = summarize(REPORT)
    expect(out).toContain('**5 tests:** 2 passed, 1 failed, 1 flaky (passed on a retry), 1 skipped')
    expect(out).toContain('- `tasks.spec.ts :: drag and drop › reorders`')
    expect(out).toContain('<summary>Flaky</summary>')
    expect(summarize({ suites: [] })).toBe('**0 tests:** 0 passed, 0 failed, 0 flaky (passed on a retry), 0 skipped\n')
  })

  it('leads with errors outside any test, the shape a spec that fails to load leaves', () => {
    // As CI saw it on 2026-10-02: one missing export, two specs importing it, 0 tests.
    const message = "SyntaxError: The requested module './threads-helpers' does not provide an export named 'nextQuestionNumber'"
    const out = summarize({ suites: [], errors: [{ message, location: null }, { message, location: null }] })
    expect(out.split('\n').slice(0, 3)).toEqual(['**The suite did not run cleanly:**', '', `- ${message} (×2)`])
    expect(out).toContain('**0 tests:**')
    expect(summarize(REPORT)).not.toContain('did not run cleanly')
  })

  it('runs as CI calls it, and --keys prints only the failures', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-summary-')), 'r.json')
    fs.writeFileSync(file, JSON.stringify(REPORT))
    const script = path.resolve(__dirname, '../../scripts/playwright-summary.mjs')
    expect(execFileSync(process.execPath, [script, file], { encoding: 'utf8' })).toContain('1 failed')
    expect(execFileSync(process.execPath, [script, file, '--keys'], { encoding: 'utf8' })).toBe('tasks.spec.ts :: drag and drop › reorders\n')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})
