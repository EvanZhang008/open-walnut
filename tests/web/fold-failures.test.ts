/**
 * A fold's "N failed" counts failed calls, so it never exceeds the calls the fold ran; the runtime's
 * error lines are counted apart, "N errors" (2026-11-09: a Codex session's fold read "Ran 344 tools ·
 * 7859 failed", 7,835 of them error lines of a steering retry loop).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countFoldFailures, foldFailureWords } from '../../web/src/components/sessions/fold-rows'
import { isFailedCall } from '../../web/src/components/sessions/tool-run-phrase'
import { BASH_PERSISTED, MCP_MANY_LINES, MCP_NO_LINE_COUNT, MCP_ONE_LINE, READ_TOO_BIG_BLOCK } from './fixtures/too-long-answers'

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

  // 2026-11-21: "Ran 1 tool · 2 failed" over a host_list and a thread_update that worked: their
  // answers were too long, so the CLI saved each to a file and told the model "Error: result ...".
  it('an answer saved to a file for being too long is not a failed call; the Read refusing a big file is', () => {
    type Call = { name: string; result?: string; isError?: boolean }
    const rows = [
      { row: { role: 'assistant', tools: [
        { name: 'mcp__walnut__host_list', result: MCP_ONE_LINE },
        { name: 'mcp__walnut__thread_update', result: MCP_NO_LINE_COUNT, isError: true },
        { name: 'mcp__walnut__board_get', result: MCP_MANY_LINES },
        { name: 'Bash', result: BASH_PERSISTED },
        { name: 'Read', result: READ_TOO_BIG_BLOCK, isError: true },
      ] as Call[] }, toolsShown: true },
    ]
    expect(countFoldFailures<Call>(rows, isFailedCall)).toEqual({ calls: 1, errors: 0 })
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

  // The five counts of failed calls (the fold's, the live tail's, three merged-run lines) each
  // wrote "errored and not routed and not denied" by hand, and drifted: the run lines forgot the
  // rule's no, and none knew a too-long answer. One rule now, isFailedCall (tool-run-phrase.ts);
  // a new hand-written filter fails here.
  it('no count writes its own failed filter: each one calls isFailedCall', () => {
    const web = path.join(__dirname, '..', '..', 'web', 'src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(web)
    // The one place a classifier may be negated for another rule than "failed", and why.
    const allowed: Record<string, { count: number; why: string }> = {
      'components/sessions/session-outbound.ts': { count: 1, why: 'the card\'s error line: a denied send still says it did not go, so it is not isFailedCall' },
    }
    const negated = /!\s*(?:isRoutedQuestion|isUserDenied|isRuleDenied|tooLongAnswer)\(/g
    const found: Record<string, number> = {}
    for (const f of files) {
      const rel = path.relative(web, f).split(path.sep).join('/')
      if (rel === 'components/sessions/tool-run-phrase.ts') continue
      const n = (fs.readFileSync(f, 'utf8').match(negated) ?? []).length
      if (n) found[rel] = n
    }
    expect(found, 'call isFailedCall (tool-run-phrase.ts) instead of a hand-written failed filter')
      .toEqual(Object.fromEntries(Object.entries(allowed).map(([f, a]) => [f, a.count])))
    const chat = fs.readFileSync(path.join(web, 'components', 'sessions', 'SessionChatHistory.tsx'), 'utf8')
    expect(chat).toMatch(/\.filter\(\(b\) => b\.type === 'tool_call' && isFailedCall\(b\)\)/)
    expect(chat).toMatch(/countFoldFailures\([\s\S]{0,200}?\n\s*isFailedCall,\n/)
    const msg = fs.readFileSync(path.join(web, 'components', 'sessions', 'SessionMessage.tsx'), 'utf8')
    expect((msg.match(/\.filter\(isFailedCall\)/g) ?? []).length).toBe(4)
  })
})
