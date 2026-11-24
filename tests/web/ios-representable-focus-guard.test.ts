/**
 * A SwiftUI-hosted UIKit view never changes the first responder inside its `updateUIView` or
 * `updateUIViewController`. A change there walks SwiftUI's focus bridge, which reads the view
 * graph that is being updated: AttributeGraph found a cycle and printed it on every pass, and the
 * phone's main thread spent minutes writing it out (2026-11-24: a Follow up box reopened on a VP's
 * page froze the app; ThreadPushHold WA and ThreadPushNavigation Z timed out in CI with "main
 * thread busy for 30 s", and the iOS UI jobs ran out their 45 minutes). The change goes through
 * `UIView.followFocus` (LetterReplyField.swift), which makes it on the next main-queue turn.
 *
 * The members are read from source: every body SwiftUI runs inside its update (`makeUIView`,
 * `updateUIView`, `sizeThatFits`, `dismantleUIView` and the view controller twins) under
 * ios-native is scanned, for a direct become/resign, a `sendAction` resign and `endEditing(`.
 * A closure that runs later (a main-queue hop, a `Task`, a notification observer) is not the update.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native')

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:\\.|[^"\\\n])*"/g, '""')

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'build' || entry.name === 'DerivedData') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

/** The bodies of every function SwiftUI calls inside its update pass, in `src`. */
export function updateBodies(src: string): string[] {
  const bodies: string[] = []
  const re = /func\s+(?:make|update)UIView(?:Controller)?\s*\(|func\s+dismantleUIView(?:Controller)?\s*\(|func\s+sizeThatFits\s*\(\s*_\s+\w+\s*:\s*ProposedViewSize/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf('{', m.index)
    if (open < 0) break
    bodies.push(withoutLaterClosures(src.slice(open, closing(src, open) + 1)))
  }
  return bodies
}

function closing(src: string, open: number): number {
  let depth = 0
  let end = open
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}' && --depth === 0) break
  }
  return end
}

/** Closures that run later, never inside the update: a main-queue hop, a Task, a notification observer. */
const LATER = /(DispatchQueue\.main\.async(?:After)?\s*(?:\([^{}]*\))?|\bTask\s*(?:\([^{}]*\))?|addObserver\([^{}]*\))\s*\{/g

function withoutLaterClosures(body: string): string {
  let out = body
  for (const m of body.matchAll(LATER)) {
    const open = m.index + m[0].length - 1
    const end = closing(body, open)
    out = out.slice(0, open) + ' '.repeat(end + 1 - open) + out.slice(end + 1)
  }
  return out
}

/** A first responder change: a direct call, a `sendAction` resign, or `endEditing(`. */
export const FOCUS_CHANGE = /\b(become|resign)FirstResponder\s*\(|#selector\(UIResponder\.resignFirstResponder\)|\.endEditing\s*\(/

describe('iOS: no first responder change inside a representable update', () => {
  const files = swiftFiles(IOS).map((f) => ({ file: path.relative(IOS, f), src: code(fs.readFileSync(f, 'utf8')) }))

  it('finds the update bodies it guards', () => {
    const scanned = files.filter((f) => updateBodies(f.src).length > 0).map((f) => f.file)
    expect(scanned).toContain('Walnut/Views/Inbox/LetterReplyField.swift')
    expect(scanned).toContain('Walnut/Views/Chat/LongDraftEditor.swift')
  })

  it('every update moves focus through followFocus', () => {
    const offenders = files
      .filter((f) => updateBodies(f.src).some((b) => FOCUS_CHANGE.test(b)))
      .map((f) => f.file)
    expect(offenders, 'use `view.followFocus { wanted }` instead of a first responder call in an update').toEqual([])
  })

  it('catches each kind of change in an update, and none in a closure that runs later', () => {
    const changes = [
      'view.becomeFirstResponder()',
      'UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)',
      'view.endEditing(true)',
    ]
    for (const change of changes) {
      for (const fn of ['func updateUIView(_ v: UITextView, context: Context)', 'func makeUIView(context: Context) -> UITextView']) {
        expect(updateBodies(code(`${fn} {\n  ${change}\n}`)).some((b) => FOCUS_CHANGE.test(b)), `${fn}: ${change}`).toBe(true)
      }
    }
    const later = `func updateUIView(_ v: UITextView, context: Context) {
      // view.becomeFirstResponder()
      let s = "view.resignFirstResponder()"
      DispatchQueue.main.async { v.becomeFirstResponder() }
      NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { _ in v.resignFirstResponder() }
      v.followFocus { true }
    }
    func tapped() { v.becomeFirstResponder() }`
    expect(updateBodies(code(later)).some((b) => FOCUS_CHANGE.test(b))).toBe(false)
  })
})
