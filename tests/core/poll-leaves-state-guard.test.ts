/**
 * A poll waits for the state the work ends in, never only for leaving the state it starts in.
 *
 * `expect.poll(() => view.phase).not.toBe('error')` passes the moment the work STARTS (the next
 * phase is 'installing', not the 'running' it ends in), so whatever the test does next races the
 * work still on its way. On 2026-11-08 a Mac land's full quick run failed
 * tests/core/host-server-manager.test.ts this way: the test set the next SSH refusal while the
 * retry it had waited for was still uploading, and that retry took it. Polling for the end state
 * ('running') waits for the work itself.
 *
 * The guard reads every vitest file (*.test.ts) and fails on a poll or waitFor of a lifecycle
 * field (phase, state, status) whose condition is "not this one value". A legitimate one (that
 * value really is the only thing that may not show) goes in ALLOWED with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')

/** `file:line` → why waiting for "not this literal" is the real condition there. */
const ALLOWED: Record<string, string> = {}

// One statement on one line: the value polled is a lifecycle field (phase, state, status) and the
// condition is "not <a non-empty literal>": waiting for a value to appear (not '') or to change colour is a real end
// condition and is left alone.
const POLL_NOT_LITERAL = /expect\.poll\([^;\n]{0,300}?\.(?:phase|state|status)\b[^;\n]{0,200}?\)\s*\.not\.toBe\(\s*(['"`])[^'"`]+\1/g
const WAITFOR_NOT_LITERAL = /vi\.waitFor\(\s*(?:async\s*)?\(\)\s*=>\s*\{?\s*expect\([^;\n]{0,300}?\.(?:phase|state|status)\b[^;\n]{0,200}?\)\s*\.not\.toBe\(\s*(['"`])[^'"`]+\1/g

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

describe('a poll waits for the end state of the work', () => {
  it('no vitest poll or waitFor waits only for a lifecycle field to leave one value', () => {
    const found: string[] = []
    for (const file of testFiles(path.join(REPO, 'tests'))) {
      if (file === import.meta.filename) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const re of [POLL_NOT_LITERAL, WAITFOR_NOT_LITERAL]) {
        for (const m of text.matchAll(re)) {
          const at = `${path.relative(REPO, file)}:${lineOf(text, m.index! + m[0].length)}`
          if (!ALLOWED[at]) found.push(at)
        }
      }
    }
    expect(found, 'poll for the state the work ends in (e.g. toBe(\'running\')), not for leaving the one it started in').toEqual([])
  })

  it('the patterns catch the shape this guard exists for', () => {
    const sample = "await expect.poll(() => m.view('devbox').phase, { timeout: 5_000 }).not.toBe('error')"
    expect([...sample.matchAll(POLL_NOT_LITERAL)]).toHaveLength(1)
    const sample2 = "await vi.waitFor(() => { expect(view().phase).not.toBe('error') })"
    expect([...sample2.matchAll(WAITFOR_NOT_LITERAL)]).toHaveLength(1)
    // A value appearing (not null, not ''), or moving off a recorded variable, is a real end condition.
    expect([..."await expect.poll(() => wire.fireExists).not.toBeNull()".matchAll(POLL_NOT_LITERAL)]).toHaveLength(0)
    expect([..."await expect.poll(() => t.turn_ended_at).not.toBe(endedBefore)".matchAll(POLL_NOT_LITERAL)]).toHaveLength(0)
    expect([..."await expect.poll(() => row.state).not.toBe('')".matchAll(POLL_NOT_LITERAL)]).toHaveLength(0)
    expect([..."await expect.poll(() => el.color).not.toBe('rgba(0, 0, 0, 0)')".matchAll(POLL_NOT_LITERAL)]).toHaveLength(0)
  })
})
