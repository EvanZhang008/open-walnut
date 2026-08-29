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
