/**
 * Every place a ClaudeCodeSession learns its CLI died goes through holdDeathForWrite.
 *
 * A death that reaches the session while the send that opened a new turn waits for
 * its answer must be judged after that answer: the line never reached the process
 * that died, and the resume the caller starts next answers it. Judged at once, the
 * death ended the new turn with a stand-in (a result made of the previous turn's text
 * or of nothing, or a session error) ahead of the real answer
 * (tests/e2e/session-send-finds-cli-dead.test.ts).
 *
 * The death handlers are handleRemoteProcessExit, handleQuietProcessExit and
 * handleProcessDeath. Each call of one of them must sit in a callback (a transport's
 * onExit, the liveness interval) that hands its judgement to holdDeathForWrite. A new
 * place that reports a death fails here until it does the same.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts')
const HANDLER_CALL = /\.(handleRemoteProcessExit|handleQuietProcessExit|handleProcessDeath)\(/
/** Where a death report enters: a transport's exit callback, or the liveness tick. */
const ENTRY = /\bonExit:\s*\(|setInterval\(/
/** A class member's start: a call before reaching an entry is in a method, not a callback. */
const MEMBER = /^ {2}(?:private |public |protected |static |async |get |set )*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(.*\)\s*(?::\s*[^=]+)?\{\s*$/

describe('death reports wait for the send that opened the turn', () => {
  const lines = fs.readFileSync(FILE, 'utf8').split('\n')
  const calls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => HANDLER_CALL.test(line) && !/^\s*(\/\/|\*)/.test(line))

  it('finds the call sites', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5)
  })

  for (const { line, i } of calls) {
    it(`line ${i + 1}: ${line.trim().slice(0, 80)}`, () => {
      let entry = -1
      for (let j = i; j >= 0 && i - j < 80; j--) {
        if (ENTRY.test(lines[j])) { entry = j; break }
        if (j < i && MEMBER.test(lines[j])) break
      }
      expect(entry, 'the call is in a death-report callback (onExit or the liveness tick), not elsewhere').toBeGreaterThanOrEqual(0)
      const callback = lines.slice(entry, Math.min(lines.length, i + 12)).join('\n')
      expect(callback, 'the callback hands its judgement to holdDeathForWrite').toMatch(/holdDeathForWrite\(/)
    })
  }
})
