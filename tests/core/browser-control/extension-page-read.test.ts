/**
 * An agent's reads, small by default (packages/browser-extension/src/page-read.ts, page-probe.ts
 * pageDigest; 2026-11-10: a read-only task took 16 calls and `text` dumped every menu and footer),
 * run for real against a small DOM (page-dom-fake.ts):
 *   - `text` reads the main content (main, its one article, else the page without its navigation,
 *     page header and footer, sidebars and cookie banners), cut at 4000 with how much is left and
 *     how to read more; `ref` or `selector` reads one element; `all` the whole page;
 *   - `snapshot` lists what is on screen, says how many more elements are elsewhere, and shows a
 *     same-site link by its path; `all` the whole page as before;
 *   - `find` gives the best few, best first, and how many matched in all;
 *   - the page's watch counts its own mutations and scrolls (never Walnut's cursor) and hashes its
 *     fields' values, and never carries words.
 */
import { describe, expect, it } from 'vitest'
import { installFakePage } from './page-dom-fake'

const page = installFakePage('https://shop.example.test/issues')
// find walks text nodes (page-agent-forms.ts): linkedom has the walker, not the global.
;(globalThis as any).NodeFilter ??= { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const { pageDigest } = await import('../../../packages/browser-extension/src/page-probe')
const { TEXT_MAX } = await import('../../../packages/browser-extension/src/page-read')

const op = (name: string, args: Record<string, unknown> = {}) => runPageOp(name, args) as Promise<Record<string, any>>
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)

const chrome = `<header id="top"><a href="/">Home</a> Site menu words</header>
  <nav><a href="/a">Nav link one</a></nav>
  <div id="cookie-banner" style="position:fixed">We use cookies</div>`

describe('text', () => {
  it('reads main when the page has one: no menus, page header, footer, sidebar or cookie banner', async () => {
    page.load(`${chrome}<main id="m"><header><h1>Login fails on Safari</h1></header><p>First paragraph of the issue.</p><aside>Labels: bug</aside></main><footer>Footer words</footer>`)
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const r = await op('text')
    expect(r.scope).toBe('main content')
    // An article's or main's own header is its content (the issue's title).
    expect(r.text).toContain('Login fails on Safari')
    expect(r.text).toContain('First paragraph of the issue.')
    for (const w of ['Site menu words', 'Nav link one', 'We use cookies', 'Footer words', 'Labels: bug']) expect(r.text).not.toContain(w)
    expect(r.cut).toBeUndefined()
  })

  it('no main: the page without its furniture; furniture-only page: says it has no main text, never reads the furniture', async () => {
    page.load(`${chrome}<div><p>Order a test sandwich</p><div style="display:none">Hidden menu words</div><section class="cookie-recipes">Chocolate chip cookies</section><footer>Footer words</footer></div>`)
    const r = await op('text')
    expect(r.scope).toMatch(/without its menus/)
    expect(r.text).toContain('Order a test sandwich')
    // A box named "cookie" that is not laid over the page is content (a recipe), not a notice.
    expect(r.text).toContain('Chocolate chip cookies')
    for (const w of ['Site menu words', 'Footer words', 'Hidden menu words', 'We use cookies']) expect(r.text).not.toContain(w)
    page.load('<nav><a id="l" href="/x">Only links here</a></nav><footer>Footer words</footer>')
    page.place('#l', { x: 0, y: 0, w: 200, h: 20 })
    const none = await op('text')
    expect(none.text).toMatch(/^No main text on this page \(text --all reads its menus, header and footer\)\./)
    expect(none.text).not.toContain('Footer words')
    // A page with no text lists what is on screen, links too when nothing else is there.
    expect(none.text).toMatch(/On screen to act on:\n\[e\d+\] link "Only links here"/)
    expect((await op('text', { all: true })).text).toContain('Only links here')
  })

  it('a footer main holds directly is the page\'s footer, not content; an article\'s own footer is (2026-11-10: a search page read as its legal links)', async () => {
    page.load('<header><input id="q" type="search" aria-label="Search the site"><button id="menu">Open menu</button><a id="home" href="/">Home</a></header>'
      + '<main id="m"><div><span>Tip</span>For an advanced search, use our prefixes</div>'
      + '<footer><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> Example, Inc. 2026</footer></main>')
    page.place('#m', { x: 0, y: 60, w: 800, h: 400 })
    for (const [sel, y] of [['#q', 10], ['#menu', 10], ['#home', 10]] as const) page.place(sel, { x: 0, y, w: 100, h: 20 })
    const r = await op('text')
    expect(r.scope).toBe('main content')
    for (const w of ['Terms', 'Privacy', 'Example, Inc.']) expect(r.text).not.toContain(w)
    // Little text and a field on screen: the text, then the fields and buttons with the refs snapshot gives (no links).
    const [text, list] = String(r.text).split('\n\nOn screen to act on:\n')
    expect(text).toContain('For an advanced search, use our prefixes')
    const lines = list.split('\n')
    expect(lines[0]).toMatch(/^\[e\d+\] searchbox "Search the site"/)
    expect(lines[1]).toMatch(/^\[e\d+\] button "Open menu"/)
    expect(list).not.toContain('Home')
    const snap = String((await op('snapshot')).snapshot)
    for (const l of lines) expect(snap).toContain(l)
    expect(r.chars).toBe(text.length)

    page.load('<main id="m"><article><p>A post.</p><footer>Posted by a test author</footer></article><section><p>Notes</p><footer>Section words</footer></section></main>')
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const kept = await op('text')
    expect(kept.text).toContain('Posted by a test author')
    expect(kept.text).toContain('Section words')

    // A quote's or a card's footer is content; so is a modal's (its buttons), and a footer that does not end main.
    page.load('<main id="m"><blockquote><p>Quote text</p><footer>Jane Example, 2024</footer></blockquote>'
      + '<div class="card"><h3>Pro plan</h3><footer>Ten a month</footer></div><p>After the cards.</p></main>')
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const cards = String((await op('text')).text)
    for (const w of ['Jane Example, 2024', 'Ten a month', 'After the cards.']) expect(cards).toContain(w)
    page.load('<main id="m"><p>Behind</p></main><div id="d" aria-modal="true"><p>Delete this project?</p><footer><button>Cancel</button><button>Delete</button></footer></div>')
    page.place('#d', { x: 0, y: 0, w: 400, h: 200 })
    const modal = String((await op('text')).text)
    expect(modal).toContain('Delete this project?')
    expect(modal).toContain('Cancel')
  })

  it('an empty main: no main text, and the fields and buttons on screen; a short page with no field is its text alone', async () => {
    page.load('<header><input id="q" aria-label="Find a product"></header><main id="m"></main><footer>Footer words</footer>')
    page.place('#m', { x: 0, y: 60, w: 800, h: 400 })
    page.place('#q', { x: 0, y: 10, w: 200, h: 20 })
    const r = await op('text')
    expect(r.text).toMatch(/^No main text on this page[^\n]*\n\nOn screen to act on:\n\[e\d+\] textbox "Find a product"$/)
    expect(r.chars).toBe(0)
    page.load('<header><a id="h" href="/">Home</a></header><main id="m"><h1>Issues</h1><p>12 Open</p><a id="i" href="/issues/1">Login fails</a></main>')
    page.place('#m', { x: 0, y: 60, w: 800, h: 400 })
    page.place('#h', { x: 0, y: 10, w: 100, h: 20 })
    page.place('#i', { x: 0, y: 100, w: 100, h: 20 })
    const short = await op('text')
    expect(short.text).toBe('Issues\n12 Open\nLogin fails')
  })

  it('a page header holding the page\'s title is read; an open modal dialog is what the page shows, read first', async () => {
    page.load('<header><h1>Release notes</h1><a href="/">Home</a></header><div><p>Version 2 is out.</p></div>')
    const r = await op('text')
    expect(r.text).toContain('Release notes')
    expect(r.text).toContain('Version 2 is out.')
    page.load(`${chrome}<main id="m"><p>Behind the dialog.</p></main><div id="d" role="dialog" aria-modal="true"><h2>Delete this issue?</h2><button>Delete</button></div>`
      + '<div id="c" role="dialog" class="cookie-consent">We use cookies</div>')
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    page.place('#d', { x: 100, y: 100, w: 300, h: 200 })
    page.place('#c', { x: 0, y: 500, w: 800, h: 60 })
    const d = await op('text')
    expect(d.scope).toMatch(/^the open dialog/)
    expect(d.text).toContain('Delete this issue?')
    expect(d.text).not.toContain('Behind the dialog.')
  })

  it('a long text is cut at 4000 and says how much is left and how to read more; max reads more', async () => {
    page.load(`<main id="m"><p>${'word '.repeat(3000)}</p></main>`)
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const r = await op('text')
    expect(r.cut).toBe(true)
    expect(r.chars).toBeGreaterThan(TEXT_MAX)
    expect(r.text.length).toBeLessThan(TEXT_MAX + 200)
    expect(r.text).toMatch(/… \(\d+ more characters: --max N \(max\) reads more, --ref e12 or --selector css/)
    const more = await op('text', { max: 20_000 })
    expect(more.cut).toBeUndefined()
  })

  it('ref or selector reads one element; all reads the whole page', async () => {
    page.load(`${chrome}<main id="m"><p id="p1">First paragraph.</p><p id="p2">Second paragraph.</p></main>`)
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const sel = await op('text', { selector: '#p2' })
    expect(sel).toMatchObject({ text: 'Second paragraph.', scope: '#p2' })
    expect(await code(op('text', { selector: '#nope' }))).toBe('not_found')
    expect(await code(op('text', { selector: '((' }))).toBe('bad_request')
    const whole = await op('text', { all: true })
    expect(whole.text).toContain('Site menu words')
    expect(whole.scope).toBe('the whole page')
  })
})

describe('text keeps the words innerText misses: a shadow root\'s and a date\'s', () => {
  it('a relative-time drawn in its shadow root reads with its full date; an empty time reads its datetime; a component\'s shadow words', async () => {
    page.load('<main id="m"><p id="r">github-actions released this <relative-time id="rt" datetime="2026-11-10T12:11:37Z" title="Nov 10, 2026, 4:11 AM PST"></relative-time></p>'
      + '<p>Updated <time id="t" datetime="2026-11-09T08:00:00Z"></time></p><x-label id="x"></x-label><p>Plain words.</p></main>')
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    page.$('#rt').attachShadow({ mode: 'open' }).innerHTML = '<span part="root">37 minutes ago</span>'
    const sr = page.$('#x').attachShadow({ mode: 'open' })
    sr.innerHTML = '<style>b { color: red }</style><span>Shadow words</span>'
    const r = await op('text')
    expect(r.text).toContain('released this')
    expect(r.text).toContain('37 minutes ago (Nov 10, 2026, 4:11 AM PST)')
    expect(r.text).toMatch(/Updated\n\w{3} \d{1,2}, 2026/)
    expect(r.text).toContain('Shadow words')
    expect(r.text).not.toContain('color: red')
    expect(r.text).toContain('Plain words.')
    // One element by its selector, and the whole page, read the same way.
    expect((await op('text', { selector: '#r' })).text).toContain('Nov 10, 2026, 4:11 AM PST')
    expect((await op('text', { all: true })).text).toContain('37 minutes ago')
  })

  it('a date element with only its title (no shadow root, no words) reads its title', async () => {
    page.load('<main id="m"><span>Opened <relative-time datetime="2026-11-10T12:11:37Z" title="Nov 10, 2026, 4:11 AM PST"></relative-time> by someone</span></main>')
    page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
    const r = await op('text')
    expect(r.text).toContain('Nov 10, 2026, 4:11 AM PST')
    expect(r.text).toContain('by someone')
  })
})

describe('deep shadow trees (an app shell that slots the page into nested components)', () => {
  it('words slotted through six nested hosts, and a date twelve elements deep in light content, are kept; past the depth cap a host reads its own text, never nothing', async () => {
    const g = globalThis as any
    // linkedom has no slot assignment: a slot shows its host's children.
    const was = g.HTMLElement.prototype.assignedNodes
    g.HTMLElement.prototype.assignedNodes = function (this: Element) { const host = (this.getRootNode?.() as ShadowRoot | undefined)?.host; return host ? Array.from(host.childNodes) : [] }
    try {
      let inner = '<p>Slotted page words</p><div><div><div><div><div><div><div><div><div><div><div><div><span>Updated <time datetime="2026-11-09T08:00:00Z" title="Nov 9, 2026"></time></span></div></div></div></div></div></div></div></div></div></div></div></div>'
      for (let i = 0; i < 6; i++) inner = `<app-${i}>${inner}</app-${i}>`
      page.load(`<main id="m">${inner}</main>`)
      page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
      for (let i = 0; i < 6; i++) page.$(`app-${i}`).attachShadow({ mode: 'open' }).innerHTML = `<div class="frame-${i}"><slot></slot></div>`
      const r = await op('text')
      expect(r.text).toContain('Slotted page words')
      expect(r.text).toContain('Nov 9, 2026')
      // A host whose shadow root draws nothing past the cap still reads its light words.
      page.load('<main id="m"><x-deep id="d">Light words of the host</x-deep></main>')
      page.place('#m', { x: 0, y: 0, w: 800, h: 400 })
      let host: Element = page.$('#d')
      for (let i = 0; i < 12; i++) { const root = host.attachShadow({ mode: 'open' }); root.innerHTML = `<x-deep-${i}></x-deep-${i}>`; host = root.firstElementChild! }
      expect((await op('text')).text).toContain('Light words of the host')
    } finally { g.HTMLElement.prototype.assignedNodes = was }
  })
})

describe('snapshot', () => {
  it('lists what is on screen, says how many more elsewhere, and shows a same-site link by its path', async () => {
    page.load('<h1 id="h">Issues</h1><a id="a1" href="https://shop.example.test/issues/12">Login fails</a><a id="a2" href="https://other.test/x">Elsewhere</a>'
      + '<button id="far">Far below</button>', { pageHeight: 5000 })
    page.place('#h', { x: 0, y: 0, w: 300, h: 30 })
    page.place('#a1', { x: 0, y: 50, w: 200, h: 20 })
    page.place('#a2', { x: 0, y: 80, w: 200, h: 20 })
    page.place('#far', { x: 0, y: 4000, w: 200, h: 20 })
    const r = await op('snapshot')
    expect(r.snapshot).toContain('h1 Issues')
    expect(r.snapshot).toMatch(/\[e\d+\] link "Login fails" -> \/issues\/12/)
    expect(r.snapshot).toContain('-> https://other.test/x')
    expect(r.snapshot).not.toContain('Far below')
    expect(r.more).toBe(1)
    expect(r.snapshot).toMatch(/1 more element\(s\) off screen: find <words> finds one, snapshot --all/)
    const all = await op('snapshot', { all: true })
    expect(all.snapshot).toContain('Far below')
    expect(all.more).toBeUndefined()
  })
})

describe('snapshot: on screen means on screen', () => {
  it('elements just below the screen are under their own heading, never flagged offscreen under "on screen"', async () => {
    page.load('<a id="top" href="/s">Skip to content</a><input id="q" aria-label="Search the site"><a id="foot" href="/terms">Terms</a><a id="far" href="/x">Far</a>', { pageHeight: 5000 })
    page.place('#top', { x: 0, y: 0, w: 100, h: 20 })
    page.place('#q', { x: 0, y: 40, w: 300, h: 30 })
    page.place('#foot', { x: 0, y: 900, w: 100, h: 20 })
    page.place('#far', { x: 0, y: 4000, w: 100, h: 20 })
    const r = await op('snapshot')
    const [onScreen, near] = r.snapshot.split('Just off screen')
    expect(onScreen).toContain('"Skip to content"')
    expect(onScreen).toContain('"Search the site"')
    expect(onScreen).not.toContain('Terms')
    expect(near).toMatch(/\[e\d+\] link "Terms" -> \/terms\n/)
    expect(r.snapshot).not.toMatch(/offscreen/)
    expect(r.more).toBe(1)
  })
})

describe('find', () => {
  it('the best few, best first (the whole name of a control before text that holds the words), and how many in all', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `<p id="p${i}">Checkout note ${i}</p>`).join('')
    page.load(`${many}<button id="b">Checkout</button>`)
    for (let i = 0; i < 12; i++) page.place(`#p${i}`, { x: 0, y: 20 * i, w: 300, h: 18 })
    page.place('#b', { x: 0, y: 300, w: 100, h: 20 })
    const r = await op('find', { text: 'checkout' })
    expect(r.matches).toHaveLength(8)
    expect(r.matches[0]).toMatchObject({ role: 'button', name: 'Checkout' })
    expect(r.count).toBe(13)
  })
})

describe('find: a phrase no text holds falls back to the words on controls', () => {
  it('"search box" finds the textbox named "Search GitHub"; role words pick the kind; the answer says it matched by words', async () => {
    page.load(`<a id="l" href="/s">Search tips</a><input id="q" aria-label="Search GitHub"><button id="go">Search</button>`)
    for (const [id, y] of [['#l', 0], ['#q', 30], ['#go', 60]] as const) page.place(id, { x: 0, y, w: 200, h: 20 })
    const r = await op('find', { text: 'search box' })
    expect(r.matches[0]).toMatchObject({ role: 'textbox', name: 'Search GitHub' })
    expect(r.matches).toHaveLength(1)
    expect(r.by_words).toBe('search')
    const b = await op('find', { text: 'search button' })
    expect(b.matches[0]).toMatchObject({ role: 'button', name: 'Search' })
    // Every word must be in the name, in any order.
    expect((await op('find', { text: 'github search' })).matches[0]).toMatchObject({ name: 'Search GitHub' })
    expect((await op('find', { text: 'gitlab search' })).matches).toHaveLength(0)
  })
  it('only when the phrase found nothing, never with exact, never for one word alone', async () => {
    page.load(`<input id="q" aria-label="Search GitHub"><p id="t">the search box is above</p>`)
    page.place('#q', { x: 0, y: 0, w: 200, h: 20 }); page.place('#t', { x: 0, y: 30, w: 200, h: 20 })
    const r = await op('find', { text: 'search box' })
    expect(r.matches[0].text).toBe('the search box is above')
    expect(r.by_words).toBeUndefined()
    page.load(`<input id="q" aria-label="Search GitHub">`)
    page.place('#q', { x: 0, y: 0, w: 200, h: 20 })
    expect((await op('find', { text: 'search box', exact: true })).matches).toHaveLength(0)
    expect((await op('find', { text: 'searching' })).matches).toHaveLength(0)
    expect((await op('find', { text: 'box' })).matches).toHaveLength(0)
  })
})

describe('find: the short text first, never only the region around it', () => {
  it('a page region focusable as a whole (a tabindex) is not the match; the short leaf text is, and its ref reads', async () => {
    const long = 'claude-code Public Watch 903 Fork 24.9k Star 155k main 222 Branches 266 Tags ' + 'more words in the region '.repeat(12)
    page.load(`<div id="region" tabindex="0"><p>${long}</p><div class="side"><span id="count">155k stars</span></div></div><p id="block">${'A long paragraph that mentions stars once. '.repeat(8)}</p>`)
    page.place('#region', { x: 0, y: 0, w: 900, h: 500 })
    page.place('#count', { x: 700, y: 100, w: 100, h: 20 })
    page.place('#block', { x: 0, y: 520, w: 900, h: 100 })
    const r = await op('find', { text: 'stars' })
    expect(r.matches[0]).toMatchObject({ role: 'generic', name: '155k stars' })
    expect(r.matches.some((m: { name: string }) => m.name.startsWith('claude-code Public'))).toBe(false)
    // The long block that holds the word comes after the short text.
    expect(r.matches[1].text).toMatch(/^A long paragraph/)
    expect((await op('text', { ref: r.matches[0].ref })).text).toBe('155k stars')
  })
})

describe('the page\'s watch (what an acting step changed)', () => {
  it('counts the page\'s own changes and scrolls, not Walnut\'s, hashes the fields\' values, and carries no words', () => {
    const g = globalThis as any
    let observed: ((recs: unknown[]) => void) | undefined
    const scrolls: Array<() => void> = []
    const was = { MO: g.MutationObserver, add: g.addEventListener, remove: g.removeEventListener }
    g.MutationObserver = class { constructor(cb: (recs: unknown[]) => void) { observed = cb } observe() {} disconnect() { observed = undefined } }
    g.addEventListener = (t: string, fn: () => void) => { if (t === 'scroll') scrolls.push(fn) }
    g.removeEventListener = (t: string, fn: () => void) => { if (t === 'scroll') scrolls.splice(scrolls.indexOf(fn), 1) }
    try {
      page.load('<p id="t">Hello</p><input id="f" value="secret-value"><walnut-ext id="w"><i>cursor</i></walnut-ext>', { pageHeight: 3000 })
      const a = pageDigest({ watch: 'wabc123' })
      expect(JSON.stringify(a)).not.toMatch(/Hello|secret-value/)
      // Walnut's own cursor moving, or put in, is not the page's change.
      const w = page.$('#w')
      observed!([{ type: 'attributes', target: w.firstElementChild }, { type: 'childList', target: document.body, addedNodes: [w], removedNodes: [] }])
      expect(pageDigest({ read: 'wabc123' })).toMatchObject({ watching: true, mutations: 0, scrolls: 0 })
      // An attribute of the page's own (a class that opens a menu) is.
      observed!([{ type: 'attributes', target: page.$('#t') }])
      scrolls.forEach((fn) => fn())
      expect(pageDigest({ read: 'wabc123' })).toMatchObject({ watching: true, mutations: 1, scrolls: 1 })
      ;(page.$('#f') as HTMLInputElement).value = 'other'
      const b = pageDigest({ read: 'wabc123', done: true })
      expect(b.values).not.toBe(a.values)
      expect(JSON.stringify(b)).not.toMatch(/other|secret-value/)
      // Done: the watch is gone, its listeners too; a watch this document never started reads so.
      expect(pageDigest({ read: 'wabc123' })).toMatchObject({ watching: false })
      expect(observed).toBeUndefined()
      expect(scrolls).toHaveLength(0)
      page.scroll.y = 500
      expect(pageDigest().scroll).not.toBe(a.scroll)
    } finally { g.MutationObserver = was.MO; g.addEventListener = was.add; g.removeEventListener = was.remove }
  })
})
