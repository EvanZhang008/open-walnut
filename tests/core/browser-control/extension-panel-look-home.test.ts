/**
 * The side panel's first page drawn by the extension page while Walnut's view loads
 * (packages/browser-extension/src/panel-look-home.ts; its words kept by panel-snap.ts `home` and
 * `mode`): what the view said it shows is kept cut to what a drawing holds, only while a Walnut is
 * connected; the page the view was left on is kept (a task's with its title); the drawing has the
 * view's places (header with the relay pill and the key, the composer with the page chip, the
 * tabs, the rows) and puts every word in as text, never as markup.
 * The browser API is a fake; the DOM is linkedom's.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

const win = parseHTML('<!doctype html><html><body></body></html>')
;(globalThis as any).document = win.document
;(globalThis as any).DOMParser = win.DOMParser

const local: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://self/${p}` },
  storage: { local: { get: async (k: string) => ({ [k]: structuredClone(local[k]) }), set: async (o: Record<string, unknown>) => { Object.assign(local, structuredClone(o)) }, remove: async (ks: string | string[]) => { for (const k of [ks].flat()) delete local[k] } } },
}

const { cleanHome, cleanMode, homeOf, keepHomeSnap, keepMode } = await import('../../../packages/browser-extension/src/panel-snap')
const { drawControlLook, drawHomeLook, drawTaskLook, HOME_PLACEHOLDER } = await import('../../../packages/browser-extension/src/panel-look-home')
const { HOME_PLACEHOLDER: VIEW_PLACEHOLDER } = await import('../../../web/src/popout/ext-home-model')

beforeEach(() => { for (const k of Object.keys(local)) delete local[k]; local.panelServer = 'http://walnut.example.test' })

const HOME = {
  tabs: [{ label: 'All', count: '128', on: true }, { label: 'Focus', count: '12' }],
  heading: 'Needs you (5)',
  rows: [
    { title: 'Rotate the expired API key on Lab Accounts', meta: 'Ops', line: 'Decide: Rotate now or wait for the release?', time: '6m', needs: true },
    { title: 'Ship the extension first page', meta: 'Walnut', line: '', time: 'now', needs: false },
  ],
}

describe('the first page\'s words, kept', () => {
  it('cuts them to what a drawing holds', () => {
    const c = cleanHome({
      tabs: [...Array.from({ length: 9 }, (_, i) => ({ label: `Tab ${i}`, count: '1234567890' })), { label: '' }],
      rows: Array.from({ length: 30 }, (_, i) => ({ title: i === 0 ? 'x'.repeat(500) : `Row ${i}`, needs: i % 2 === 0, meta: 7 })),
      heading: 'h'.repeat(90),
    }, 5)!
    expect(c.tabs).toHaveLength(6)
    expect(c.tabs[0].count).toHaveLength(8)
    expect(c.rows).toHaveLength(10)
    expect(c.rows[0].title).toHaveLength(160)
    expect(c.rows[0].meta).toBe('')
    expect(c.rows[0].needs).toBe(true)
    expect(c.heading).toHaveLength(40)
    expect(c.at).toBe(5)
    expect(cleanHome({ tabs: [], rows: [] }, 1)).toBeNull()
    expect(cleanHome('nope', 1)).toBeNull()
  })

  it('keeps them, and the page the view is on, only while a Walnut is connected', async () => {
    await keepHomeSnap(HOME, 10)
    await keepMode('task', 'Rotate the expired API key', 11)
    let back = await homeOf(20)
    expect(back.home?.rows[0].title).toBe(HOME.rows[0].title)
    expect(back.mode).toEqual({ mode: 'task', title: 'Rotate the expired API key', at: 11 })
    await keepMode('home', 'ignored', 12)
    back = await homeOf(20)
    expect(back.mode).toEqual({ mode: 'home', at: 12 })
    delete local.panelServer
    await keepMode('ask', '', 13)
    expect((await homeOf(20)).mode?.mode).toBe('home')
  })

  it('reads only the three pages', () => {
    expect(cleanMode('tasks', '', 1)).toBeNull()
    expect(cleanMode('ask', 'x', 1)).toEqual({ mode: 'ask', at: 1 })
  })

  it('a drawing two weeks old is not drawn', async () => {
    await keepHomeSnap(HOME, 0)
    expect((await homeOf(15 * 24 * 3600_000)).home).toBeNull()
  })
})

describe('the drawing of the first page', () => {
  const box = () => document.createElement('div')

  it('has the view\'s places (design C): the header with the relay and the key, the tabs, the rows, New task docked last', () => {
    const el = drawHomeLook({ surface: 'panel', home: { at: 1, ...HOME }, page: { title: 'Lab Accounts', host: 'accounts.example.test' }, locked: true, relay: 'tab', settings: false }, box())
    expect(el.dataset.look).toBe('home')
    expect(el.querySelector('[data-testid="panel-snap-relay"]')?.textContent).toBe('Agent in tab')
    expect(el.querySelector('[data-testid="panel-snap-locked"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="panel-snap-placeholder"]')?.textContent).toBe(HOME_PLACEHOLDER)
    // Docked on one line: "This page" (its title on hover) and send; Act in this tab only once it grows.
    const chip = el.querySelector('[data-testid="panel-snap-page"]')!
    expect(chip.textContent).toContain('This page')
    expect(chip.getAttribute('title')).toBe('Walnut reads this page with your next message: Lab Accounts · accounts.example.test')
    expect(el.querySelector('.look-home-act')).toBeNull()
    expect(el.querySelector('.look-home-composer.is-docked .look-send')).not.toBeNull()
    const order = [...el.children].map((c) => c.className.split(' ')[0])
    expect(order.indexOf('look-home-tabs')).toBeLessThan(order.indexOf('look-home-dock'))
    expect(order[order.length - 1]).toBe('look-home-dock')
    expect(el.querySelector('[data-testid="panel-snap-tabs"]')?.textContent).toContain('All128')
    const rows = el.querySelectorAll('.look-home-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.look-dot.is-needs')).not.toBeNull()
    expect(rows[0].textContent).toContain('Decide: Rotate now or wait for the release?')
  })

  it('says the same words as the view', () => {
    expect(HOME_PLACEHOLDER).toBe(VIEW_PLACEHOLDER)
  })

  it('before the view ever showed: the loading line, no page chip on no web page, and the popup\'s side panel button', () => {
    const el = drawHomeLook({ surface: 'popup', home: null, page: null, locked: false, relay: 'off', settings: true }, box())
    expect(el.querySelector('.look-home-loading')?.textContent).toBe('Loading your tasks…')
    expect(el.querySelector('[data-testid="panel-snap-page"]')).toBeNull()
    expect(el.querySelector('.look-home-act')).toBeNull()
    expect(el.querySelector('[data-testid="panel-snap-locked"]')).toBeNull()
    expect(el.querySelector('[data-testid="panel-snap-relay"]')?.textContent).toBe('Relay off')
    expect(el.querySelectorAll('.look-head .look-btn').length).toBe(4)
  })

  it('puts every word in as text, never as markup', () => {
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>'
    const el = drawHomeLook({ surface: 'panel', home: { at: 1, tabs: [{ label: evil }], rows: [{ title: evil, meta: evil, line: evil, time: '', needs: false }] }, page: { title: evil, host: 'a.example.test' }, locked: true, relay: 'on', settings: false }, box())
    expect(el.querySelector('img:not(.look-home-mark)')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toContain('<b>bold</b>')
  })

  it('a task opened there draws its Back and title', () => {
    const el = drawTaskLook({ title: 'Rotate the expired API key', locked: true }, box())
    expect(el.dataset.look).toBe('task')
    expect(el.querySelector('.look-home-back')?.textContent).toBe('Back')
    expect(el.querySelector('[data-testid="panel-snap-title"]')?.textContent).toBe('Rotate the expired API key')
    expect(el.querySelector('[data-testid="panel-snap-placeholder"]')?.textContent).toBe('Ask a follow-up…')
  })

  it('Browser control, as the side bar left it, draws its title and its status', () => {
    const el = drawControlLook({ relay: 'tab', locked: false }, box())
    expect(el.dataset.look).toBe('control')
    expect(el.querySelector('[data-testid="panel-snap-title"]')?.textContent).toBe('Browser control')
    expect(el.querySelector('[data-testid="panel-snap-control"]')?.textContent).toBe('An agent is using this tab')
    expect(drawControlLook({ relay: 'off', locked: true }, box()).querySelector('[data-testid="panel-snap-locked"]')).not.toBeNull()
  })
})
