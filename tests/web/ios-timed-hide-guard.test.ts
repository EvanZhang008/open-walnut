/**
 * A thing the phone app takes off the screen by itself on a timer (a notice, an Undo offer, a run's
 * outcome, a tap-again window) waits through `NoticeTiming` (ios-native/Walnut/Core/NoticeTiming.swift),
 * which holds it at least 8 s in a UI-test launch of a debug build.
 *
 * On CI's slower simulator a tap returns only once the app is idle and each query takes 1 to 3 s, so
 * a UI test that has to find the thing and then tap or read it lost the race to a timer of 2.5 to
 * 5 s (2026-11-16 SessionChanges "Copy said nothing"; 2026-11-24 Routines "Ran just now", gone 4 s
 * after it showed, and the review's Undo, gone 5 s after a swipe, red in 8 of 8 main runs).
 *
 * The members are read from the source: under ios-native/Walnut, every wait (`Task.sleep`,
 * `asyncAfter`, a `DispatchWorkItem` it runs) of a second or more (a named length is read where the
 * file declares it; one declared elsewhere counts), whose
 * closure then takes something away (`x = nil`, `x = false`, `f(false)`). Each one either names
 * `NoticeTiming` in its wait or is in KNOWN with why it is not a passing thing a test must catch.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:\\.|[^"\\\n])*"/g, '""')

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

/** The index just past the `)` that closes the `(` at `open`. */
function pastParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return i + 1
  }
  return src.length
}

/** The rest of the closure that holds `from`, up to its closing brace. */
function restOfClosure(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth < 0) return src.slice(from, i)
  }
  return src.slice(from)
}

function closureAt(src: string, open: number): string {
  return restOfClosure(src, open + 1)
}

/** Seconds a wait's argument asks for, or null when it is a named value. */
export function literalSeconds(arg: string): number | null {
  const num = (s: string) => Number(s.replace(/_/g, ''))
  let m = /\.milliseconds\(\s*([\d_.]+)\s*\)/.exec(arg)
  if (m) return num(m[1]) / 1000
  m = /nanoseconds:\s*([\d_]+)\s*\)?\s*$/.exec(arg.trim().replace(/\)$/, ''))
  if (m) return num(m[1]) / 1e9
  m = /\.seconds\(\s*([\d_.]+)\s*\)/.exec(arg)
  if (m) return num(m[1])
  m = /\.now\(\)\s*\+\s*([\d_.]+)\s*(?:[,)]|$)/.exec(arg)
  if (m) return num(m[1])
  return null
}

const WAIT = /Task\.sleep\s*\(|asyncAfter\s*\(/g
const TAKE_AWAY = /(?<![=!<>])\b[A-Za-z_][\w.?]*(?:\[[^\]\n]*\])?\s*=\s*(?:nil|false)\b|\b\w+\(\s*false\s*\)/

export interface TimedHide { file: string; line: number; wait: string; takes: string }

/** Every timed take-away in one Swift source (comments and strings already blanked). */
/** Seconds a wait asks for, a named length declared in the same file (`static let tick: Duration =
 *  .milliseconds(100)`) read through; null when the length is not known from the source. */
export function waitSeconds(wait: string, src: string): number | null {
  const literal = literalSeconds(wait)
  if (literal !== null) return literal
  const name = /(?:for:|deadline:\s*\.now\(\)\s*\+|\.seconds\()\s*(?:Self\.|self\.)?(\w+)\s*\)*\s*$/.exec(wait.replace(/\)$/, ''))?.[1]
  if (!name) return null
  const decl = new RegExp(`\\b(?:let|var)\\s+${name}\\s*(?::\\s*[\\w.]+)?\\s*=\\s*([^\\n;]+)`).exec(src)?.[1]
  if (!decl) return null
  const named = literalSeconds(decl)
  if (named !== null) return named
  return /^\s*[\d_.]+\s*$/.test(decl) ? Number(decl.replace(/_/g, '')) : null
}

export function timedHides(file: string, src: string): TimedHide[] {
  const found: TimedHide[] = []
  for (const m of src.matchAll(WAIT)) {
    const argEnd = pastParen(src, m.index + m[0].length - 1)
    const wait = src.slice(m.index, argEnd)
    const seconds = waitSeconds(wait, src)
    if (seconds !== null && seconds < 1) continue
    let after = restOfClosure(src, argEnd)
    // `asyncAfter(deadline: ..., execute: reset)`: the work item named there is what runs.
    const item = /execute:\s*(\w+)\s*\)$/.exec(wait)?.[1]
    if (item) {
      const def = new RegExp(`\\b${item}\\s*=\\s*DispatchWorkItem\\s*(?:\\([^)]*\\))?\\s*\\{`).exec(src)
      if (def) after = closureAt(src, def.index + def[0].length - 1)
    } else if (/^asyncAfter/.test(wait)) {
      const open = src.indexOf('{', argEnd)
      if (open >= 0 && /^\s*$/.test(src.slice(argEnd, open))) after = closureAt(src, open)
    }
    const takes = TAKE_AWAY.exec(after)?.[0]
    if (!takes) continue
    found.push({ file, line: src.slice(0, m.index).split('\n').length, wait: wait.replace(/\s+/g, ' '), takes: takes.replace(/\s+/g, ' ') })
  }
  return found
}

/** Timed take-aways that are not a passing thing a UI test must catch, by file and what they clear. */
const KNOWN: { file: string; takes: string; why: string }[] = [
  { file: 'Stores/ChatStore.swift', takes: 'self.fileRetryTasks[bubbleID] = nil', why: 'a retry backoff forgets its own task' },
  { file: 'Stores/SessionConversationStore.swift', takes: 'self.retryTasks[bubbleID] = nil', why: 'a retry backoff forgets its own task' },
  { file: 'Stores/SessionConversationStore.swift', takes: 'self?.stopRequestedAt = nil', why: 'the Stop request times out; nothing on screen goes' },
  { file: 'Stores/FocusMusicPlayer.swift', takes: 'self.focusWatch = nil', why: 'the Focus watch ends with the block; nothing is shown' },
  { file: 'Views/Tasks/GlobalSearchModel.swift', takes: 'self.searching = false', why: 'a search debounce' },
  { file: 'Stores/SessionQueueModel.swift', takes: 'self.fadeTask = nil', why: 'wakes the badge to read its state again; the Delivered span is judged in updateSendStates and no UI test reads it' },
  { file: 'Views/Chat/ChatView.swift', takes: 'restoreWaitsForOpen = false', why: 'a launch restore stops waiting for a deep link; nothing on screen goes' },
  { file: 'Views/Chat/ComposerView.swift', takes: 'seatSettling = false', why: 'a stray-tap guard after the seat moves, not shown' },
  { file: 'Views/Chat/ComposerView.swift', takes: 'self.pending = nil', why: 'a settle wait, not shown' },
  { file: 'Views/Inbox/LetterThreadView.swift', takes: 'movingId = nil', why: 'ends a move animation' },
  { file: 'Views/Sessions/SessionConversationView.swift', takes: 'coveredUntilPage = false', why: 'the longest a cover hides an unpainted page; ending sooner is the point' },
  { file: 'Views/Org/OrgThreadsView.swift', takes: 'testMark = nil', why: 'the UI tests\' own reveal mark, already 8 s (testMarkSeconds)' },
  { file: 'Views/Org/OrgThreadsView.swift', takes: 'highlight = nil', why: 'a tint UI tests read through testMark; holding it longer would show under the next push\'s held sheet (expectHeld)' },
  { file: 'Views/Tasks/TasksView.swift', takes: 'highlightedTaskId = nil', why: 'a row tint, nothing to read or tap, no UI test reads it' },
  { file: 'Views/Sessions/FileSourceLinesView.swift', takes: 'flash = false', why: 'a line tint after a jump, nothing to read or tap' },
  { file: 'Timeline/TimelineTextCells.swift', takes: 'showCopied(false)', why: 'its Copied label is read by polling with no tap between, and CodeBlockUITests checks it comes back within 5 s' },
  { file: 'Timeline/TimelineHarnessView.swift', takes: 'self?.streaming = false', why: 'the debug timeline harness\'s scripted stream' },
  { file: 'Timeline/TimelineHarnessView.swift', takes: 'self.activity = nil', why: 'the debug timeline harness\'s scripted stream' },
]

const isKnown = (h: TimedHide) => KNOWN.some((k) => k.file === h.file && k.takes === h.takes)

describe('iOS: a thing taken off the screen on a timer waits through NoticeTiming', () => {
  const hides = swiftFiles(APP).flatMap((f) => timedHides(path.relative(APP, f), code(fs.readFileSync(f, 'utf8'))))

  it('finds the members it guards', () => {
    const where = hides.map((h) => `${h.file} ${h.takes}`)
    expect(where).toContain('Views/Settings/RoutinesView.swift runNotes[id] = nil')
    expect(where).toContain('Timeline/TimelineTextCells.swift showCopied(false)')
  })

  it('every timed take-away names NoticeTiming or says why it is not a passing thing', () => {
    const offenders = hides
      .filter((h) => !/NoticeTiming/.test(h.wait) && !isKnown(h))
      .map((h) => `${h.file}:${h.line} ${h.wait} -> ${h.takes}`)
    expect(offenders, 'wait with `NoticeTiming.after(seconds) { ... }` (or `NoticeTiming.seconds` in the sleep)').toEqual([])
  })

  it('KNOWN lists only take-aways that are still there', () => {
    const stale = KNOWN.filter((k) => !hides.some((h) => h.file === k.file && h.takes === k.takes))
    expect(stale.map((k) => `${k.file} ${k.takes}`)).toEqual([])
  })

  it('the members a UI test catches wait through NoticeTiming', () => {
    const src = (f: string) => code(fs.readFileSync(path.join(APP, f), 'utf8'))
    for (const f of [
      'Views/Sessions/Changes/DiffReviewViews.swift',
      'Views/Sessions/Changes/SessionFileDiffView.swift',
      'Views/Sessions/PermissionRequestCard.swift',
      'Stores/SessionQueueModel.swift',
      'Views/Chat/Camera/CameraCaptureModel.swift',
      'Markdown/MarkdownView.swift',
    ]) expect(src(f), f).toMatch(/NoticeTiming\.after\(/)
  })

  it('catches each kind of wait and take-away, and leaves short and unrelated waits', () => {
    const one = (s: string) => timedHides('x', code(s)).length
    expect(one('Task { try? await Task.sleep(for: .seconds(5)); if a == b { removed = nil } }')).toBe(1)
    expect(one('Task { try? await Task.sleep(nanoseconds: 2_500_000_000)\n withAnimation { id = nil } }')).toBe(1)
    expect(one('DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }')).toBe(1)
    expect(one('let reset = DispatchWorkItem { [weak self] in self?.show(false) }\nDispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: reset)')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .seconds(Self.window)); self.offer = nil }')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .milliseconds(250)); frozen = false }')).toBe(0)
    // A named length is read where the file declares it: a 100 ms poll is no timed hide.
    expect(one('static let tick: Duration = .milliseconds(100)\nTask { try? await Task.sleep(for: Self.tick); listening = false }')).toBe(0)
    expect(one('static let window: Duration = .seconds(5)\nTask { try? await Task.sleep(for: Self.window); offer = nil }')).toBe(1)
    expect(one('static let hold: TimeInterval = 0.2\nDispatchQueue.main.asyncAfter(deadline: .now() + Self.hold) { shown = false }')).toBe(0)
    expect(one('Task { try? await Task.sleep(for: .seconds(5)); await refresh() }')).toBe(0)
    expect(one('if a == nil { Task { try? await Task.sleep(for: .seconds(3)) } }\nx = nil')).toBe(0)
  })
})
