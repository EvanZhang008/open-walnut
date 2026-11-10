/**
 * Every place that widens the chat's render window leaves the live end first, or is a state
 * the follow cut stands down for. A window that follows the bottom is cut back to the default
 * tail (render-window.ts `follow`), so a widening that keeps `isAtBottom` true is undone in the
 * same pass: the row it widened for is never drawn (2026-11-10 review: a restored reading place
 * looped widen/cut until React's update depth limit, and a click in the user messages list
 * jumped nowhere).
 *
 * The scan lists each widening call (`setTruncationOffset(<not 0>)`, `widenWindow(`) and needs
 * `isAtBottom.current = false` in the 14 lines before it, or a reason below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../../web/src/components/sessions')

/** A widening that needs no `isAtBottom = false`, keyed by text on its own line, with why. */
const EXEMPT: Record<string, string> = {
  'setTruncationOffset((t) => (count > t ? count : t))': 'the widenWindow definition; its caller (useReadingPlace) leaves the live end',
  'setTruncationOffset(messages.length - start + added)': 'an older page landing: reached after Load earlier or a jump (both leave the live end) or a reading-place restore (held)',
  'setTruncationOffset(messages.length - earliest)': 'the review pane holds the window (reviewHoldsWindow excludes the follow cut)',
}
/** Lines inside the question pages effect (stackMode excludes the follow cut). */
const STACK_MODE_MARK = 'if (!stackMode) return;'

describe('render window widenings', () => {
  it('each one leaves the live end first or names why it need not', () => {
    const offenders: string[] = []
    let sites = 0
    for (const file of fs.readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        const widens = (/setTruncationOffset\(/.test(line) && !/setTruncationOffset\(0\)/.test(line)) || /\bwidenWindow\(/.test(line)
        if (!widens || /^\s*(\/\/|\*)/.test(line) || /widenWindow\??:|const widenWindow|widenWindow: /.test(line)) return
        sites++
        const before = lines.slice(Math.max(0, i - 14), i + 1).join('\n')
        if (/isAtBottom\.current = false/.test(before)) return
        if (Object.keys(EXEMPT).some((k) => line.includes(k))) return
        if (lines.slice(Math.max(0, i - 14), i).some((l) => l.includes(STACK_MODE_MARK))) return
        offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(sites).toBeGreaterThanOrEqual(7)
    expect(offenders, 'set isAtBottom.current = false before widening, or add the site to EXEMPT with why').toEqual([])
  })
})
