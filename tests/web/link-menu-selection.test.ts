import { describe, expect, it } from 'vitest'
import { createPressSelectionKeeper } from '../../web/src/plugins/link-menu-selection.js'

// WebKit selects the word under a right-press before `contextmenu`; the link menu puts
// back the selection the press found, so no Pin / Quote / Copy bar wakes for it, and a
// selection the user made stays. A fake Selection stands in for the DOM one.

class FakeSelection {
  ranges: Array<{ text: string; cloneRange(): unknown }> = []
  get rangeCount() { return this.ranges.length }
  get isCollapsed() { return this.ranges.every((r) => !r.text) }
  getRangeAt(i: number) { return this.ranges[i] as unknown as Range }
  toString() { return this.ranges.map((r) => r.text).join('') }
  removeAllRanges() { this.ranges = [] }
  addRange(r: Range) { this.ranges.push(r as unknown as { text: string; cloneRange(): unknown }) }
}

function range(text: string) {
  const r = { text, cloneRange: () => ({ ...r }) }
  return r
}

function setup() {
  const sel = new FakeSelection()
  let t = 1000
  const keeper = createPressSelectionKeeper(() => sel as unknown as Selection, () => t)
  return { sel, keeper, advance: (ms: number) => { t += ms } }
}

describe('the link menu and the selection a right-press makes', () => {
  it('drops the word the press selected', () => {
    const { sel, keeper } = setup()
    keeper.press({ button: 2, ctrlKey: false })
    sel.ranges = [range('permalink')] // WebKit's own selection on the right-press
    expect(keeper.settle()).toBe(true)
    expect(sel.toString()).toBe('')
  })

  it('puts back a selection the user had elsewhere that the press replaced', () => {
    const { sel, keeper } = setup()
    sel.ranges = [range('an earlier paragraph')]
    keeper.press({ button: 2, ctrlKey: false })
    sel.ranges = [range('permalink')]
    expect(keeper.settle()).toBe(true)
    expect(sel.toString()).toBe('an earlier paragraph')
  })

  it('keeps the user\'s own selection the press left as it was', () => {
    const { sel, keeper } = setup()
    sel.ranges = [range('Message: the permalink')]
    keeper.press({ button: 2, ctrlKey: false })
    expect(keeper.settle()).toBe(false)
    expect(sel.toString()).toBe('Message: the permalink')
  })

  it('a Ctrl+click (the Mac\'s right-click) is a menu press too', () => {
    const { sel, keeper } = setup()
    keeper.press({ button: 0, ctrlKey: true })
    sel.ranges = [range('permalink')]
    expect(keeper.settle()).toBe(true)
    expect(sel.toString()).toBe('')
  })

  it('leaves the selection alone with no fresh menu press: a left press, the menu key, a stale press', () => {
    const { sel, keeper, advance } = setup()
    keeper.press({ button: 0, ctrlKey: false })
    sel.ranges = [range('dragged text')]
    expect(keeper.settle()).toBe(false)
    expect(keeper.settle()).toBe(false) // the menu key: no press at all
    keeper.press({ button: 2, ctrlKey: false })
    sel.ranges = [range('other text')]
    advance(5_000)
    expect(keeper.settle()).toBe(false)
    expect(sel.toString()).toBe('other text')
  })

  it('a press is used once', () => {
    const { sel, keeper } = setup()
    keeper.press({ button: 2, ctrlKey: false })
    sel.ranges = [range('permalink')]
    expect(keeper.settle()).toBe(true)
    sel.ranges = [range('typed later')]
    expect(keeper.settle()).toBe(false)
  })
})
