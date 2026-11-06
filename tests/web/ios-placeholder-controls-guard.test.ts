/**
 * An iOS timeline placeholder that holds a control takes touches (2026-11-06, an iOS review: Try
 * Again on "Can't load this conversation" did nothing, because `TimelinePlaceholderInset` made its
 * fitting layout gesture-transparent, so the button under it could never be tapped).
 *
 * The members are read from source: every Swift view under ios-native/Walnut that places itself
 * with `.timelinePlaceholderInset(` and draws a Button, a Link or a tap gesture passes
 * `interactive:`, so a new placeholder with a control fails here until it does.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? swiftFiles(p) : e.name.endsWith('.swift') ? [p] : []
  })
}

/** Each top-level `struct … {` block of a file, split at the next top-level declaration. */
function structBlocks(src: string): Array<{ name: string; body: string }> {
  const starts = [...src.matchAll(/^(?:private |fileprivate )?struct (\w+)[^\n]*\{/gm)]
  return starts.map((m, i) => ({
    name: m[1],
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : src.length),
  }))
}

const CONTROL = /\bButton\s*[({]|\bLink\s*\(|\.onTapGesture\b/

describe('iOS timeline placeholders with a control take touches', () => {
  const placeholders = swiftFiles(IOS).flatMap((file) =>
    structBlocks(fs.readFileSync(file, 'utf8'))
      .filter((b) => b.body.includes('.timelinePlaceholderInset('))
      .map((b) => ({ file: path.relative(IOS, file), ...b })))

  it('finds the placeholders', () => {
    expect(placeholders.map((p) => p.name)).toEqual(expect.arrayContaining([
      'SessionTimelineUnreadableState', 'SessionTimelineEmptyState', 'ChatTimelineEmptyState',
    ]))
  })

  it('every placeholder that draws a control passes interactive:', () => {
    const missing = placeholders
      .filter((p) => CONTROL.test(p.body) && !/\.timelinePlaceholderInset\([^)]*interactive:/.test(p.body))
      .map((p) => `${p.file}: ${p.name}`)
    expect(missing).toEqual([])
  })

  it('the modifier gives its fitting layout touches when asked', () => {
    const src = fs.readFileSync(path.join(IOS, 'Timeline/TimelinePlaceholderInset.swift'), 'utf8')
    expect(src).toContain('.allowsHitTesting(interactive)')
    expect(src).not.toMatch(/laidOut\(content, availableHeight: slot\)\s*\.allowsHitTesting\(false\)/)
  })
})
