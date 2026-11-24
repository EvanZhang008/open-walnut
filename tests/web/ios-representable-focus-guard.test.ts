/**
 * A SwiftUI-hosted UIKit view never changes the first responder inside its `updateUIView` or
 * `updateUIViewController`. A change there walks SwiftUI's focus bridge, which reads the view
 * graph that is being updated: AttributeGraph found a cycle and printed it on every pass, and the
 * phone's main thread spent minutes writing it out (2026-11-24: a Follow up box reopened on a VP's
 * page froze the app; ThreadPushHold WA and ThreadPushNavigation Z timed out in CI with "main
 * thread busy for 30 s", and the iOS UI jobs ran out their 45 minutes). The change goes through
 * `UIView.followFocus` (LetterReplyField.swift), which makes it on the next main-queue turn.
 *
 * The members are read from source: every update body under ios-native is scanned.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native')

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

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

/** The bodies of every `func updateUIView(` / `func updateUIViewController(` in `src`. */
function updateBodies(src: string): string[] {
  const bodies: string[] = []
  const re = /func\s+updateUIView(?:Controller)?\s*\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf('{', m.index)
    if (open < 0) break
    let depth = 0
    let end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    bodies.push(src.slice(open, end + 1))
  }
  return bodies
}

describe('iOS: no first responder change inside a representable update', () => {
  const files = swiftFiles(IOS).map((f) => ({ file: path.relative(IOS, f), src: code(fs.readFileSync(f, 'utf8')) }))

  it('finds the update bodies it guards', () => {
    const scanned = files.filter((f) => updateBodies(f.src).length > 0).map((f) => f.file)
    expect(scanned).toContain('Walnut/Views/Inbox/LetterReplyField.swift')
    expect(scanned).toContain('Walnut/Views/Chat/LongDraftEditor.swift')
  })

  it('every update moves focus through followFocus', () => {
    const offenders = files
      .filter((f) => updateBodies(f.src).some((b) => /\b(become|resign)FirstResponder\s*\(/.test(b)))
      .map((f) => f.file)
    expect(offenders, 'use `view.followFocus { wanted }` instead of a first responder call in an update').toEqual([])
  })
})
