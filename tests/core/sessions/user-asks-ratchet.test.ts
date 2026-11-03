/**
 * Every path that files the user's chat words files them for every task, not only an Org node's
 * (2026-11-03: his question in a worker's chat was in no record but the transcript, and two
 * compactions dropped it). Enumerated from the source: a file that plans an Org node's thread
 * (prepareThreadCapture) must also plan the ask for any other task (prepareUserAskCapture, directly
 * or through hint-send's captureUserAsk), so a new send path that files threads alone fails here.
 * The turn-end status question must keep judging the asks, and the compaction readback must keep
 * reading them first.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('the user\'s words are kept for every task', () => {
  it('every file that files a thread for an Org node also files the ask for any other task', () => {
    const callers = walk(SRC).filter((f) => !f.endsWith(path.join('org', 'thread-capture.ts')))
      .filter((f) => /prepareThreadCapture\(/.test(fs.readFileSync(f, 'utf8')))
    expect(callers.length).toBeGreaterThanOrEqual(2)
    for (const f of callers) {
      const src = fs.readFileSync(f, 'utf8')
      expect(/prepareUserAskCapture\(|captureUserAsk\(/.test(src), `${path.relative(SRC, f)} files threads but not the user asks of other tasks`).toBe(true)
    }
  })

  it('the turn-end status question judges them, and the compaction readback reads them first', () => {
    const question = fs.readFileSync(path.join(SRC, 'core/sessions/status-question.ts'), 'utf8')
    expect(question).toMatch(/owedQuestionFor\(/)
    expect(question).toMatch(/applyOwedAnswer\(/)
    const open = fs.readFileSync(path.join(SRC, 'core/sessions/open-items.ts'), 'utf8')
    expect(open).toMatch(/owedReadbackFor\(/)
    expect(open).toMatch(/const head = \(text: string\) => \[owed, /)
    const stop = fs.readFileSync(path.join(SRC, 'web/routes/api-v1.ts'), 'utf8')
    expect(stop).toMatch(/owedAtStop\(sid\)/)
  })
})
