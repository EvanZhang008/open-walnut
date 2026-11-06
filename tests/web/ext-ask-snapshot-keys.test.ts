/**
 * Where the Ask view's words are kept and when they are sent again (web/src/popout/ext-snapshot.ts
 * askSnapKey, snapSchedule), with the extension's real store (packages/browser-extension/src/
 * panel-snap.ts) on a fake browser storage: the side panel keeps each agent's open conversation
 * under a key of its own whatever the page (round 3: the conversation stays as the person moves
 * on; its code review: an agent switch never draws another agent's question), the toolbar popup
 * only the shell, so a popup never empties the panel's drawing (review 2026-11-06, F3); and a view
 * that keeps changing is still sent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { PANEL_SNAP_PREFIX, POPUP_SNAP_KEY, SNAP_MAX_WAIT_MS, SNAP_QUIET_MS, askSnapKey, snapKeyOf, snapSchedule } from '../../web/src/popout/ext-snapshot'

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
  it('the side panel: each agent\'s open conversation under a key of its own no page has; the page it was taken on rides in the words', () => {
    expect(askSnapKey('panel', 'walnut')).toBe(`${PANEL_SNAP_PREFIX}walnut`)
    expect(askSnapKey('panel', 'walnut')).not.toBe(askSnapKey('panel', 'mentor'))
    expect(askSnapKey('panel', 'walnut').startsWith('web:')).toBe(false)
    // The extension reads the same key for the same agent.
    expect(ext.agentAskKey('mentor')).toBe(askSnapKey('panel', 'mentor'))
    // The words name their page with the extension's own key for it (its chip is that page's).
    expect(snapKeyOf(PAGE)).toBe(ext.snapKeyOf(PAGE))
  })

  it('the popup: another key no page has', () => {
    expect(askSnapKey('popup', 'walnut')).toBe(POPUP_SNAP_KEY)
    expect(POPUP_SNAP_KEY.startsWith('web:')).toBe(false)
    expect(POPUP_SNAP_KEY.startsWith(PANEL_SNAP_PREFIX)).toBe(false)
  })

  it('panel conversation, then the popup on that page, then the panel again: the conversation is still drawn, the shell is the popup\'s', async () => {
    await ext.keepAgent('walnut', 900)
    await ext.keepSnap('ask', conversation, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 1000)
    await ext.keepSnap('ask', popupShell, { key: askSnapKey('popup', 'walnut'), agentId: 'walnut' }, 2000)
    const back = await ext.snapOf('ask', PAGE, 3000) as { messages: unknown[]; askTitle?: string }
    expect(back.messages).toEqual(conversation.messages)
    expect(back.askTitle).toBe('Release notes')
    // On another page, and on a tab with no page: the same open conversation.
    expect(((await ext.snapOf('ask', 'https://other.example.test/x', 3000)) as { messages: unknown[] }).messages).toEqual(conversation.messages)
    expect(((await ext.snapOf('ask', '', 3000)) as { messages: unknown[] } | null)?.messages).toEqual(conversation.messages)
    expect((await ext.shellOf(3000))?.cont).toEqual(popupShell.continue)
  })

  it('the popup switches to another agent: the panel\'s next drawing is that agent\'s (or the bare Ask), never the first agent\'s question (round 3 code review, item 3)', async () => {
    await ext.keepAgent('walnut', 900)
    await ext.keepSnap('ask', conversation, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 1000)
    // The popup's view, now on Mentor, says so, and sends its shell under the popup's key.
    await ext.keepAgent('mentor', 1500)
    await ext.keepSnap('ask', { ...popupShell, agent: 'Mentor', continue: [{ title: 'Plan the week', line: '', time: 'now', needs: false }] }, { key: askSnapKey('popup', 'mentor'), agentId: 'mentor' }, 2000)
    expect(await ext.agentOf()).toBe('mentor')
    // No conversation of Mentor's yet: nothing, never Walnut's.
    expect(await ext.snapOf('ask', PAGE, 3000)).toBeNull()
    const shell = await ext.shellOf(3000)
    expect(shell?.agent).toBe('Mentor')
    expect(shell?.cont?.map((r) => r.title)).toEqual(['Plan the week'])
    // Mentor's own conversation, once kept, is its drawing; Walnut's is still Walnut's.
    await ext.keepSnap('ask', { ...conversation, agent: 'Mentor', messages: [{ role: 'user', text: 'What is on Monday?' }] }, { key: askSnapKey('panel', 'mentor'), agentId: 'mentor' }, 4000)
    expect(((await ext.snapOf('ask', PAGE, 5000)) as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('What is on Monday?')
    expect(((await ext.snapOf('ask', PAGE, 5000, 'walnut')) as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('What changed?')
    expect((await ext.shellOf(5000, 'walnut'))).toBeNull()
  })

  it('two windows on different agents: each keeps its own words, neither overwrites the other\'s', async () => {
    const a = { ...conversation, agent: 'Ask Walnut', messages: [{ role: 'user', text: 'Window one asks' }] }
    const b = { ...conversation, agent: 'Mentor', messages: [{ role: 'user', text: 'Window two asks' }] }
    // Interleaved, as two views streaming at once send them.
    await Promise.all([
      ext.keepSnap('ask', a, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 1000),
      ext.keepSnap('ask', b, { key: askSnapKey('panel', 'mentor'), agentId: 'mentor' }, 1001),
      ext.keepSnap('ask', { ...a, messages: [...a.messages, { role: 'assistant', text: 'One answers' }] }, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 1002),
    ])
    expect(((await ext.snapOf('ask', PAGE, 2000, 'walnut')) as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(['Window one asks', 'One answers'])
    expect(((await ext.snapOf('ask', PAGE, 2000, 'mentor')) as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(['Window two asks'])
    // A conversation sent under another agent's key is no one's.
    await ext.keepSnap('ask', { ...b, messages: [{ role: 'user', text: 'Wrong key' }] }, { key: askSnapKey('panel', 'walnut'), agentId: 'mentor' }, 3000)
    expect(((await ext.snapOf('ask', PAGE, 4000, 'walnut')) as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('Window one asks')
  })

  it('no agent known (no view has said one yet): nothing is drawn, not even a kept conversation', async () => {
    await ext.keepSnap('ask', conversation, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 1000)
    expect(await ext.agentOf()).toBe('')
    expect(await ext.snapOf('ask', PAGE, 2000)).toBeNull()
    expect(await ext.shellOf(2000)).toBeNull()
    // A name no agent has is no agent.
    await ext.keepAgent('../x y', 1500)
    expect(await ext.agentOf()).toBe('')
  })

  it('words kept under a page\'s key, or the one key for every agent of before, are never drawn as an agent\'s', async () => {
    await ext.keepAgent('walnut', 900)
    await ext.keepSnap('ask', conversation, { key: snapKeyOf(PAGE) }, 1000)
    await ext.keepSnap('ask', conversation, { key: 'panel:current' }, 1000)
    expect(await ext.snapOf('ask', PAGE, 3000)).toBeNull()
    // The agent's open conversation, once kept, is what every page draws, and the old ones go.
    await ext.keepSnap('ask', { ...conversation, messages: [{ role: 'user', text: 'Open one' }] }, { key: askSnapKey('panel', 'walnut'), agentId: 'walnut' }, 2000)
    expect(((await ext.snapOf('ask', PAGE, 3000)) as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('Open one')
    expect(Object.keys((local.panelSnaps as any).ask)).toEqual([askSnapKey('panel', 'walnut')])
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
