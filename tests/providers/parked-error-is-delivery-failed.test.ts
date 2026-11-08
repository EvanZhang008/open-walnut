/**
 * A session error about a message that waits in the queue (parked for a Retry) is a
 * delivery failure, never a turn's outcome (review round 2, should-fix 8).
 *
 * The runner's turn-end handler (claude-code-session.ts, SESSION_RESULT / SESSION_ERROR)
 * writes the record `error` and clears the task's session slot for any SESSION_ERROR
 * that is not errorKind 'delivery_failed'. A start refused because Claude Code was not
 * installed parked its first line and emitted a plain error, so the session read as
 * ended in an error while its message waited for the Retry that would run it.
 *
 * Guard: every SESSION_ERROR emit in src/ that says `parked: true` also says
 * `errorKind: 'delivery_failed'`, so a new park path cannot repeat it. The full
 * flow (park, install, Retry, the turn runs on the same session) is
 * tests/e2e/claude-missing-retry-e2e.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : [])

/** The argument text of each `bus.emit(EventNames.SESSION_ERROR, ...)` call (balanced parentheses). */
function sessionErrorEmits(text: string): Array<{ at: number; args: string }> {
  const out: Array<{ at: number; args: string }> = []
  const re = /bus\.emit\(\s*EventNames\.SESSION_ERROR\s*,/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
    }
    out.push({ at: m.index, args: text.slice(m.index + m[0].length, i) })
  }
  return out
}

describe('guard: a parked message\'s session error is a delivery failure', () => {
  it('every SESSION_ERROR emit with parked: true carries errorKind delivery_failed', () => {
    let parkedEmits = 0
    const bad: string[] = []
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const e of sessionErrorEmits(text)) {
        if (!/\bparked:\s*true\b/.test(e.args)) continue
        parkedEmits++
        if (!/errorKind:\s*'delivery_failed'/.test(e.args)) {
          bad.push(`${path.relative(SRC, file)}:${text.slice(0, e.at).split('\n').length}`)
        }
      }
    }
    // The queue's own parks and the refused start's first line, at least.
    expect(parkedEmits).toBeGreaterThanOrEqual(4)
    expect(bad).toEqual([])
  })
})
