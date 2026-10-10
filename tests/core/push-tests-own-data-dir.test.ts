/**
 * Every test file that drives the push sender owns its data dir.
 *
 * The sender checks each row against this box's auth.json right before it
 * sends (core/push/paired-rows.ts). A file without its own data dir shares the
 * worker's test home with every file that ran before it in that worker, so an
 * auth.json another file left there decides whether its pushes are sent: the
 * quick tier failed 10 of 12 tests in push-notification-lane.test.ts, depending
 * on file order alone. Own data dir = `vi.mock` of src/constants.js (the
 * createMockConstants helper), or OPEN_WALNUT_HOME set by the file itself.
 *
 * "Drives the sender" = imports push-notification, push/letter-push or
 * push/deliver without mocking that module.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const TESTS = path.resolve(import.meta.dirname, '..')
const SENDERS = ['push-notification', 'push/letter-push', 'push/deliver']
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : testFiles(p)
    return e.name.endsWith('.test.ts') ? [p] : []
  })
}

function drivesSender(src: string): boolean {
  return SENDERS.some((m) => {
    const spec = `(?:\\.\\./)+src/core/${esc(m)}\\.js`
    const imported = new RegExp(`(?:from\\s+|import\\(\\s*)['"]${spec}['"]`).test(src)
    const mocked = new RegExp(`vi\\.mock\\(\\s*['"]${spec}['"]`).test(src)
    return imported && !mocked
  })
}

function ownsDataDir(src: string): boolean {
  return /vi\.mock\(\s*['"](?:\.\.\/)+src\/constants\.js['"]/.test(src)
    || /process\.env\.OPEN_WALNUT_HOME\s*=/.test(src)
}

describe('push tests own their data dir', () => {
  it('finds the push tests (the scan itself works)', () => {
    const found = testFiles(TESTS).filter((f) => drivesSender(fs.readFileSync(f, 'utf-8')))
    expect(found.map((f) => path.relative(TESTS, f))).toContain(path.join('core', 'push-notification-lane.test.ts'))
  })

  it('none of them runs in the worker\'s shared home', () => {
    const offenders = testFiles(TESTS)
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf-8')
        return drivesSender(src) && !ownsDataDir(src)
      })
      .map((f) => path.relative(TESTS, f))
    expect(offenders).toEqual([])
  })
})
