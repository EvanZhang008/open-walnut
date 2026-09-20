/**
 * The rules that decide whether Walnut's own right-click menu opens, or the
 * BROWSER's menu is left alone. Pure-logic tests: the guard takes an
 * Element-shaped stub, so no DOM is needed to pin the behaviour that actually
 * regressed (a row menu stealing the Copy the user selected text for).
 */
import { describe, expect, it } from 'vitest'
import {
  keepNativeContextMenu,
  normalizeContextMenuItems,
  selectionForGesture,
} from '../../web/src/utils/context-menu.js'

/**
 * Minimal Element stand-in: `closest` reports a hit when one of `matches` is
 * either the whole selector the guard passed (the grouped constants below) or
 * one of its comma-separated parts.
 */
function target(matches: string[] = []): Element {
  return {
    closest: (selector: string) => {
      const wanted = selector.split(',').map((s) => s.trim())
      const hit = matches.some((m) => m === selector || wanted.includes(m))
      return hit ? ({} as Element) : null
    },
  } as unknown as Element
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const MEDIA = 'img, video, audio'
const LINK = 'a[href]'

describe('keepNativeContextMenu', () => {
  it('takes over a plain row', () => {
    expect(keepNativeContextMenu(target())).toBe(false)
  })

  it('never steals an editable surface (paste, undo, spelling live there)', () => {
    for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
      expect(keepNativeContextMenu(target([selector]), {})).toBe(true)
    }
    // Reached through `closest`, i.e. the pointer is over a span INSIDE it.
    expect(keepNativeContextMenu(target([EDITABLE]))).toBe(true)
  })

  it('never steals images or media — Save Image / video controls are free', () => {
    expect(keepNativeContextMenu(target(['img']))).toBe(true)
    expect(keepNativeContextMenu(target([MEDIA]))).toBe(true)
  })

  it('leaves document links alone but takes over routing links when asked', () => {
    expect(keepNativeContextMenu(target(['a[href]']))).toBe(true)
    expect(keepNativeContextMenu(target([LINK]), { overrideLinks: true })).toBe(false)
    // overrideLinks is about links ONLY — an editable or an image still wins.
    expect(keepNativeContextMenu(target(['input']), { overrideLinks: true })).toBe(true)
    expect(keepNativeContextMenu(target(['img']), { overrideLinks: true })).toBe(true)
  })

  it('keeps the native menu while text is selected inside the row', () => {
    const anchor = {} as Node
    const scope = { contains: () => true } as unknown as Element
    expect(keepNativeContextMenu(target(), { selectionText: 'hello', selectionAnchor: anchor, scope }))
      .toBe(true)
  })

  it('ignores a selection that lives somewhere else on the page', () => {
    const anchor = {} as Node
    const scope = { contains: () => false } as unknown as Element
    expect(keepNativeContextMenu(target(), { selectionText: 'hello', selectionAnchor: anchor, scope }))
      .toBe(false)
  })

  it('treats a whitespace-only selection as no selection', () => {
    expect(keepNativeContextMenu(target(), { selectionText: '   \n' })).toBe(false)
  })

  it('is safe on a target with no closest() (a text node handed in by mistake)', () => {
    expect(keepNativeContextMenu({} as Element)).toBe(false)
    expect(keepNativeContextMenu(null)).toBe(false)
  })
})

describe('normalizeContextMenuItems', () => {
  it('drops items whose condition is false', () => {
    const items = normalizeContextMenuItems([
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', when: false },
      { key: 'c', label: 'C', when: true },
    ])
    expect(items.map((i) => i.key)).toEqual(['a', 'c'])
  })

  it('collapses the dividers those drops leave behind', () => {
    // Every group being conditional is the norm here, so a menu must never show
    // a leading rule, a trailing rule, or two rules in a row.
    const items = normalizeContextMenuItems([
      { divider: true },
      { key: 'only', label: 'Only' },
      { divider: true },
      { key: 'gone', label: 'Gone', when: false },
      { divider: true },
    ])
    expect(items.map((i) => i.key ?? 'divider')).toEqual(['only'])
  })

  it('keeps a divider that still separates two live groups', () => {
    const items = normalizeContextMenuItems([
      { key: 'a', label: 'A' },
      { divider: true },
      { key: 'b', label: 'B' },
    ])
    expect(items).toHaveLength(3)
    expect(items[1].divider).toBe(true)
  })
})

/**
 * Rule 2 asks about a selection the HUMAN made, and WebKit hands the gesture one it made itself: the
 * word under the pointer is selected as the right-press's default action, before `contextmenu` is
 * dispatched. On a surface whose row text is selectable that made the row's own menu unreachable in the
 * Mac app while Chromium, which does not pre-select, opened it every time.
 */
describe('a selection the right-press itself created', () => {
  const NOW = 10_000

  it('counts as no selection, so the row menu opens (WebKit)', () => {
    // Nothing was selected when the button went down; the word appeared during the press.
    expect(selectionForGesture('Timetable', { text: '', at: NOW - 5 }, NOW)).toBe('')
  })

  it('leaves a selection the human made alone, so Copy and Look Up stay reachable', () => {
    // A right-click INSIDE a selection does not change it: the text is the same on both sides.
    expect(selectionForGesture('two words', { text: 'two words', at: NOW - 5 }, NOW)).toBe('two words')
  })

  it('counts a selection the press REPLACED as gesture-made', () => {
    // The human's selection was somewhere else and the press has already thrown it away, so keeping
    // the browser menu would offer Copy for characters that are no longer selected.
    expect(selectionForGesture('Timetable', { text: 'another row', at: NOW - 5 }, NOW)).toBe('')
  })

  it('takes the live selection at face value when no press belongs to this gesture', () => {
    // The keyboard menu key fires `contextmenu` with no press at all, and a snapshot from a minute ago
    // says nothing about it.
    expect(selectionForGesture('two words', { text: '', at: NOW - 60_000 }, NOW)).toBe('two words')
    expect(selectionForGesture('two words', null, NOW)).toBe('two words')
  })

  it('is empty whenever the live selection is, whatever the press held', () => {
    expect(selectionForGesture('', { text: 'two words', at: NOW - 5 }, NOW)).toBe('')
    expect(selectionForGesture('   ', null, NOW)).toBe('')
    expect(selectionForGesture(null, null, NOW)).toBe('')
  })

  it('does not trust a snapshot stamped in the future (a clock that moved)', () => {
    expect(selectionForGesture('two words', { text: '', at: NOW + 500 }, NOW)).toBe('two words')
  })
})
