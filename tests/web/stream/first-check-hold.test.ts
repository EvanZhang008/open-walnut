/**
 * Until a session's history has had its first server answer, the chat keeps the
 * stream off screen while the rows shown lack the stream turn's question: those
 * rows (a cached copy, or none) may stop short of the newest turn while the
 * stream snapshot already holds its reply, which then sat under the turn before
 * with its question missing (2026-10-30: every reload within a second or two of
 * a reply). A finished turn waits for that answer (a busy server took 8 to 12 s),
 * a live turn's own blocks at most 3 s, a pending permission card not at all, and
 * a drawn block stays drawn.
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
import { withFirstCheckHold, allBlocksAbsorbed, turnQuestionShown, firstCheckHeldBelow } from '@/stream/render-filter'
import type { SessionHistoryMessage } from '@/types/session'

type HoldState = Omit<Parameters<typeof firstCheckHeldBelow>[0], 'shownFrom'>
const state = (s: Partial<HoldState>): HoldState => ({
  pending: true, questionShown: false, blockCount: 1, streaming: false, liveOver: false, completedLen: 1, actionAt: -1, ...s,
})
/** Feed renders in order the way SessionChatHistory does: after each one, the
 *  lowest index drawn while the first answer is pending is remembered. */
function renders(steps: HoldState[]): number[] {
  let shownFrom: number | null = null
  return steps.map((st) => {
    const held = firstCheckHeldBelow({ ...st, shownFrom })
    if (st.pending && held < st.blockCount && (shownFrom === null || held < shownFrom)) shownFrom = held
    return held
  })
}

describe('firstCheckHeldBelow', () => {
  it('holds a finished turn while the first answer is pending and its question is missing', () => {
    expect(renders([state({ blockCount: 2, completedLen: 2 })])).toEqual([2])
  })

  it('keeps holding a finished turn past the live wait: its rows are on their way', () => {
    expect(renders([state({ blockCount: 2, completedLen: 2, liveOver: true })])).toEqual([2])
  })

  it('holds a live turn only until the live wait is over', () => {
    expect(renders([
      state({ streaming: true, blockCount: 2, completedLen: 0 }),
      state({ streaming: true, blockCount: 3, completedLen: 0, liveOver: true }),
    ])).toEqual([2, 0])
  })

  it('live output shown after the live wait stays shown when its turn ends before the answer', () => {
    expect(renders([
      state({ streaming: true, blockCount: 2, completedLen: 0 }),
      state({ streaming: true, blockCount: 3, completedLen: 0, liveOver: true }),
      state({ streaming: false, blockCount: 3, completedLen: 3, liveOver: true }),
    ])).toEqual([2, 0, 0])
  })

  it('a live turn that ends inside the live wait stays held: nothing was shown, so nothing vanishes', () => {
    expect(renders([
      state({ streaming: true, blockCount: 2, completedLen: 0 }),
      state({ streaming: false, blockCount: 2, completedLen: 2 }),
    ])).toEqual([2, 2])
  })

  it('a new turn during a finished hold shows its own blocks, the finished reply still waits for its question', () => {
    expect(renders([
      state({ blockCount: 1, completedLen: 1 }),
      state({ streaming: true, liveOver: true, blockCount: 2, completedLen: 1 }),
      state({ streaming: true, liveOver: true, blockCount: 3, completedLen: 1 }),
      // That turn ends: its blocks are finished now, and stay drawn.
      state({ streaming: false, liveOver: true, blockCount: 3, completedLen: 3 }),
    ])).toEqual([1, 1, 1, 1])
  })

  it('never holds a pending permission card or what follows it: it waits on the user', () => {
    expect(renders([state({ blockCount: 3, completedLen: 3, actionAt: 2 })])).toEqual([2])
    expect(renders([state({ blockCount: 3, completedLen: 3, actionAt: 0 })])).toEqual([0])
  })

  it('never holds after the first answer, or when the question is shown', () => {
    expect(renders([state({ pending: false, blockCount: 2 })])).toEqual([0])
    expect(renders([state({ questionShown: true, blockCount: 2 })])).toEqual([0])
  })

  it('the longest wait (shownFrom 0) ends the hold', () => {
    expect(firstCheckHeldBelow({ ...state({ blockCount: 4, completedLen: 4 }), shownFrom: 0 })).toBe(0)
  })

  it('in any order of renders, a block once drawn is never held again', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let run = 0; run < 2000; run++) {
      let count = 0, completed = 0, streaming = false, liveOver = false, pending = true
      const steps: HoldState[] = []
      for (let k = 0; k < 12; k++) {
        const ev = rnd(6)
        if (ev === 0) { count += 1 + rnd(3); if (!streaming) completed = count }
        else if (ev === 1) streaming = true
        else if (ev === 2) { streaming = false; completed = count }
        else if (ev === 3) liveOver = true
        else if (ev === 4 && rnd(4) === 0) pending = false
        const act = rnd(5) === 0 && count > 0 ? rnd(count) : -1
        steps.push(state({ pending, blockCount: count, completedLen: completed, streaming, liveOver, actionAt: act }))
      }
      const held = renders(steps)
      let lowestDrawn = Infinity
      steps.forEach((st, k) => {
        expect(held[k], `run ${run} step ${k}`).toBeLessThanOrEqual(lowestDrawn)
        if (st.pending && held[k] < st.blockCount) lowestDrawn = Math.min(lowestDrawn, held[k])
      })
    }
  })
})

describe('withFirstCheckHold', () => {
  it('hides every block when all are held', () => {
    expect([...withFirstCheckHold(3, new Set([1]), 3)].sort()).toEqual([0, 1, 2])
  })

  it('hides the held prefix and keeps what history absorbed after it', () => {
    expect([...withFirstCheckHold(4, new Set([3]), 2)].sort()).toEqual([0, 1, 3])
  })

  it('is the absorbed set itself when nothing is held', () => {
    const hidden = new Set([0, 2])
    expect(withFirstCheckHold(3, hidden, 0)).toBe(hidden)
  })

  it('is the absorbed set itself when the held part is absorbed already', () => {
    const hidden = new Set([0, 1])
    expect(withFirstCheckHold(3, hidden, 2)).toBe(hidden)
  })

  it('the held set must never reach the reset gate: it would read as all absorbed', () => {
    const blocks = [{ type: 'text' as const, content: 'a' }, { type: 'text' as const, content: 'b' }]
    const hidden = new Set<number>()
    const shown = withFirstCheckHold(blocks.length, hidden, blocks.length)
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
    { pattern: /\[blocks\.length, hiddenBlocks, firstCheckHeld\]/, why: 'its memo deps' },
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

  it('the hold is firstCheckHeldBelow over the live state, and a drawn block stays drawn', () => {
    const text = lines.join('\n')
    expect(text).toMatch(/const firstCheckHeld = firstCheckHeldBelow\(\{\s+pending: firstCheckPending,\s+questionShown: turnQuestionShown\(loadedMessages,[^\n]*\n\s+blockCount: blocks\.length,\s+streaming: isStreaming,\s+liveOver: liveHoldOverFor === sessionId,\s+completedLen,\s+actionAt: firstCheckPending \? blocks\.findIndex\(isPendingPermissionBlock\) : -1,\s+shownFrom: firstCheckShownFrom,/)
    expect(text).toMatch(/if \(firstCheckPending && firstCheckHeld < blocks\.length\s+&& \(firstCheckShownFrom === null \|\| firstCheckHeld < firstCheckShownFrom\)\) \{\s+setFirstCheckShown\(\{ sid: sessionId, from: firstCheckHeld \}\);/)
  })

  it('the render sites read shownHiddenBlocks', () => {
    const text = lines.join('\n')
    expect(text).toMatch(/buildTimeline\([^)]*shownHiddenBlocks[,)]/)
    expect(text).toMatch(/groupStreamingBlocks\(blocks, shownHiddenBlocks\)/)
    expect(text).toMatch(/countStreamChars\(blocks, shownHiddenBlocks\)/)
  })
})
