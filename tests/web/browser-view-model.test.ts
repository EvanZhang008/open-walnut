/**
 * The words of a task's Browser view (web/src/components/sessions/browser-view-model.ts): which
 * window, why there is no picture now, why the last tab went, and which tab the view follows.
 */
import { describe, expect, it } from 'vitest'
import { agoLine, endedLine, followedTab, noPictureLine, windowLine, type BrowserViewTab } from '../../web/src/components/sessions/browser-view-model'

const tab = (n: number): BrowserViewTab => ({ device: 'extension-aaaaaa', browser: 'Chrome', tab: n, connected: true, pictures: true })

describe('the Browser view\'s words', () => {
  it('names the window', () => {
    expect(windowLine({ window: 'agent', windowState: 'normal' })).toBe("Walnut's agent window, behind yours (not minimized)")
    expect(windowLine({ window: 'agent', windowState: 'minimized' })).toBe("Walnut's agent window (you minimized it)")
    expect(windowLine({ window: 'person', handed: true })).toBe('Your own window: you handed this tab over')
    expect(windowLine({ window: 'person', taken: true })).toBe('Your own window: the agent took this tab of yours')
    expect(windowLine({})).toBe('Your browser')
  })

  it('says why there is no picture, and keeps quiet when the last one stays', () => {
    expect(noPictureLine({ why: 'behind', window: 'person' }, true)).toMatch(/never switches your tabs/)
    expect(noPictureLine({ why: 'behind', window: 'agent' }, false)).toMatch(/behind another tab in the agent window/)
    expect(noPictureLine({ why: 'minimized' }, true)).toMatch(/minimized/)
    expect(noPictureLine({ why: 'old_extension' }, false)).toMatch(/update it/)
    expect(noPictureLine({ why: 'busy' }, true)).toBeNull()
    expect(noPictureLine({ why: 'busy' }, false)).toBe('Waiting for the next picture…')
    expect(noPictureLine(null, false)).toBeNull()
  })

  it('says why the last tab went', () => {
    expect(endedLine('stopped')).toBe("You stopped the agent's use of the tab. It stays open.")
    expect(endedLine('closed')).toBe('The agent closed its browser tab.')
    expect(endedLine('given_back')).toMatch(/gave your tab back/)
    expect(endedLine('browser_left')).toMatch(/left Walnut/)
    expect(endedLine('gone')).toMatch(/stopped using the browser/)
  })

  it('follows the picked tab while it is there, else the newest', () => {
    expect(followedTab([tab(1), tab(2)], null)?.tab).toBe(2)
    expect(followedTab([tab(1), tab(2)], 1)?.tab).toBe(1)
    expect(followedTab([tab(1), tab(2)], 9)?.tab).toBe(2)
    expect(followedTab([], null)).toBeUndefined()
  })

  it('reads how long ago', () => {
    const now = Date.parse('2026-11-07T10:00:00Z')
    expect(agoLine('2026-11-07T09:59:57Z', now)).toBe('3 s ago')
    expect(agoLine('2026-11-07T09:58:00Z', now)).toBe('2 min ago')
    expect(agoLine(undefined, now)).toBe('')
  })
})
