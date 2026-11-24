/**
 * A UI runner (ios-native/tests/ui/run-*.sh) hands its test values to run-ui-tests.sh as
 * WALNUT_UITEST_* variables, and the test runner process never sees the shell's environment: a
 * variable reaches the test only when run-ui-tests.sh writes it into the .xctestrun (or reads it
 * itself). 2026-11-24: the private-tasks runner set WALNUT_UITEST_HELD_TASK, the injection list
 * lacked it, and the held-task test skipped on lane B ("no fixture task id") while the run read as
 * passed. Every name a runner sets must be one run-ui-tests.sh knows.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(import.meta.dirname, '../../ios-native/tests/ui')
const RUN_UI = fs.readFileSync(path.join(DIR, 'run-ui-tests.sh'), 'utf-8')

/** The WALNUT_UITEST_* names a runner assigns (NAME=... on a line or an export). */
function namesSetBy(file: string): string[] {
  const text = fs.readFileSync(path.join(DIR, file), 'utf-8')
  return [...new Set([...text.matchAll(/\b(WALNUT_UITEST_[A-Z0-9_]+)=/g)].map((m) => m[1]!))]
}

const runners = fs.readdirSync(DIR).filter((f) => /^run-.*\.sh$/.test(f) && f !== 'run-ui-tests.sh'
  && fs.readFileSync(path.join(DIR, f), 'utf-8').includes('run-ui-tests.sh'))

describe('every WALNUT_UITEST_* value a UI runner sets reaches the test', () => {
  it('finds the runners it guards (the private tasks walk among them)', () => {
    expect(runners).toContain('run-private-tasks-ui.sh')
  })

  it.each(runners)('%s: each name it sets is one run-ui-tests.sh reads or injects', (file) => {
    const missing = namesSetBy(file).filter((n) => !new RegExp(`\\b${n}\\b`).test(RUN_UI))
    expect(missing, `add these to run-ui-tests.sh's .xctestrun injection list: ${missing.join(', ')}`).toEqual([])
  })

  it('the private tasks walk hands all three fixture task ids on', () => {
    expect(namesSetBy('run-private-tasks-ui.sh')).toEqual(expect.arrayContaining([
      'WALNUT_UITEST_SYNCED_TASK', 'WALNUT_UITEST_KEPT_TASK', 'WALNUT_UITEST_HELD_TASK',
    ]))
  })
})
