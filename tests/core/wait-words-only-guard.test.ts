/**
 * Guard: a send that only asks a parked task for words (WORDS_ONLY_SOURCES in
 * src/core/task-wait-resume.ts) must also be an interruption (INTERRUPTING_SEND_SOURCES). A source
 * in the first list and not the second ends the wait for good: waitExitCause answers null and the
 * phase change drops the remembered wait, so its clock is lost, the opposite of what the first list
 * promises (2026-11-25 review: the thread check's source was in the first list only, and a waiting
 * VP woken by it lost its wait and wait_until). Both lists are read from the source, and each
 * words-only source is walked through the real rules: an interruption, and the wait with its clock
 * back at the turn end with no trigger to hold it.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-wait-words-only-guard'))

import { noteInterruptedWait, resetInterruptedWaitsForTest, resumableWait, waitExitCause } from '../../src/core/task-wait-resume.js'

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/core/task-wait-resume.ts'), 'utf8')

/** The string members of `const <name> ... = new Set([...])`, as written in the source. */
function setMembers(name: string): string[] {
  const m = new RegExp(`const ${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(SRC)
  if (!m) throw new Error(`${name} not found in task-wait-resume.ts`)
  const body = m[1].replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('a words-only send is an interruption, so the wait it interrupts comes back', () => {
  const wordsOnly = setMembers('WORDS_ONLY_SOURCES')
  const interrupting = setMembers('INTERRUPTING_SEND_SOURCES')

  it('both lists are read, and the thread check is a words-only interruption', () => {
    expect(wordsOnly.length).toBeGreaterThan(3)
    expect(interrupting.length).toBeGreaterThan(3)
    expect(wordsOnly).toContain('thread-audit')
  })

  it('every words-only source is in the interrupting list', () => {
    expect(wordsOnly.filter((s) => !interrupting.includes(s))).toEqual([])
  })

  it('each one interrupts and its wait comes back with its clock, with no trigger', async () => {
    const leftAt = '2026-11-25T10:00:00.000Z'
    for (const source of wordsOnly) {
      resetInterruptedWaitsForTest()
      expect(waitExitCause('session:input', source), source).toBe('message')
      noteInterruptedWait('lead-g', { waitUntil: '2026-11-25T15:00:00.000Z', leftAt, sessionId: 's-g', cause: 'message', source })
      expect(await resumableWait({ id: 'lead-g', phase: 'IN_PROGRESS', phase_changed_at: leftAt } as never, 's-g'), source)
        .toEqual({ waitUntil: '2026-11-25T15:00:00.000Z' })
    }
    resetInterruptedWaitsForTest()
  })
})
