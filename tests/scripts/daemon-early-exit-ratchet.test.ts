/**
 * Ratchet: a test's daemon boot reports an early exit through
 * tests/helpers/daemon-early-exit.ts, never with a bare error of its own.
 *
 * A bare `new Error('daemon exited early: ' + code)` hid why the daemon died
 * (CI run 41306376926: the daemon's stderr was discarded and its FATAL line sat
 * in a temp dir removed after the run). The helper puts the stderr tail and the
 * daemon log tail into the message.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const TESTS = path.resolve(__dirname, '..')
const PHRASE = /daemon exited early/i
// The helper builds the error, and its own test asserts on the words.
const ALLOWED = new Set([
  'helpers/daemon-early-exit.ts',
  'providers/daemon-early-exit-helper.test.ts',
  'scripts/daemon-early-exit-ratchet.test.ts',
])

function walk(dir: string, out: string[]): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(ent.name)) out.push(full)
  }
  return out
}

describe('daemon early-exit error ratchet', () => {
  it('no test file builds the "daemon exited early" error without the helper', () => {
    const offenders: string[] = []
    for (const file of walk(TESTS, [])) {
      const rel = path.relative(TESTS, file).split(path.sep).join('/')
      if (ALLOWED.has(rel)) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => { if (PHRASE.test(line)) offenders.push(`tests/${rel}:${i + 1}: ${line.trim()}`) })
    }
    expect(offenders, 'Use onDaemonEarlyExit(proc, { daemonDir }, fail) from tests/helpers/daemon-early-exit.ts instead:\n' + offenders.join('\n')).toEqual([])
  })

  it('the helper is used at the boot sites (the scan is not vacuous)', () => {
    const users = walk(TESTS, []).filter((f) => fs.readFileSync(f, 'utf8').includes('onDaemonEarlyExit('))
    expect(users.length).toBeGreaterThanOrEqual(50)
  })
})
