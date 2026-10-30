/**
 * Until a session's history has had its first server answer, the chat draws no
 * stream block: the rows shown (a cached copy, or none) may stop short of the
 * newest turn while the stream snapshot already holds its reply, which then sat
 * under the turn before with its question missing (2026-10-30: every reload
 * within a second or two of a reply).
 *
 * The hold is rendering only. The reset gate must keep reading what history
 * ABSORBED, or a held block would count as absorbed and be dropped for good.
 * So every render site in SessionChatHistory reads `shownHiddenBlocks`, and the
 * ratchet below fails when a new line reads `hiddenBlocks` outside the few
 * non-rendering uses listed here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { withFirstCheckHold, allBlocksAbsorbed, turnQuestionShown } from '@/stream/render-filter'
import type { SessionHistoryMessage } from '@/types/session'

describe('withFirstCheckHold', () => {
  it('hides every block while holding', () => {
    expect([...withFirstCheckHold(3, new Set([1]), true)].sort()).toEqual([0, 1, 2])
  })

  it('is the absorbed set itself when not holding', () => {
    const hidden = new Set([0, 2])
    expect(withFirstCheckHold(3, hidden, false)).toBe(hidden)
  })

  it('is the absorbed set itself when everything is absorbed already', () => {
    const hidden = new Set([0, 1])
    expect(withFirstCheckHold(2, hidden, true)).toBe(hidden)
  })

  it('the held set must never reach the reset gate: it would read as all absorbed', () => {
    const blocks = [{ type: 'text' as const, content: 'a' }, { type: 'text' as const, content: 'b' }]
    const hidden = new Set<number>()
    const shown = withFirstCheckHold(blocks.length, hidden, true)
    // Fed the held set, the gate would drop two blocks history never absorbed.
    expect(allBlocksAbsorbed(blocks, shown, false)).toBe(true)
    expect(allBlocksAbsorbed(blocks, hidden, false)).toBe(false)
  })
})

describe('turnQuestionShown', () => {
  const row = (role: SessionHistoryMessage['role'], text = 'x') => ({ role, text }) as SessionHistoryMessage

  it('no rows: the question is not shown', () => {
    expect(turnQuestionShown([], 0)).toBe(false)
  })

  it('rows ending with the previous reply: the new turn\'s question is missing', () => {
    expect(turnQuestionShown([row('user'), row('assistant')], 0)).toBe(false)
  })

  it('rows ending with a user row (a cache written mid-turn): shown', () => {
    expect(turnQuestionShown([row('user'), row('assistant'), row('user')], 0)).toBe(true)
  })

  it('system rows after the question do not hide it', () => {
    expect(turnQuestionShown([row('assistant'), row('user'), row('system')], 0)).toBe(true)
  })

  it('a bubble (a send, the launch prompt) stands for the question', () => {
    expect(turnQuestionShown([row('assistant')], 1)).toBe(true)
  })
})

describe('ratchet: render sites read the held set', () => {
  const file = path.resolve(__dirname, '../../../web/src/components/sessions/SessionChatHistory.tsx')
  const lines = fs.readFileSync(file, 'utf8').split('\n')

  // Non-rendering readers of what history absorbed, each with its reason.
  const ALLOWED: { pattern: RegExp; why: string }[] = [
    { pattern: /const hiddenBlocks = useSelectionFrozenWith\(/, why: 'the definition' },
    { pattern: /withFirstCheckHold\(blocks\.length, hiddenBlocks,/, why: 'the held set is built from it' },
    { pattern: /\[blocks\.length, hiddenBlocks, holdForFirstCheck\]/, why: 'its memo deps' },
    { pattern: /hidden: hiddenBlocks\.has\(i\)/, why: 'tripwire evidence: what history absorbed' },
    { pattern: /allBlocksAbsorbed\(blocks, hiddenBlocks, isStreaming\)/, why: 'the reset gate must never see held blocks' },
    { pattern: /resetIfAbsorbed\(hiddenBlocks\.size\)/, why: 'the reset gate' },
    { pattern: /\[blocks, hiddenBlocks, isStreaming, resetIfAbsorbed\]/, why: 'the reset gate deps' },
    { pattern: /hidden: hiddenBlocks\.size, trunc:/, why: 'scroll forensics' },
  ]

  it('every read of hiddenBlocks is one of the listed non-rendering uses', () => {
    const offenders: string[] = []
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      if (!/\bhiddenBlocks\b/.test(code)) return
      if (!ALLOWED.some((a) => a.pattern.test(code))) offenders.push(`${i + 1}: ${line.trim()}`)
    })
    expect(offenders, 'a render site must read shownHiddenBlocks (held for the first check), not hiddenBlocks').toEqual([])
  })

  it('the reset gate reads what history absorbed, never the held set', () => {
    const text = lines.join('\n')
    expect(text).toMatch(/allBlocksAbsorbed\(blocks, hiddenBlocks, isStreaming\)/)
    expect(text).toMatch(/resetIfAbsorbed\(hiddenBlocks\.size\)/)
    expect(text).not.toMatch(/allBlocksAbsorbed\([^)]*shownHiddenBlocks/)
    expect(text).not.toMatch(/resetIfAbsorbed\(shownHiddenBlocks/)
  })

  it('the hold applies only while the question is missing, and ends for good once a block was shown', () => {
    const text = lines.join('\n')
    expect(text).toMatch(/const holdForFirstCheck = firstCheckPending && firstCheckHoldOverFor !== sessionId\s+&& !turnQuestionShown\(loadedMessages,/)
    expect(text).toMatch(/if \(!holdForFirstCheck && firstCheckPending && blocks\.length > 0 && firstCheckHoldOverFor !== sessionId\) \{\s+setFirstCheckHoldOverFor\(sessionId\);/)
  })

  it('the render sites read shownHiddenBlocks', () => {
    const text = lines.join('\n')
    expect(text).toMatch(/buildTimeline\([^)]*shownHiddenBlocks\)/)
    expect(text).toMatch(/groupStreamingBlocks\(blocks, shownHiddenBlocks\)/)
    expect(text).toMatch(/countStreamChars\(blocks, shownHiddenBlocks\)/)
  })
})
