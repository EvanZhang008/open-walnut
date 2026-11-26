/**
 * Every editable text view the phone hosts in SwiftUI keeps itself above the keyboard, or says
 * why it cannot be covered. SwiftUI scrolls its own focused `TextField` into view, but never a
 * `UITextView` it hosts (`UIViewRepresentable`): a thread card's Follow up box tapped low on the
 * page stayed under the keyboard and grew under it as he typed (2026-11-26, CI on iOS 26.5,
 * ThreadFollowUpVoiceUITests; the box left its sheet for the card in bb0a87a737).
 *
 * The members are read from source: each `makeUIView` under ios-native/Walnut that returns a
 * `UITextView` or a subclass of one. Its view class conforms to `KeyboardRevealing` and calls
 * `KeyboardReveal` where it takes the focus and where it grows (`becomeFirstResponder`,
 * `layoutSubviews`) and starts the keyboard tracking (`didMoveToWindow`), or it is in KNOWN with
 * the reason no keyboard can cover it. A new hosted text view fails here until it picks one.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

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

/** Hosted text views that no keyboard can cover, by the class `makeUIView` returns. */
const KNOWN: Record<string, string> = {
  UITextView: 'LongDraftEditor: the chat composer in the bar that rides on the keyboard, never inside a page scroll',
  WalnutTextView: "WysiwygEditor: the note page's own scroller, which keeps its caret in view itself",
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

/** `class Name: Super, Protocols {` → its whole body, by name. */
export function classes(src: string): Map<string, { supers: string[]; body: string }> {
  const out = new Map<string, { supers: string[]; body: string }>()
  for (const m of src.matchAll(/\bclass\s+(\w+)\s*:\s*([^{]+)\{/g)) {
    const open = m.index + m[0].length - 1
    out.set(m[1], { supers: m[2].split(',').map((s) => s.trim()), body: src.slice(open, closing(src, open) + 1) })
  }
  return out
}

/** The text view classes `makeUIView` returns in `src`, given every UITextView subclass name. */
export function hostedTextViews(src: string, textViews: Set<string>): string[] {
  const found: string[] = []
  for (const m of src.matchAll(/func\s+makeUIView\s*\(\s*context\s*:\s*Context\s*\)\s*->\s*(\w+)/g)) {
    if (textViews.has(m[1])) {
      // A `UITextView` return type that builds a subclass is judged by the subclass.
      const open = src.indexOf('{', m.index)
      const body = src.slice(open, closing(src, open) + 1)
      const built = [...body.matchAll(/=\s*(\w+)\s*\(\s*\)/g)].map((b) => b[1]).find((n) => textViews.has(n))
      found.push(built ?? m[1])
    }
  }
  return found
}

/** What a conforming class must do: the protocol, a reveal on focus and on growth, the tracking. */
export function revealGaps(body: string, supers: string[]): string[] {
  const gaps: string[] = []
  if (!supers.includes('KeyboardRevealing')) gaps.push('conform to KeyboardRevealing')
  const method = (name: string) => {
    const m = new RegExp(`override\\s+func\\s+${name}\\s*\\(`).exec(body)
    if (!m) return ''
    const open = body.indexOf('{', m.index)
    return body.slice(open, closing(body, open) + 1)
  }
  if (!/KeyboardReveal\.reveal/.test(method('becomeFirstResponder'))) gaps.push('reveal in becomeFirstResponder')
  if (!/KeyboardReveal\.reveal/.test(method('layoutSubviews'))) gaps.push('reveal in layoutSubviews (it grew)')
  if (!/KeyboardReveal\.track\(\)/.test(method('didMoveToWindow'))) gaps.push('track the keyboard in didMoveToWindow')
  return gaps
}

describe('iOS: a hosted text view stays above the keyboard', () => {
  const files = swiftFiles(IOS).map((f) => ({ file: path.relative(IOS, f), src: code(fs.readFileSync(f, 'utf8')) }))
  const all = new Map<string, { supers: string[]; body: string }>()
  for (const f of files) for (const [k, v] of classes(f.src)) all.set(k, v)
  const textViews = new Set(['UITextView', ...[...all].filter(([, c]) => c.supers[0] === 'UITextView').map(([k]) => k)])
  const hosted = files.flatMap((f) => hostedTextViews(f.src, textViews).map((cls) => ({ file: f.file, cls })))

  it('finds the hosted text views it guards', () => {
    expect(hosted.map((h) => h.cls)).toEqual(expect.arrayContaining(['PictureTextView', 'WalnutTextView', 'UITextView']))
  })

  it('every hosted text view reveals itself or is known not to be covered', () => {
    const offenders = hosted
      .filter((h) => !(h.cls in KNOWN))
      .map((h) => ({ ...h, gaps: revealGaps(all.get(h.cls)?.body ?? '', all.get(h.cls)?.supers ?? []) }))
      .filter((h) => h.gaps.length > 0)
      .map((h) => `${h.file}: ${h.cls} must ${h.gaps.join(', ')}`)
    expect(offenders, 'make it KeyboardRevealing (LetterReplyField.swift PictureTextView), or add it to KNOWN with why').toEqual([])
  })

  it('every KNOWN entry is still hosted', () => {
    const live = new Set(hosted.map((h) => h.cls))
    expect(Object.keys(KNOWN).filter((k) => !live.has(k))).toEqual([])
  })

  it('names each gap of a class that does not reveal', () => {
    const bare = classes(code('final class T: UITextView { override func layoutSubviews() { super.layoutSubviews() } }')).get('T')!
    expect(revealGaps(bare.body, bare.supers)).toEqual([
      'conform to KeyboardRevealing', 'reveal in becomeFirstResponder', 'reveal in layoutSubviews (it grew)', 'track the keyboard in didMoveToWindow',
    ])
    const src = code(`struct R: UIViewRepresentable { func makeUIView(context: Context) -> UITextView { let v = T(); return v } }`)
    expect(hostedTextViews(src, new Set(['UITextView', 'T']))).toEqual(['T'])
  })
})
