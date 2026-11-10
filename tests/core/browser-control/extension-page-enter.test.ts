/**
 * Enter as page events (packages/browser-extension/src/page-enter.ts, page-agent.ts key, the
 * watch's mark in page-probe.ts, agent-change.ts enterLine; 2026-11-10: in a covered agent window a
 * site's search box, with no form and a script testing `keyCode === 13`, took the typed text and
 * ignored the Enter, and `type --submit` said "the page content changed"):
 *   - every key event carries key, code and the legacy keyCode / which (charCode on keypress);
 *   - a formless field whose script tests keyCode 13 is submitted by `type --submit` and by `press Enter`;
 *   - a form is sent when its page did not take the key;
 *   - a search box whose page ignores the key: its Search button is clicked, as a last resort;
 *     a field that is no search (a chat box) never gets its Send button clicked;
 *   - the watch tells the field's own change (its value attribute, its box's clear icon) from the
 *     page's, and the Enter's part from the typing's; the answer line says which.
 */
import { describe, expect, it } from 'vitest'
import { installFakePage, recordEvents } from './page-dom-fake'

const page = installFakePage('https://search.example.test/search')
const g = globalThis as any
;(globalThis as any).NodeFilter ??= { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }
const ev = () => ({ addListener() {}, removeListener() {} })
g.chrome ??= {
  runtime: { id: 'test', getURL: (p: string) => p, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
  tabs: { onCreated: ev(), onRemoved: ev(), onUpdated: ev() },
}
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const { pageDigest } = await import('../../../packages/browser-extension/src/page-probe')
const { key } = await import('../../../packages/browser-extension/src/page-agent')
const { searchButton } = await import('../../../packages/browser-extension/src/page-enter')
const { enterLine, ENTER_NOTHING } = await import('../../../packages/browser-extension/src/agent-change')

const op = (name: string, args: Record<string, unknown> = {}) => runPageOp(name, args) as Promise<Record<string, any>>
const settle = () => new Promise((r) => setTimeout(r, 0))
const refOf = async (words: string) => (await op('find', { text: words })).matches[0].ref as string

/** A search box as a site builds it with no form: a wrapper with an icon, and a script on the page that tests keyCode. */
function searchPage(listen: (e: KeyboardEvent, field: HTMLInputElement) => void, button = ''): HTMLInputElement {
  page.load(`<div id="box"><span id="wrap"><input id="q" aria-label="Search the site" placeholder="Search the site"><span id="icon"></span></span>${button}</div><div id="results"></div>`)
  page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
  if (button) page.place('#box button', { x: 320, y: 10, w: 80, h: 30 })
  const q = page.$('#q') as HTMLInputElement
  // The page's own script, delegated at a box around the field as a framework's is.
  page.$('#box').addEventListener('keydown', (e) => listen(e as KeyboardEvent, q))
  // Its clear icon shows once the box has text (the field's own box changes, not the page).
  q.addEventListener('input', () => { page.$('#icon').setAttribute('class', q.value ? 'clear' : '') })
  return q
}

const results = (q: HTMLInputElement) => { page.$('#results').innerHTML = `<p>Results for ${q.value}</p>` }

describe('key events carry the legacy key numbers', () => {
  it('Enter: key, code, keyCode 13, which 13; keypress charCode 13; a letter its code', () => {
    page.load('<input id="f">')
    const f = page.$('#f')
    const got: any[] = []
    for (const t of ['keydown', 'keypress', 'keyup']) f.addEventListener(t, (e: any) => got.push({ t, key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, charCode: e.charCode, bubbles: e.bubbles, composed: e.composed }))
    key(f, 'Enter', 'keydown'); key(f, 'Enter', 'keypress'); key(f, 'a', 'keydown')
    expect(got[0]).toMatchObject({ t: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 0, bubbles: true, composed: true })
    expect(got[1]).toMatchObject({ t: 'keypress', key: 'Enter', keyCode: 13, which: 13, charCode: 13 })
    expect(got[2]).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65 })
  })
})

describe('a formless search box', () => {
  it('type --submit: the page\'s keyCode 13 handler searches; the Enter\'s change is told apart from the typing', async () => {
    const q = searchPage((e, f) => { if (e.keyCode === 13 && f.value) results(f) })
    const ref = await refOf('Search the site')
    pageDigest({ watch: 'wenter1' })
    const before = { url: location.href, ...pageDigest() }
    const r = await op('type', { ref, text: 'walnut personal ai', submit: true })
    expect(r).toEqual({ typed: '18 characters into textbox "Search the site"' })
    await settle()
    expect(page.$('#results').textContent).toBe('Results for walnut personal ai')
    const after = { url: location.href, ...pageDigest({ read: 'wenter1', done: true }) } as any
    // The typing changed only the field (its clear icon is its own box); the Enter changed the page.
    expect(after.enter.mutations).toBeGreaterThan(0)
    expect(after.mutations).toBe(after.enter.mutations)
    expect(enterLine(before, after, r)).toBe('Enter: the page content changed (no navigation)')
    expect(q.value).toBe('walnut personal ai')
  })

  it('press Enter in it does the same', async () => {
    const q = searchPage((e, f) => { if (e.key === 'Enter' && e.which === 13) results(f) })
    await op('type', { ref: await refOf('Search the site'), text: 'cats' })
    const r = await op('press', { key: 'Enter' })
    expect(r).toEqual({ pressed: 'Enter' })
    expect(page.$('#results').textContent).toBe(`Results for ${q.value}`)
  })

  it('a page that ignores the Enter: its Search button is clicked, as the last resort, and the answer says so', async () => {
    const q = searchPage(() => undefined, '<button id="go" aria-label="Search">Go</button>')
    page.$('#go').addEventListener('click', () => results(q))
    const r = await op('type', { ref: await refOf('Search the site'), text: 'dogs', submit: true })
    expect(r.submit).toBe('button "Search"')
    expect(page.$('#results').textContent).toBe('Results for dogs')
    const before = { url: location.href, doc: 'd', values: 1, scroll: 0 }
    expect(enterLine(before, { ...before, watching: true, mutations: 1, scrolls: 0, enter: { mutations: 1, scrolls: 0, values: false, scroll: false } }, r))
      .toBe('Enter changed nothing, so it clicked button "Search": the page content changed (no navigation)')
  })

  it('no search button, or a clear button only: nothing is clicked and the answer says Enter changed nothing', async () => {
    searchPage(() => undefined, '<button id="x" aria-label="Clear search">x</button>')
    const r = await op('type', { ref: await refOf('Search the site'), text: 'dogs', submit: true })
    expect(r.enter_quiet).toBe(true)
    expect(r.submit).toBeUndefined()
    const before = { url: location.href, doc: 'd', values: 1, scroll: 0 }
    const line = enterLine(before, { ...before, values: 2, watching: true, mutations: 0, fields: 3, scrolls: 0, enter: { mutations: 0, scrolls: 0, values: false, scroll: false } }, r)
    expect(line).toBe(ENTER_NOTHING)
    expect(line).toMatch(/no navigation, nothing submitted.*find search/)
  })

  it('a field that is no search: the button beside it is never clicked for an Enter the page ignored', async () => {
    page.load('<div><input id="m" aria-label="Label name"><button id="add">Go</button></div>')
    page.place('#m', { x: 10, y: 10, w: 300, h: 30 })
    page.place('#add', { x: 320, y: 10, w: 80, h: 30 })
    let clicked = 0
    page.$('#add').addEventListener('click', () => { clicked++ })
    expect(searchButton(page.$('#m'))).toBeNull()
    const ref = await refOf('Label name')
    // A lone box with a button reads as a message box: its Enter waits for the person's yes first.
    const asked = await op('type', { ref, text: 'bug', submit: true })
    expect(asked.hold?.kind).toBe('send')
    const r = await op('type', { ref, text: 'bug', submit: true, outward_ok: asked.hold.sig })
    expect(r.typed).toBeDefined()
    expect(clicked).toBe(0)
    expect(r.enter_quiet).toBe(true)
  })
})

describe('a field in a form', () => {
  it('Enter the page did not take sends the form; one it took does not', async () => {
    page.load('<form id="f"><input id="q" aria-label="Find"></form>')
    page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
    // linkedom's form is a plain element: the two parts of a form this needs.
    const form = page.$('#f') as any
    let sent = 0
    Object.defineProperty(form, 'elements', { get: () => [...form.querySelectorAll('input, button')] })
    form.requestSubmit = () => { sent++ }
    const seen = recordEvents(['keydown', 'keypress', 'keyup'])
    const r = await op('type', { ref: await refOf('Find'), text: 'x', submit: true })
    expect(r.submit).toBe('form')
    expect(sent).toBe(1)
    expect(seen.slice(-3)).toEqual(['keydown Enter', 'keypress Enter', 'keyup Enter'])
    page.$('#q').addEventListener('keydown', (e) => e.preventDefault())
    await op('press', { key: 'Enter' })
    expect(sent).toBe(1)
    // A browser sends no keypress for a keydown the page took.
    expect(seen.slice(-2)).toEqual(['keydown Enter', 'keyup Enter'])
  })
})

describe('the watch: the field\'s own change is not the page\'s', () => {
  it('the field\'s value attribute and its box\'s icon count as the field; a change outside counts as the page', async () => {
    const q = searchPage(() => undefined)
    q.focus()
    pageDigest({ watch: 'wfield1' })
    q.setAttribute('value', 'typed')
    page.$('#icon').setAttribute('class', 'clear')
    await settle()
    expect(pageDigest({ read: 'wfield1' })).toMatchObject({ mutations: 0 })
    expect((pageDigest({ read: 'wfield1' }) as any).fields).toBeGreaterThan(0)
    page.$('#results').innerHTML = '<p>new</p>'
    await settle()
    expect((pageDigest({ read: 'wfield1', done: true }) as any).mutations).toBeGreaterThan(0)
  })

  it('the answer line: only the field moved is "a field\'s value changed", never "the page content changed"', async () => {
    const { changedLine } = await import('../../../packages/browser-extension/src/agent-change')
    const before = { url: 'https://x.test/a', doc: 'd1', values: 1, scroll: 0 }
    expect(changedLine(before, { ...before, watching: true, mutations: 0, fields: 4, scrolls: 0 }, {})).toBe('a field\'s value changed')
    // An Enter whose address moved, and a page script that never saw the mark (the two are not told apart).
    expect(enterLine(before, { ...before, url: 'https://x.test/s?q=1', watching: true, mutations: 9, scrolls: 0 }, { url: 'https://x.test/s?q=1' })).toBe('Enter: went to https://x.test/s?q=1')
    expect(enterLine(before, { ...before, watching: true, mutations: 9, scrolls: 0 }, {})).toMatch(/the typing or its Enter/)
    expect(enterLine(before, { ...before, values: 2, watching: true, mutations: 0, scrolls: 0 }, {})).toBe(ENTER_NOTHING)
  })
})
