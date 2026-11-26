/**
 * A phone UI test scrolls a list toward an element through the closed-loop helpers in
 * ios-native/WalnutUITests/ListScroll.swift (`revealInList`, `scrollList`), not a loop of fixed
 * swipes or drags of its own.
 *
 * How far a swipe or a drag carries a list is the simulator's to decide: on a loaded one a 70 pt
 * drag held at its end carried the Routines list 120 to 240 pt, so a loop of such drags toward a
 * 100 pt window jumped over it both ways until it gave up, and the test measured a row parked
 * under the navigation bar (2026-11-17, lane B: testTappedRowStaysPutUnderATallOpenRow failed 3 of
 * 3; CI's twelve swipes went past routines.row.r-acme-1 the same day). The class: a `while` or
 * `for-in` loop whose body swipes (`swipeUp(`, `swipeDown(`) or drags (`thenDragTo`). The files
 * that still have such loops are counted below; a count may only fall. Not seen: a
 * `repeat { } while` loop, sideways swipes, and a gesture inside a local helper the loop calls.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const UI_TESTS = path.resolve(__dirname, '../../ios-native/WalnutUITests')
const HELPER = 'ListScroll.swift'

/** Loops with a gesture inside, per file, as of the guard's start (2026-11-18). Only falls. */
const KNOWN: Record<string, number> = {
  'AgentTextLinksFixture.swift': 2,
  'BoardOrderParityUITests.swift': 2,
  'ClickedPathUITests.swift': 3,
  'CodeBlockUITests.swift': 1,
  'DemoModeUITests.swift': 10,
  'InboxItemActionsUITests.swift': 2,
  'InboxTaskNavigationUITests.swift': 2,
  'LetterReplyDeliveryUITests.swift': 1,
  'LetterReplyUITests.swift': 4,
  'ModelPillHealUITests.swift': 3,
  'PeerMessageUITests.swift': 12,
  'QuickQuestionRenameUITests.swift': 3,
  // The Edit sheet's drag above the keyboard to its check field (no list band to aim at there).
  'RoutinesUITests.swift': 1,
  'SendOnceUITests.swift': 2,
  'SessionChangesUITests.swift': 3,
  'TalkRealServerUITests.swift': 2,
  'TalkShortcutUITests.swift': 1,
  'TalkToWalnutUITests.swift': 8,
  'TaskAnchorTapUITests.swift': 3,
  'TasksDrawerUITests.swift': 5,
  'ThreadPushLiveUITests.swift': 1,
  'ThreadPushNavigationUITests.swift': 2,
  'ThreadPushR3ClaudeReviewUITests.swift': 1,
  'ThreadPushStatesUITests.swift': 3,
  'ThreadPushUITestCase.swift': 1,
  'VoiceDictationUITests.swift': 1,
  'VoiceHistoryUITests.swift': 2,
  'WorkCardUITests.swift': 1,
}

const LOOP = /\b(?:while\b|for\b[^{\n]*\bin\b)[^{\n]*\{/g
const GESTURE = /\.swipe(?:Up|Down)\(|thenDragTo/

function body(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i)
  }
  return src.slice(open)
}

/** How many loops in one Swift source swipe or drag inside their body. */
export function gestureLoops(src: string): number {
  let n = 0
  for (const m of src.matchAll(LOOP)) if (GESTURE.test(body(src, m.index! + m[0].length - 1))) n++
  return n
}

const files = fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))
const read = (f: string) => fs.readFileSync(path.join(UI_TESTS, f), 'utf8')

describe('iOS UI tests: a list is scrolled toward an element by the closed-loop helper', () => {
  it('counts loops that swipe or drag, and leaves single gestures and helper calls', () => {
    expect(gestureLoops('while !row.isHittable, n < 12 {\n    app.swipeUp()\n    n += 1\n}')).toBe(1)
    expect(gestureLoops('for _ in 0..<8 where !x.exists {\n  a.press(forDuration: 0.05, thenDragTo: b)\n}')).toBe(1)
    expect(gestureLoops('for i in 1...3 {\n  if i > 1 { app.swipeDown(velocity: .slow) }\n}')).toBe(1)
    expect(gestureLoops('app.swipeUp()\nwhile n < 3 { n += 1 }')).toBe(0)
    expect(gestureLoops('for _ in 0..<5 {\n  revealInList(app, row)\n}')).toBe(0)
  })

  it('no file gains a loop of swipes or drags, and a file that lost some says so here', () => {
    const now = Object.fromEntries(
      files.filter((f) => f !== HELPER).map((f) => [f, gestureLoops(read(f))] as const).filter(([, n]) => n > 0),
    )
    const grew = Object.entries(now).filter(([f, n]) => n > (KNOWN[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${KNOWN[f] ?? 0}`)
    expect(grew, 'scroll toward an element with revealInList or scrollList (WalnutUITests/ListScroll.swift)').toEqual([])
    const fell = Object.entries(KNOWN).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${now[f] ?? 0} < ${n}`)
    expect(fell, 'lower these counts in KNOWN').toEqual([])
  })

  it('the helpers are defined once, in the shared file', () => {
    for (const fn of ['revealInList', 'scrollList', 'dragList', 'listBand', 'distanceIntoBand']) {
      const defs = files.filter((f) => new RegExp(`func ${fn}\\(`).test(read(f)))
      expect(defs, fn).toEqual([HELPER])
    }
  })
})
