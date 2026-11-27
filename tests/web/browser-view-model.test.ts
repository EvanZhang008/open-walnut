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

describe('the Browser replay\'s words (SessionBrowserReplay.tsx)', () => {
  it('shows a step\'s own picture, else the last earlier one, else none', async () => {
    const { pictureIndex } = await import('../../web/src/components/sessions/browser-view-model')
    const steps = [{ picture: false }, { picture: true }, { picture: false }, { picture: false }, { picture: true }]
    expect(pictureIndex(steps, 0)).toBe(-1)
    expect(pictureIndex(steps, 1)).toBe(1)
    expect(pictureIndex(steps, 3)).toBe(1)
    expect(pictureIndex(steps, 4)).toBe(4)
    expect(pictureIndex(steps, 99)).toBe(4)
    expect(pictureIndex([], 0)).toBe(-1)
  })

  it('gives a long run\'s step its day and clock (utils/time.ts pointInTime), never seconds', async () => {
    const { stepTimeLine } = await import('../../web/src/components/sessions/browser-view-model')
    const now = new Date(2026, 10, 14, 15, 0, 0).getTime()
    const first = new Date(2026, 10, 12, 8, 0, 0).toISOString()
    expect(stepTimeLine(new Date(2026, 10, 14, 14, 3, 22).toISOString(), first, 7200, now)).toBe('today 2:03 PM')
    expect(stepTimeLine(new Date(2026, 10, 12, 9, 0, 0).toISOString(), first, 7200, now)).toBe('Nov 12, 9:00 AM')
    expect(stepTimeLine('not a time', first, 7200, now)).toBe('')
  })

  it('the pill offers the replay once no tab is left (SessionBrowserChip.tsx)', async () => {
    const { REPLAY_LOOK, browserChipLook } = await import('../../web/src/components/sessions/SessionBrowserChip')
    expect(browserChipLook([])).toBeNull()
    expect(REPLAY_LOOK).toMatchObject({ label: 'Replay', tone: 'ended' })
  })

  it('says each recorded step in plain words, from the labels the recorder writes', async () => {
    const { replayStepWords } = await import('../../web/src/components/sessions/browser-view-model')
    const w = (action: string, label: string, more: Record<string, unknown> = {}, before?: { url?: string }) =>
      replayStepWords({ action, label, ok: true, ...more }, before)
    // Labels as replay-store.ts stepLabel and the extension's `said` words write them (real ones from 11-14).
    expect(w('open', 'Open 127.0.0.1:38167/context-text.html', { url: 'http://127.0.0.1:38167/context-text.html', title: 'Context text' }))
      .toEqual({ icon: 'open', title: 'Opened Context text', detail: '127.0.0.1:38167' })
    expect(w('click', 'Click tab "Main (CEO)"')).toMatchObject({ icon: 'tab', title: 'Clicked the \u201cMain (CEO)\u201d tab' })
    expect(w('click', 'Click button "Continue"')).toEqual({ icon: 'click', title: 'Clicked \u201cContinue\u201d', detail: '' })
    expect(w('click', 'Click link "Skill list"').title).toBe('Clicked the \u201cSkill list\u201d link')
    expect(w('click', 'Click option "United States +1"').title).toBe('Chose \u201cUnited States +1\u201d')
    expect(w('click', 'Click combobox "Country*"').title).toBe('Opened the \u201cCountry*\u201d list')
    expect(w('click', 'Click at 120, 40')).toEqual({ icon: 'click', title: 'Clicked', detail: 'at 120, 40' })
    expect(w('type', 'Type 12 characters into textbox "Email"')).toEqual({ icon: 'type', title: 'Typed 12 characters', detail: 'in \u201cEmail\u201d' })
    expect(w('type', 'Type 7 characters, one key at a time, into combobox "Location (City)*"').detail).toBe('in \u201cLocation (City)*\u201d, one key at a time')
    expect(w('type', 'Type 0 characters into searchbox "Search"')).toMatchObject({ icon: 'clear', title: 'Cleared \u201cSearch\u201d' })
    expect(w('type', 'Type').title).toBe('Typed')
    expect(w('press', 'Press Enter').title).toBe('Pressed Return')
    expect(w('press', 'Press Meta+r').title).toBe('Pressed Command-R')
    expect(w('scroll', 'Scroll down 1 screen(s); at 489 of 9010')).toEqual({ icon: 'down', title: 'Scrolled down', detail: '5% into the page' })
    expect(w('scroll', 'Scroll down 500 px over searchbox "Search"')).toEqual({ icon: 'down', title: 'Scrolled down', detail: 'by 500 px' })
    expect(w('scroll', 'Scroll to the top; at 0 of 1020')).toEqual({ icon: 'up', title: 'Scrolled to the top', detail: '' })
    // A navigate to the address it was on is a reload; to another, a go.
    const page = { url: 'https://en.wikipedia.org/wiki/Walnut', title: 'Walnut - Wikipedia', tab: 7 }
    expect(w('navigate', 'Go to en.wikipedia.org/wiki/Walnut', page, page).title).toBe('Reloaded Walnut - Wikipedia')
    expect(w('navigate', 'Go to en.wikipedia.org/wiki/Walnut', page, { url: 'https://example.com/' })).toEqual({ icon: 'go', title: 'Went to Walnut - Wikipedia', detail: 'en.wikipedia.org' })
    expect(w('back', 'Back', { title: 'Juglans regia - Wikipedia' }).detail).toBe('to Juglans regia - Wikipedia')
    expect(w('fill_form', 'Fill 4 fields').title).toBe('Filled 4 fields')
    // "one key at a time" after the field (agent-trusted.ts), an empty name, bare actions, odd keys.
    expect(w('type', 'Type 7 characters into combobox "City", one key at a time')).toEqual({ icon: 'type', title: 'Typed 7 characters', detail: 'in \u201cCity\u201d, one key at a time' })
    expect(w('click', 'Click button ""').title).toBe('Clicked a button')
    expect(w('click', 'Click button "Say "hi""').title).toBe('Clicked \u201cSay "hi"\u201d')
    expect(w('select', 'Select').title).toBe('Chose an option')
    expect(w('hover', 'Hover').title).toBe('Pointed at the page')
    expect(w('press', 'Press ').title).toBe('Pressed a key')
    expect(w('press', 'Press Shift++').title).toBe('Pressed Shift-+')
    expect(w('scroll', 'Scroll right 300 px').icon).toBe('go')
    // A reload only when the tab, the address and the title are the same: the address is kept
    // without its query, so a new search on the same page is a go.
    const was = { url: 'https://example.com/search', title: 'Results for a', tab: 1 }
    expect(w('navigate', 'Go to example.com/search', { url: was.url, title: 'Results for a', tab: 1 }, was).title).toBe('Reloaded Results for a')
    expect(w('navigate', 'Go to example.com/search', { url: was.url, title: 'Results for b', tab: 1 }, was).title).toBe('Went to Results for b')
    expect(w('navigate', 'Go to example.com/search', { url: was.url, title: 'Results for a', tab: 2 }, was).title).toBe('Went to Results for a')
    expect(w('something_new', 'Something new').title).toBe('Something new')
    // A failed step says so, with its code.
    expect(replayStepWords({ action: 'type', label: 'Type', ok: false, code: 'element_gone' }).detail).toBe('failed: element gone')
  })

  it('draws the ruler at real times, a long pause folded with its length', async () => {
    const { RULER_FOLD_S, replayRuler, spanLine, stepTimeLine } = await import('../../web/src/components/sessions/browser-view-model')
    const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 17, 0, 0) + s * 1000).toISOString()
    const r = replayRuler([0, 10, 20, 20 + 300, 330].map((s) => ({ at: at(s) })))
    // Steps in one second sit 1 s apart, never on each other.
    expect(new Set(replayRuler([0, 0, 0].map((s) => ({ at: at(s) }))).at).size).toBe(3)
    // Drawn: 0, 10, 20, then the 300 s pause as RULER_FOLD_S, then 10 more.
    const total = 20 + RULER_FOLD_S + 10
    expect(r.at.map((x) => Math.round(x * total))).toEqual([0, 10, 20, 20 + RULER_FOLD_S, total])
    expect(r.folds).toEqual([{ at: (20 + RULER_FOLD_S / 2) / total, seconds: 300 }])
    expect(r.seconds).toBe(330)
    // One step, none, a bad time: no NaN anywhere.
    expect(replayRuler([{ at: at(0) }])).toEqual({ at: [0], folds: [], seconds: 0 })
    expect(replayRuler([])).toEqual({ at: [], folds: [], seconds: 0 })
    expect(replayRuler([{ at: at(0) }, { at: 'bad' }, { at: at(5) }]).at.every(Number.isFinite)).toBe(true)
    expect([87, 300, 5 * 3600, 3 * 86_400].map(spanLine)).toEqual(['87 s', '5 min', '5 h', '3 d'])
    // Times in the list: m:ss from the first step under an hour, else the clock time.
    expect(stepTimeLine(at(125), at(0), 900, Date.now())).toBe('2:05')
    expect(stepTimeLine(at(125), at(0), 7200, Date.now())).not.toBe('2:05')
  })
})
