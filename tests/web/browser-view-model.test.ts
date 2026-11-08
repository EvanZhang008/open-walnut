/**
 * The words of a task's Browser view (web/src/components/sessions/browser-view-model.ts): which
 * window, why there is no picture now, why the last tab went, and which tab the view follows.
 */
import { describe, expect, it } from 'vitest'
import { agoLine, endedLine, followedTab, handLine, noPictureLine, tabKey, windowLine, type BrowserViewTab } from '../../web/src/components/sessions/browser-view-model'

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
    expect(followedTab([tab(1), tab(2)], 'extension-aaaaaa:1')?.tab).toBe(1)
    expect(followedTab([tab(1), tab(2)], 'extension-aaaaaa:9')?.tab).toBe(2)
    expect(followedTab([], null)).toBeUndefined()
  })

  it('tells two browsers\' tab 42 apart (the browser and the tab, never the tab alone)', () => {
    const a = { ...tab(42), device: 'extension-aaaaaa', title: 'A' }
    const b = { ...tab(42), device: 'extension-bbbbbb', title: 'B' }
    expect(tabKey(a)).not.toBe(tabKey(b))
    expect(followedTab([a, b], tabKey(a))?.title).toBe('A')
    expect(followedTab([a, b], tabKey(b))?.title).toBe('B')
    expect(followedTab([a, b], null)?.title).toBe('B')
  })

  it('reads how long ago', () => {
    const now = Date.parse('2026-11-07T10:00:00Z')
    expect(agoLine('2026-11-07T09:59:57Z', now)).toBe('3 s ago')
    expect(agoLine('2026-11-07T09:58:00Z', now)).toBe('2 min ago')
    expect(agoLine(undefined, now)).toBe('')
  })

  it('says who has the tab and what the agent waits for (Take over, request_sign_in)', () => {
    expect(handLine({})).toBeNull()
    expect(handLine({ driving: true })).toBe('You have this tab in your browser. The agent waits until you hand it back.')
    expect(handLine({ signIn: { site: 'example.test', note: 'a code goes to your phone' } })).toBe('The agent asks you to sign in to example.test yourself. It says: a code goes to your phone')
    expect(handLine({ driving: true, signIn: { site: 'example.test' } })).toBe('You have this tab in your browser. Sign in to example.test there, then press Done: the agent carries on.')
    expect(noPictureLine({ why: 'starting' }, false)).toBe('Taking the first picture…')
    expect(noPictureLine({ why: 'starting' }, true)).toBeNull()
  })
})
