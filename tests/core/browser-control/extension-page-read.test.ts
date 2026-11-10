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

  it('no main: the page without its furniture; furniture-only page: the whole of it', async () => {
    page.load(`${chrome}<div><p>Order a test sandwich</p><div style="display:none">Hidden menu words</div><section class="cookie-recipes">Chocolate chip cookies</section><footer>Footer words</footer></div>`)
    const r = await op('text')
    expect(r.scope).toMatch(/without its menus/)
    expect(r.text).toContain('Order a test sandwich')
    // A box named "cookie" that is not laid over the page is content (a recipe), not a notice.
    expect(r.text).toContain('Chocolate chip cookies')
    for (const w of ['Site menu words', 'Footer words', 'Hidden menu words', 'We use cookies']) expect(r.text).not.toContain(w)
    page.load('<nav><a href="/x">Only links here</a></nav>')
    expect((await op('text')).text).toContain('Only links here')
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
