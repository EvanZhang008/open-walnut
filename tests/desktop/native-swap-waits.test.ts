/**
 * A swap of the Mac app's page (desktop/main.swift recyclePopout, recycleWebContent) is not
 * done when the call returns: since fc4efa8be it first empties the old page in its own process
 * and builds the new web view only once that process gave its graphics back. A native test that
 * reads the window's web view right after the call reads the old one (2026-11-22, Nightly extra
 * tests 45035328727: popout-window-tests.swift's `recycled !== oldChild` precondition trapped).
 * Enumerated from the source: every native test statement that asks for a swap waits for the
 * new view before its next line.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SWAP_CALL = /^\s*(?:\w+\??\.)?(recyclePopout|recycleWebContent)\(/
const swiftTests = execFileSync('git', ['ls-files', 'tests/desktop/*.swift'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
const calls = swiftTests.flatMap((f) => {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
  return lines.flatMap((l, i) => {
    if (!SWAP_CALL.test(l)) return []
    const next = lines.slice(i + 1).find((n) => n.trim() && !n.trim().startsWith('//')) ?? ''
    return [{ at: `${f}:${i + 1}`, next: next.trim() }]
  })
})

describe('a native test that swaps the app page waits for the new web view', () => {
  it('finds the swaps the native tests ask for', () => {
    expect(calls.map((c) => c.at)).toEqual(expect.arrayContaining([expect.stringMatching(/^tests\/desktop\/popout-window-tests\.swift:\d+$/)]))
  })

  it('the swap is asynchronous in the app, so the guard has something to hold', () => {
    const main = fs.readFileSync(path.join(ROOT, 'desktop/main.swift'), 'utf8')
    const body = main.slice(main.indexOf('func recyclePopout('), main.indexOf('private func replacePopout('))
    expect(body).toContain('WebContentProcess.emptyInPlace(')
  })

  it.each(calls)('$at waits before it reads the window', ({ at, next }) => {
    expect(next, `${at}: the swap ends later; wait for the window's new web view first`).toMatch(/\bwait\s*\{/)
  })
})
