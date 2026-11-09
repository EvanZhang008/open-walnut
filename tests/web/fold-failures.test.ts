/**
 * A fold's "N failed" counts failed calls, so it never exceeds the calls the fold ran; the runtime's
 * error lines are counted apart, "N errors" (2026-11-09: a Codex session's fold read "Ran 344 tools ·
 * 7859 failed", 7,835 of them error lines of a steering retry loop).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countFoldFailures, foldFailureWords } from '../../web/src/components/sessions/fold-rows'

type Tool = { name: string; isError?: boolean }
const call = (isError = false): Tool => ({ name: 'Bash', ...(isError ? { isError: true } : {}) })
const failed = (t: Tool) => !!t.isError

describe('a fold\'s failure count', () => {
  it('never counts more failed calls than calls, whatever error lines it holds', () => {
    const rows = [
      { row: { role: 'assistant', tools: [call(), call(true), call()] }, toolsShown: true },
      ...Array.from({ length: 50 }, () => ({ row: { role: 'system', systemVariant: 'error' }, toolsShown: true })),
      { row: { role: 'assistant', tools: [call(true)] }, toolsShown: true },
      { row: { role: 'system', systemVariant: 'info' }, toolsShown: true },
    ]
    const f = countFoldFailures<Tool>(rows, failed)
    const ran = rows.reduce((n, r) => n + ((r.row as { tools?: Tool[] }).tools?.length ?? 0), 0)
    expect(f).toEqual({ calls: 2, errors: 50 })
    expect(f.calls).toBeLessThanOrEqual(ran)
    expect(foldFailureWords(f)).toBe('2 failed · 50 errors')
  })

  it('a row whose calls are not shown adds no failed call', () => {
    expect(countFoldFailures<Tool>([{ row: { role: 'assistant', tools: [call(true)] }, toolsShown: false }], failed)).toEqual({ calls: 0, errors: 0 })
  })

  it('words', () => {
    expect(foldFailureWords(0)).toBe('')
    expect(foldFailureWords(3)).toBe('3 failed')
    expect(foldFailureWords({ calls: 0, errors: 1 })).toBe('1 error')
    expect(foldFailureWords({ calls: 1, errors: 2 })).toBe('1 failed · 2 errors')
  })

  it('every fold header takes its count from the one rule', () => {
    const dir = path.join(__dirname, '..', '..', 'web', 'src', 'components', 'sessions')
    const chat = fs.readFileSync(path.join(dir, 'SessionChatHistory.tsx'), 'utf8')
    // No hand count that adds error lines to failed calls again.
    expect(chat).not.toMatch(/systemVariant === 'error'\) failed\+\+/)
    expect(chat).toMatch(/const failedOf = \(parts: readonly HistoryPart\[\]\): FoldFailures => countFoldFailures\(/)
    const folds = fs.readFileSync(path.join(dir, 'TurnFolds.tsx'), 'utf8')
    expect(folds).toContain('foldFailureWords(failed)')
    expect(folds).not.toMatch(/\{failed\} failed/)
  })
})
