/**
 * The words of a task's Browser view (web/src/components/sessions/browser-view-model.ts): which
 * window, why there is no picture now, why the last tab went, and which tab the view follows.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LATE_MS, LIVE_GRANT_LINE, LIVE_PICTURES_SWITCH, agoLine, endedLine, lateLine, followedTab, handLine, liveGrantOffer, noPictureLine, tabKey, windowLine, type BrowserViewTab } from '../../web/src/components/sessions/browser-view-model'

const tab = (n: number): BrowserViewTab => ({ device: 'extension-aaaaaa', browser: 'Chrome', tab: n, connected: true, pictures: true })

describe('the Browser view\'s words', () => {
  it('names the window', () => {
    expect(windowLine({ window: 'agent', windowState: 'normal' })).toBe("Walnut's agent window, behind yours")
    // The tooltip's full form says what the one line leaves out.
    expect(windowLine({ window: 'agent', windowState: 'normal' }, true)).toBe("Walnut's agent window, behind yours (not minimized)")
    expect(windowLine({ window: 'agent', windowState: 'minimized' }, true)).toBe("Walnut's agent window (you minimized it)")
    expect(windowLine({ window: 'agent', windowState: 'minimized' })).toBe("Walnut's agent window (you minimized it)")
    expect(windowLine({ window: 'person', handed: true })).toBe('Your own window: you handed this tab over')
    expect(windowLine({ window: 'person', taken: true })).toBe('Your own window: the agent took this tab of yours')
    expect(windowLine({})).toBe('Your browser')
  })

  it('says why there is no picture, and keeps quiet when the last one stays', () => {
    expect(noPictureLine({ why: 'behind', window: 'person' }, true)).toMatch(/never switches your tabs/)
    expect(noPictureLine({ why: 'behind', window: 'agent' }, false)).toMatch(/behind another tab in the agent window/)
    expect(noPictureLine({ why: 'minimized' }, true)).toMatch(/minimized/)
    // Even with an old picture on the card: it is old because the window draws nothing now.
    expect(noPictureLine({ why: 'covered' }, true)).toMatch(/cover all of it/)
    expect(noPictureLine({ why: 'old_extension' }, false)).toMatch(/update it/)
    expect(noPictureLine({ why: 'busy' }, true)).toBeNull()
    expect(noPictureLine({ why: 'busy' }, false)).toMatch(/clicking or typing in another of its tabs/)
    expect(noPictureLine(null, false)).toBeNull()
  })

  it('says why the last tab went', () => {
    expect(endedLine('stopped')).toBe("You stopped the agent's use of the tab. It stays open.")
    expect(endedLine('tidied')).toMatch(/task finished, or no agent used the tab for 30 minutes/)
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
    // A sign-in ask on another tab is shown first (the pill says Sign in), unless the picked tab asks too.
    const ask = { ...tab(1), signIn: { id: 'si', at: '2026-11-09T00:00:00Z' } }
    expect(followedTab([ask, tab(2)], null)?.tab).toBe(1)
    expect(followedTab([ask, tab(2)], 'extension-aaaaaa:2')?.tab).toBe(1)
    expect(followedTab([ask, { ...tab(2), signIn: ask.signIn }], 'extension-aaaaaa:2')?.tab).toBe(2)
    expect(followedTab([{ ...ask, driving: true }, tab(2)], null)?.tab).toBe(2)
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

  // 2026-11-08, the user: "like this one just freeze". A view with no new picture for LATE_MS says so.
  it('says how long no new picture came, once that is longer than a moment', () => {
    expect(lateLine(undefined, 1_000_000)).toBeNull()
    expect(lateLine(new Date(1_000_000 - LATE_MS + 1).toISOString(), 1_000_000)).toBeNull()
    expect(lateLine(new Date(1_000_000 - 12_000).toISOString(), 1_000_000)).toMatch(/^No new picture for 12 ?s\.$/)
  })
})

// 2026-11-09: a covered agent window draws nothing; live pictures (the extension's debugger) show it.
describe('a covered window, by what the extension says of live pictures', () => {
  const COVERED = /cover all of it, so no new picture can be taken/
  it('a copy without the permission, on a browser that can ask: Show it live, with exactly what happens', () => {
    const f = { why: 'covered', live: 'no_permission' }
    expect(liveGrantOffer(f, { liveGrant: true })).toBe(true)
    const line = noPictureLine(f, true, true)!
    expect(line).toMatch(/press Show it live/)
    expect(line).toContain(LIVE_GRANT_LINE)
    expect(LIVE_GRANT_LINE).toBe("Chrome opens a small Walnut page: click Allow there, then Allow in Chrome's box.")
  })

  it('a minimized window or a tab behind another, without the permission: the same offer', () => {
    expect(liveGrantOffer({ why: 'minimized', live: 'no_permission' }, { liveGrant: true })).toBe(true)
    expect(liveGrantOffer({ why: 'behind', live: 'no_permission' }, { liveGrant: true })).toBe(true)
    expect(liveGrantOffer({ why: 'not_web', live: 'no_permission' }, { liveGrant: true })).toBe(false)
  })

  it('an older extension (no live state, or no cap): the line as it was, and no button', () => {
    expect(liveGrantOffer({ why: 'covered' }, { liveGrant: true })).toBe(false)
    expect(liveGrantOffer({ why: 'covered', live: 'no_permission' }, { liveGrant: false })).toBe(false)
    expect(liveGrantOffer({ why: 'covered', live: 'no_permission' }, {})).toBe(false)
    expect(noPictureLine({ why: 'covered' }, true)).toMatch(COVERED)
    expect(noPictureLine({ why: 'covered', live: 'unavailable' }, true)).toMatch(COVERED)
    // No button: the way to get the permission is to set the extension up again.
    expect(noPictureLine({ why: 'covered', live: 'no_permission' }, true, false)).toMatch(/set the extension up again/)
  })

  it('the person turned live pictures off: where to turn them on, by the switch\'s own name, no button', () => {
    expect(liveGrantOffer({ why: 'covered', live: 'off' }, { liveGrant: true })).toBe(false)
    expect(noPictureLine({ why: 'covered', live: 'off' }, true)).toContain(`"${LIVE_PICTURES_SWITCH}"`)
    const popup = readFileSync('packages/browser-extension/src/popup-settings.ts', 'utf8')
    expect(popup).toContain(`LIVE_PICTURES_TITLE = "${LIVE_PICTURES_SWITCH}"`)
  })

  it('each reason the debugger could not serve has its own line', () => {
    expect(noPictureLine({ why: 'covered', live: 'cancelled' }, true)).toMatch(/cancelled Chrome's debugging bar/)
    expect(noPictureLine({ why: 'covered', live: 'failed' }, true)).toMatch(/tries again/)
    expect(noPictureLine({ why: 'covered', live: 'dialog' }, true)).toMatch(/dialog .* is open on the page/)
    expect(noPictureLine({ why: 'covered', live: 'devtools' }, true)).toMatch(/DevTools is open on this tab/)
    expect(noPictureLine({ why: 'discarded' }, true)).toMatch(/put this tab to sleep/)
    expect(noPictureLine({ why: 'not_web' }, true)).toMatch(/chrome:\/\//)
  })

  it('live pictures on: pictures flow, so no line (a shown frame has no why)', () => {
    expect(noPictureLine({ why: undefined, live: undefined }, true)).toBeNull()
    expect(liveGrantOffer({ why: undefined }, { liveGrant: true })).toBe(false)
  })

  it('every state the extension can report has its own words on a covered, minimized or behind frame (a new state fails here)', () => {
    // The LiveState union, read from the extension's source.
    const src = readFileSync('packages/browser-extension/src/agent-live.ts', 'utf8')
    const union = /export type LiveState = ([^\n]+)/.exec(src)![1]
    const states = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(states).toEqual(expect.arrayContaining(['on', 'off', 'no_permission', 'cancelled', 'unavailable', 'failed', 'dialog', 'devtools']))
    // 'on' is a picture (no line); 'unavailable' is a tab the debugger never serves (the plain line).
    const generic = { covered: noPictureLine({ why: 'covered' }, true), minimized: noPictureLine({ why: 'minimized' }, true), behind: noPictureLine({ why: 'behind', window: 'agent' }, true) }
    for (const live of states.filter((x) => x !== 'on' && x !== 'unavailable')) {
      for (const why of ['covered', 'minimized', 'behind'] as const) {
        const line = noPictureLine({ why, window: 'agent', live }, true, true)
        expect(line, `${why}/${live}`).toBeTruthy()
        expect(line, `${why}/${live}`).not.toBe(generic[why])
      }
    }
  })

  it('every line is plain: no em dashes', () => {
    for (const live of ['no_permission', 'off', 'cancelled', 'failed', 'dialog', 'devtools', undefined]) {
      for (const why of ['covered', 'minimized', 'behind', 'discarded']) {
        expect(noPictureLine({ why, window: 'agent', live }, true, true) ?? '').not.toMatch(/[\u2013\u2014]/)
        expect(noPictureLine({ why, window: 'agent', live }, true, false) ?? '').not.toMatch(/[\u2013\u2014]/)
      }
    }
  })
})
