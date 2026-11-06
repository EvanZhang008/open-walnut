/**
 * Where the Ask view's words are kept and when they are sent again (web/src/popout/ext-snapshot.ts
 * askSnapKey, snapSchedule), with the extension's real store (packages/browser-extension/src/
 * panel-snap.ts) on a fake browser storage: the side panel keeps a page's conversation, the
 * toolbar popup only the shell, so a popup opened on that page never empties the panel's drawing
 * (review 2026-11-06, F3); and a view that keeps changing is still sent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { NO_PAGE_SNAP_KEY, POPUP_SNAP_KEY, SNAP_MAX_WAIT_MS, SNAP_QUIET_MS, askSnapKey, snapKeyOf, snapSchedule } from '../../web/src/popout/ext-snapshot'

;(globalThis as any).document ??= parseHTML('<!doctype html><html><body></body></html>').document
const local: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://self/${p}` },
  storage: { local: { get: async (k: string) => ({ [k]: structuredClone(local[k]) }), set: async (o: Record<string, unknown>) => { Object.assign(local, structuredClone(o)) }, remove: async (ks: string | string[]) => { for (const k of [ks].flat()) delete local[k] } } },
}
const ext = await import('../../packages/browser-extension/src/panel-snap')

beforeEach(() => { for (const k of Object.keys(local)) delete local[k]; local.panelServer = 'http://walnut.example.test' })

const PAGE = 'https://docs.example.test/notes?v=2'
const conversation = { title: 'Release notes', host: 'docs.example.test', messages: [{ role: 'user', text: 'What changed?' }, { role: 'assistant', text: 'Uploads retry.' }], askTitle: 'Release notes' }
const popupShell = { title: 'Release notes', host: 'docs.example.test', messages: [], placeholder: 'Ask Walnut…', continue: [{ title: 'Compare two laptops', line: 'Zen 14 wins.', time: '3h ago', needs: false }] }

describe('where the words are kept', () => {
  it("the side panel: the page's conversation (the extension's own key for it); no page: its own key", () => {
    expect(askSnapKey('panel', PAGE)).toBe(ext.snapKeyOf(PAGE))
    expect(askSnapKey('panel', PAGE)).toBe(snapKeyOf(PAGE))
    expect(askSnapKey('panel', '')).toBe(NO_PAGE_SNAP_KEY)
  })

  it('the popup: one key no page has, whatever the page', () => {
    expect(askSnapKey('popup', PAGE)).toBe(POPUP_SNAP_KEY)
    expect(askSnapKey('popup', '')).toBe(POPUP_SNAP_KEY)
    expect(POPUP_SNAP_KEY.startsWith('web:')).toBe(false)
  })

  it('panel conversation, then the popup on that page, then the panel again: the conversation is still drawn, the shell is the popup\'s', async () => {
    await ext.keepSnap('ask', conversation, { key: askSnapKey('panel', PAGE) }, 1000)
    await ext.keepSnap('ask', popupShell, { key: askSnapKey('popup', PAGE) }, 2000)
    const back = await ext.snapOf('ask', PAGE, 3000) as { messages: unknown[]; askTitle?: string }
    expect(back.messages).toEqual(conversation.messages)
    expect(back.askTitle).toBe('Release notes')
    expect((await ext.shellOf(3000))?.cont).toEqual(popupShell.continue)
  })

  it('what the old key did (the popup under the page key) empties the conversation: the case this guards', async () => {
    await ext.keepSnap('ask', conversation, { key: snapKeyOf(PAGE) }, 1000)
    await ext.keepSnap('ask', popupShell, { key: snapKeyOf(PAGE) }, 2000)
    expect(((await ext.snapOf('ask', PAGE, 3000)) as { messages: unknown[] }).messages).toEqual([])
  })
})

describe('when the words are sent again', () => {
  function clock() {
    let now = 0
    const due: Array<{ at: number; fn: () => void; id: number }> = []
    let id = 0
    return {
      timers: {
        set: (fn: () => void, ms: number) => { id += 1; due.push({ at: now + ms, fn, id }); return id },
        clear: (t: unknown) => { const i = due.findIndex((d) => d.id === t); if (i >= 0) due.splice(i, 1) },
        now: () => now,
      },
      advance(ms: number) {
        const end = now + ms
        for (;;) {
          due.sort((a, b) => a.at - b.at)
          const next = due[0]
          if (!next || next.at > end) break
          due.shift(); now = next.at; next.fn()
        }
        now = end
      },
    }
  }

  it('after a quiet spell once the view stops changing', () => {
    const c = clock(); let sent = 0
    const s = snapSchedule(() => { sent += 1 }, c.timers)
    s.poke(); c.advance(100); s.poke(); c.advance(SNAP_QUIET_MS - 1)
    expect(sent).toBe(0)
    c.advance(1)
    expect(sent).toBe(1)
  })

  it('a view that never stops changing (a reply streaming in) is still sent every SNAP_MAX_WAIT_MS', () => {
    const c = clock(); let sent = 0
    const s = snapSchedule(() => { sent += 1 }, c.timers)
    for (let t = 0; t < 3 * SNAP_MAX_WAIT_MS; t += 100) { s.poke(); c.advance(100) }
    expect(sent).toBeGreaterThanOrEqual(2)
    expect(sent).toBeLessThanOrEqual(3)
  })

  it('flush sends at once (the panel closing); cancel drops what waits', () => {
    const c = clock(); let sent = 0
    const s = snapSchedule(() => { sent += 1 }, c.timers)
    s.poke(); s.flush()
    expect(sent).toBe(1)
    s.poke(); s.cancel(); c.advance(10 * SNAP_MAX_WAIT_MS)
    expect(sent).toBe(1)
  })
})
