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

/** linkedom's form is a plain element: the parts of a form Enter needs, and a count of sends. */
function stubForm(sel: string): { sent: () => number } {
  const form = page.$(sel) as any
  let sent = 0
  Object.defineProperty(form, 'elements', { configurable: true, get: () => [...form.querySelectorAll('input, button, select, textarea')] })
  form.requestSubmit = () => { sent++ }
  // A submit button's click sends its form (the browser's activation behavior).
  for (const b of form.querySelectorAll('button, input[type=submit]')) b.addEventListener('click', () => { if (!b.disabled) sent++ })
  return { sent: () => sent }
}
const clicks = (sel: string) => { let n = 0; page.$(sel).addEventListener('click', () => { n++ }); return () => n }

describe('Enter never sends what a person\'s Enter would not (review 2026-11-10)', () => {
  it('focus on the page itself (after a click on plain text): press Enter clicks nothing and sends no form', async () => {
    page.load('<main><p id="plain">Search settings and preferences</p><form id="f"><input id="name" aria-label="Display name"><button id="submit">Submit</button></form><button id="go">Go</button></main>')
    page.place('#plain', { x: 10, y: 10, w: 300, h: 20 })
    page.place('#submit', { x: 10, y: 60, w: 80, h: 30 })
    page.place('#go', { x: 10, y: 100, w: 80, h: 30 })
    const f = stubForm('#f')
    const go = clicks('#go')
    await op('click', { ref: await refOf('Search settings and preferences') })
    const r = await op('press', { key: 'Enter' })
    expect(r).toEqual({ pressed: 'Enter' })
    expect(f.sent()).toBe(0)
    expect(go()).toBe(0)
  })

  it('a search box beside a button that is no search ("Submit request", "Go Premium"): nothing is clicked', async () => {
    for (const label of ['Submit request', 'Go Premium', 'Submit']) {
      page.load(`<div id="box"><input id="q" aria-label="Search the help center"><button id="b">${label}</button></div>`)
      page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
      page.place('#b', { x: 320, y: 10, w: 120, h: 30 })
      const n = clicks('#b')
      expect(searchButton(page.$('#q')), label).toBeNull()
      const r = await op('type', { ref: await refOf('Search the help center'), text: 'refund', submit: true })
      expect(n(), label).toBe(0)
      expect(r.enter_quiet, label).toBe(true)
    }
  })

  it('a type=submit "Go" counts only inside a search area', async () => {
    page.load('<div role="search" id="s"><input id="q" aria-label="Query"><button id="b" type="submit">Go</button></div>')
    page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
    page.place('#b', { x: 320, y: 10, w: 60, h: 30 })
    expect(searchButton(page.$('#q'))).toBe(page.$('#b'))
  })

  it('the fallback button the outward check holds ("Search and pay") is not clicked', async () => {
    page.load('<div id="box"><input id="q" aria-label="Search flights"><button id="b">Search and pay</button></div>')
    page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
    page.place('#b', { x: 320, y: 10, w: 120, h: 30 })
    expect(searchButton(page.$('#q'))).toBe(page.$('#b'))
    const n = clicks('#b')
    const r = await op('type', { ref: await refOf('Search flights'), text: 'oslo', submit: true })
    expect(n()).toBe(0)
    expect(r.enter_quiet).toBe(true)
  })

  it('a page that goes to another address during the wait: the button is never clicked', async () => {
    const q = searchPage((e) => { if (e.keyCode === 13) (location as unknown as URL).href = 'https://search.example.test/results?q=1' }, '<button id="go" aria-label="Search">Go</button>')
    const n = clicks('#go')
    const r = await op('type', { ref: await refOf('Search the site'), text: 'x', submit: true })
    expect(n()).toBe(0)
    expect(r.submit).toBeUndefined()
    expect(r.enter_quiet).toBeUndefined()
    expect(q.value).toBe('x')
    ;(location as unknown as URL).href = 'https://search.example.test/search'
  })

  it('implicit submission: the default button is clicked; a disabled one, or two fields and no button, send nothing', async () => {
    page.load('<form id="f"><input id="a" aria-label="City"><button id="ok">Save</button></form>')
    page.place('#a', { x: 10, y: 10, w: 300, h: 30 })
    let f = stubForm('#f')
    expect((await op('type', { ref: await refOf('City'), text: 'Oslo', submit: true })).submit).toBe('form')
    expect(f.sent()).toBe(1)
    page.load('<form id="f"><input id="a" aria-label="City"><button id="ok" disabled>Save</button></form>')
    page.place('#a', { x: 10, y: 10, w: 300, h: 30 })
    f = stubForm('#f')
    expect((await op('type', { ref: await refOf('City'), text: 'Oslo', submit: true })).submit).toBeUndefined()
    expect(f.sent()).toBe(0)
    page.load('<form id="f"><input id="a" aria-label="City"><input id="b" aria-label="Country"></form>')
    page.place('#a', { x: 10, y: 10, w: 300, h: 30 })
    f = stubForm('#f')
    expect((await op('type', { ref: await refOf('City'), text: 'Oslo', submit: true })).submit).toBeUndefined()
    expect(f.sent()).toBe(0)
  })
})

describe('Enter goes to the field typed into, judged again', () => {
  it('an input inside an open shadow root gets the Enter itself (not its host), by type --submit and press Enter', async () => {
    page.load('<search-box id="host"></search-box>')
    const host = page.$('#host')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<input id="inner" aria-label="Search the docs">'
    const inner = root.querySelector('#inner') as HTMLInputElement
    page.place(inner, { x: 10, y: 10, w: 300, h: 30 })
    const got: string[] = []
    inner.addEventListener('keydown', (e: any) => { got.push(`${e.key}:${e.keyCode}`) })
    // A browser's document.activeElement is the shadow host; the input is the root's.
    const doc = Object.getOwnPropertyDescriptor(document, 'activeElement')!
    Object.defineProperty(root, 'activeElement', { configurable: true, get: () => inner })
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => host })
    try {
      await op('type', { ref: await refOf('Search the docs'), text: 'api', submit: true })
      expect(got).toEqual(['Enter:13'])
      await op('press', { key: 'Enter' })
      expect(got).toEqual(['Enter:13', 'Enter:13'])
    } finally { Object.defineProperty(document, 'activeElement', doc) }
  })

  it('the page moves the focus to another form after the typing: Enter goes to the typed field\'s form, never the other', async () => {
    page.load('<form id="a"><input id="q" aria-label="Find a store"><button>Find</button></form><form id="b"><input id="card" aria-label="Card number" autocomplete="cc-number"><button>Place order</button></form>')
    page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
    page.place('#card', { x: 10, y: 60, w: 300, h: 30 })
    const a = stubForm('#a')
    const b = stubForm('#b')
    page.$('#q').addEventListener('input', () => (page.$('#card') as HTMLElement).focus())
    await op('type', { ref: await refOf('Find a store'), text: 'oslo', submit: true })
    expect(b.sent()).toBe(0)
    expect(a.sent()).toBe(1)
  })

  it('the page turns the typed field\'s Enter into a payment after the typing: refused, nothing sent', async () => {
    page.load('<form id="a"><input id="q" aria-label="Find a store"><button>Find</button></form>')
    page.place('#q', { x: 10, y: 10, w: 300, h: 30 })
    const a = stubForm('#a')
    page.$('#q').addEventListener('input', () => {
      page.$('#a').insertAdjacentHTML('beforeend', '<input id="card" autocomplete="cc-number" aria-label="Card number">')
      page.$('#a button').textContent = 'Pay now'
    })
    const err = await op('type', { ref: await refOf('Find a store'), text: 'oslo', submit: true }).then(() => null, (e: { code?: string; message?: string }) => e)
    expect(err?.code).toBe('enter_not_sent')
    expect(err?.message).toMatch(/text is typed.*did not press it/)
    expect(a.sent()).toBe(0)
  })
})
