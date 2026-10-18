/**
 * tests/setup/wp-ref-lint.mjs (WP14, section 12 of
 * docs/plan/walnut-replica-servers-impl.md): every WPn mention in the plan and in
 * the implementers' checklists names the package that owns the item. The real
 * plan must be clean; a small plan with planted mistakes must be caught, each
 * with its file:line, and the script must exit non-zero on them.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const LINT = path.join(ROOT, 'tests/setup/wp-ref-lint.mjs')

const PLAN = [
  '# A plan',
  '## 0. Facts',
  '| C1 | x | `src/a/one.ts:12` today | WP2 sends it |',
  'WP1 builds `src/a/one.ts` and `src/b/two.ts`.',
  'WP15 does nothing.',
  '## 9. Work packages',
  '| Step | Package | Note |',
  '|---|---|---|',
  '| 1 | WP1 | first |',
  '| 2 | WP2 (second) | |',
  '### WP1 First',
  '- Files: `src/a/one.ts`, `src/a/{three,four}.ts`, cap `acme-reads-v1`',
  '- Tests: `tests/a/one.test.ts` (new)',
  '### WP2 Second',
  '- Files: `src/b/two.ts`, `WALNUT_ACME_KNOB`',
  '- Tests: `tests/b/two.test.ts` (new)',
  '## 10. After',
  'WP2 adds `acme-reads-v1` and `src/a/four.ts`.',
  'WP1 adds `WALNUT_ACME_KNOB`.',
].join('\n')

function tmpPlan(): { dir: string; plan: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wplint-'))
  const plan = path.join(dir, 'plan.md')
  fs.writeFileSync(plan, PLAN)
  return { dir, plan }
}

describe('wp-ref-lint', () => {
  it('the real plan is clean', () => {
    const out = execFileSync(process.execPath, [LINT], { encoding: 'utf8' })
    expect(out).toMatch(/ 0 problem\(s\)/)
  })

  it('catches each planted mistake with its file and line, and exits 1', () => {
    const { dir, plan } = tmpPlan()
    try {
      const wp1 = path.join(dir, 'checklist-wp1.md')
      fs.writeFileSync(wp1, [
        'WP1 | a rule | tests/a/one.test.ts "pins it"',
        'WP2 | a rule of another package | tests/b/two.test.ts "x"',
        'WP1 | a rule pinned in a later package\'s test | tests/b/two.test.ts "y"',
      ].join('\n'))
      const wp2 = path.join(dir, 'checklist-wp2.md')
      fs.writeFileSync(wp2, 'WP2 | extends an earlier package\'s test | tests/a/one.test.ts "z"\n')
      const r = spawnSync(process.execPath, [LINT, '--plan', plan, wp1, wp2], { encoding: 'utf8', env: { ...process.env, WP_REF_LINT_NOTES: '1' } })
      expect(r.status).toBe(1)
      const out = r.stdout
      // Not a claim: a `path:line` citation of today's code.
      expect(out).not.toMatch(/plan\.md:3:/)
      expect(out).toMatch(/plan\.md:4: names WP1 for `src\/b\/two\.ts`, owned by WP2/)
      expect(out).toMatch(/plan\.md:5: WP15 is no package of section 9/)
      expect(out).toMatch(/plan\.md:18: names WP2 for `acme-reads-v1`, owned by WP1/)
      expect(out).toMatch(/plan\.md:18: names WP2 for `src\/a\/four\.ts`, owned by WP1/)
      expect(out).toMatch(/plan\.md:19: names WP1 for `WALNUT_ACME_KNOB`, owned by WP2/)
      expect(out).toMatch(/checklist-wp1\.md:2: a line of WP1's checklist names WP2/)
      expect(out).toMatch(/checklist-wp1\.md:3: WP1 names `tests\/b\/two\.test\.ts`, owned by WP2, all built after WP1/)
      expect(out).not.toMatch(/checklist-wp1\.md:1:/)
      // An earlier package's test, extended: a note, not a problem.
      expect(out).toMatch(/note: .*checklist-wp2\.md:1: WP2 names `tests\/a\/one\.test\.ts`/)
      expect(out).toMatch(/7 problem\(s\), 1 note\(s\)/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
