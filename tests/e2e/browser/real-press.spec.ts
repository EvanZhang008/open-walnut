// A press is one press: a link in a script-less sandboxed frame or on the page opens one tab and one request, never a second from a preflight.
import { test, expect, type Page } from '@playwright/test'
import { dragAcrossWords, press } from './real-press'

const SITE = 'https://press.example.test'

async function serve(pageArg: Page, body: string): Promise<{ hits: string[]; opened: Page[] }> {
  const hits: string[] = []
  const opened: Page[] = []
  await pageArg.context().route(`${SITE}/**`, async (route) => {
    hits.push(new URL(route.request().url()).pathname)
    await route.fulfill({ contentType: 'text/html', body: '<h1>Outside page</h1>' })
  })
  pageArg.context().on('page', (p) => opened.push(p))
  await pageArg.setContent(`<!doctype html><body style="margin:0;font:16px/20px sans-serif">${body}</body>`)
  return { hits, opened }
}

async function page(pageArg: Page): Promise<{ hits: string[] }> {
  const hits: string[] = []
  await pageArg.context().route(`${SITE}/**`, async (route) => {
    hits.push(new URL(route.request().url()).pathname)
    await route.fulfill({ contentType: 'text/html', body: '<h1>Outside page</h1>' })
  })
  const framed = `<a href="${SITE}/framed" target="_blank">Framed link</a>`
  await pageArg.setContent(`<!doctype html><body style="margin:40px">
    <p><a href="${SITE}/plain" target="_blank">Plain link</a></p>
    <div id="clamp" style="width:220px;font:16px/20px sans-serif;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">Read the whole note at <a href="${SITE}/clamped" target="_blank">a link whose words run over three lines of this narrow box and past its clamp</a></div>
    <iframe title="letter" sandbox="allow-popups allow-popups-to-escape-sandbox" style="width:400px;height:120px;border:4px solid #888;padding:6px"
      srcdoc='${framed}'></iframe>
  </body>`)
  return { hits }
}

for (const which of ['plain', 'framed', 'clamped'] as const) {
  test(`press opens the ${which} link once: one new tab, one request`, async ({ page: tab, context }) => {
    const { hits } = await page(tab)
    const link = which === 'plain' ? tab.getByRole('link', { name: 'Plain link' })
      : which === 'clamped' ? tab.locator('#clamp a')
      : tab.frameLocator('iframe[title="letter"]').getByRole('link', { name: 'Framed link' })
    const opened: Page[] = []
    context.on('page', (p) => opened.push(p))
    await press(tab, link)
    await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1)
    await expect(opened[0]!.getByRole('heading', { name: 'Outside page' })).toBeVisible()
    // Long enough for a second press, had there been one, to have opened its tab.
    await tab.waitForTimeout(1_500)
    expect(opened.length).toBe(1)
    expect(hits).toEqual([`/${which}`])
  })
}

test('a drag that selects the words before a link opens nothing', async ({ page: tab, context }) => {
  const { hits } = await page(tab)
  const opened: Page[] = []
  context.on('page', (p) => opened.push(p))
  const line = await tab.locator('#clamp').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.firstChild!)
    const r = range.getClientRects()[0]!
    return { x1: r.left + 2, x2: r.right - 4, y: r.top + r.height / 2 }
  })
  await tab.mouse.move(line.x1, line.y)
  await tab.mouse.down()
  await tab.mouse.move(line.x2, line.y, { steps: 12 })
  await tab.mouse.up()
  expect((await tab.evaluate(() => window.getSelection()?.toString() ?? '')).length).toBeGreaterThan(0)
  await tab.waitForTimeout(1_000)
  expect(opened.length).toBe(0)
  expect(hits).toEqual([])
})

// A row narrowed until a long unbroken name starts left of the screen and runs past its row's clip:
// neither its first 25 px nor its middle is on screen, only its tail inside the row.
test('press lands on the visible tail of a long clipped one-line link, with no scroll', async ({ page: tab }) => {
  const name = `${'a-long-unbroken-file-name-part/'.repeat(10)}report.md`
  const { hits, opened } = await serve(tab, `<div id="row" style="margin-left:40px;width:360px;overflow:hidden;white-space:nowrap">
    <div style="margin-left:-260px"><a id="long" href="${SITE}/long" target="_blank">${name}</a></div></div>`)
  const link = tab.locator('#long')
  const shape = await link.evaluate((el) => {
    const rects = el.getClientRects()
    const r = rects[0]!
    const clip = document.getElementById('row')!.getBoundingClientRect()
    return { lines: rects.length, left: r.left, early: r.left + Math.min(r.width / 2, 25), middle: r.left + r.width / 2, clipLeft: clip.left, clipRight: clip.right }
  })
  // The fixture is the case: one line box, its start off screen and its middle past the row's clip.
  expect(shape.lines).toBe(1)
  expect(shape.left).toBeLessThan(0)
  expect(shape.early).toBeLessThan(shape.clipLeft)
  expect(shape.middle).toBeGreaterThan(shape.clipRight)
  const downs: Array<{ x: number; trusted: boolean }> = []
  await tab.exposeFunction('noteDown', (x: number, trusted: boolean) => { downs.push({ x, trusted }) })
  await link.evaluate((el) => el.addEventListener('mousedown', (e) => (window as unknown as { noteDown(x: number, t: boolean): void }).noteDown(e.clientX, e.isTrusted)))
  await press(tab, link)
  await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1)
  await tab.waitForTimeout(1_500)
  expect(opened.length).toBe(1)
  expect(hits).toEqual(['/long'])
  expect(downs).toHaveLength(1)
  expect(downs[0]!.trusted).toBe(true)
  expect(downs[0]!.x).toBeGreaterThan(shape.clipLeft)
  expect(downs[0]!.x).toBeLessThan(shape.clipRight)
  // Already shown, so nothing was scrolled to reach it.
  expect(await tab.evaluate(() => [document.getElementById('row')!.scrollLeft, window.scrollX, window.scrollY])).toEqual([0, 0, 0])
})

// A link wholly past a line clamp is out of a person's reach: the press refuses, and scrolls the clamp open neither.
// WebKit moves an anchor that ends the clamped box up beside the ellipsis, so the link sits in its own later
// block, with more words after it, below a filler block longer than the clamp keeps.
test('press refuses a link that lies wholly past a line clamp: no press, no tab, no scroll', async ({ page: tab }) => {
  const filler = 'These words fill every line the clamp keeps and run on for a while longer so that what follows starts later on. '.repeat(2)
  const { hits, opened } = await serve(tab, `<div id="clampOut" style="margin:40px;width:220px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">`
    + `<div>${filler}</div>`
    + `<div>Then a line with <a href="${SITE}/hidden" target="_blank">hidden link</a> in the middle of it.</div>`
    + `<div>And closing words after it, so no link ends the box.</div></div>`)
  const link = tab.locator('#clampOut a')
  const shape = await link.evaluate((el) => {
    // The clamp box itself: the link's own block is not what clips it.
    const bottom = el.closest('#clampOut')!.getBoundingClientRect().bottom
    const rects = Array.from(el.getClientRects())
    // An engine may also drop the boxes of clamped lines altogether: still out of reach.
    return {
      below: rects.every((r) => r.top >= bottom),
      hittable: rects.some((r) => {
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return Boolean(at && (at === el || el.contains(at)))
      }),
    }
  })
  expect(shape.below).toBe(true)
  expect(shape.hittable).toBe(false)
  let downs = 0
  await tab.exposeFunction('noteDown', () => { downs++ })
  await tab.evaluate(() => document.addEventListener('mousedown', () => (window as unknown as { noteDown(): void }).noteDown(), true))
  await expect(press(tab, link, 2)).rejects.toThrow(/No steady point to press/)
  await tab.waitForTimeout(1_000)
  expect(downs).toBe(0)
  expect(opened.length).toBe(0)
  expect(hits).toEqual([])
  expect(await tab.evaluate(() => [document.getElementById('clampOut')!.scrollTop, window.scrollY])).toEqual([0, 0])
})

// A mail-like summary row: padding above, a button and an icon first, its words in an inline span on a tall line.
// A drag at the box's top left starts on padding or the button; the drag must start on the words.
test('a drag selects the words of an inline span, never the button or the padding before them', async ({ page: tab }) => {
  const words = 'Seven messages from the fixture provider about the release'
  await serve(tab, `<div id="summary" style="margin:40px;padding-top:14px;width:640px;font:13px/30px sans-serif">
    <button id="toggle" type="button">Open group</button>
    <img alt="" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    <span id="words">${words}</span></div>`)
  let pressed = 0
  await tab.exposeFunction('notePress', () => { pressed++ })
  await tab.evaluate(() => document.getElementById('toggle')!.addEventListener('click', () => (window as unknown as { notePress(): void }).notePress()))
  const down: Array<{ trusted: boolean; inWords: boolean }> = []
  await tab.exposeFunction('noteDown', (trusted: boolean, inWords: boolean) => { down.push({ trusted, inWords }) })
  await tab.evaluate(() => document.addEventListener('mousedown', (e) => (window as unknown as { noteDown(t: boolean, w: boolean): void })
    .noteDown(e.isTrusted, document.getElementById('words')!.contains(e.target as Node)), true))
  const selected = await dragAcrossWords(tab, tab.locator('#summary'), 80)
  expect(selected.trim().length).toBeGreaterThan(0)
  expect(selected).not.toContain('Open group')
  expect(words).toContain(selected.trim())
  expect(down).toEqual([{ trusted: true, inWords: true }])
  expect(pressed).toBe(0)
})

// A Needs row's text is an inline span with overflow hidden: overflow does not apply to an inline
// box (its client width is 0), so it clips nothing, and its link is pressed where it shows.
test('an inline span with overflow hidden clips nothing: its link is pressed', async ({ page: tab }) => {
  const { hits, opened } = await serve(tab, `<p style="margin:40px;width:600px">Needs you: <span id="text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">open <a href="${SITE}/inline" target="_blank">design.png</a> and say which</span></p>`)
  const shape = await tab.locator('#text').evaluate((el) => {
    const s = getComputedStyle(el)
    return { display: s.display, overflow: s.overflowX, clientWidth: el.clientWidth, width: el.getBoundingClientRect().width }
  })
  // The fixture is the case: an inline box that computes overflow hidden and has no client area.
  expect(shape).toMatchObject({ display: 'inline', overflow: 'hidden', clientWidth: 0 })
  expect(shape.width).toBeGreaterThan(0)
  await press(tab, tab.locator('#text a'))
  await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1)
  await tab.waitForTimeout(1_000)
  expect(hits).toEqual(['/inline'])
})

// A panel with overflow hidden holds a list that scrolls: a toggle below both is reached by a
// real wheel turn over the list (not a scroll call), then pressed once; the panel never scrolls.
test('a target under a scroller inside an overflow hidden panel is wheeled into view, then pressed once', async ({ page: tab }) => {
  await serve(tab, `<div id="panel" style="margin:40px;width:400px;height:200px;overflow:hidden;display:flex;flex-direction:column">
    <div id="list" style="flex:1;min-height:0;overflow-y:auto"><div style="height:700px">Tasks</div>
    <button id="toggle" type="button">Waiting</button><div style="height:40px"></div></div></div>`)
  const shape = await tab.evaluate(() => ({
    top: document.getElementById('toggle')!.getBoundingClientRect().top,
    panel: document.getElementById('panel')!.getBoundingClientRect().bottom,
  }))
  // The fixture is the case: the toggle lies below the hidden panel's box, not only the list's.
  expect(shape.top).toBeGreaterThan(shape.panel)
  const seen = { wheels: 0, downs: 0, clicks: 0 }
  await tab.exposeFunction('note', (what: 'wheels' | 'downs' | 'clicks') => { seen[what]++ })
  await tab.evaluate(() => {
    const note = (window as unknown as { note(w: string): void }).note
    document.addEventListener('wheel', (e) => { if (e.isTrusted) note('wheels') }, { capture: true, passive: true })
    document.addEventListener('mousedown', (e) => { if (e.isTrusted) note('downs') }, true)
    document.getElementById('toggle')!.addEventListener('click', (e) => { if (e.isTrusted) note('clicks') })
  })
  await press(tab, tab.locator('#toggle'))
  await expect.poll(() => seen.clicks, { timeout: 5_000 }).toBe(1)
  expect(seen.downs).toBe(1)
  expect(seen.wheels).toBeGreaterThan(0)
  const after = await tab.evaluate(() => [document.getElementById('list')!.scrollTop, document.getElementById('panel')!.scrollTop, window.scrollY])
  expect(after[0]).toBeGreaterThan(0)
  expect(after.slice(1)).toEqual([0, 0])
})

// A chat scrolls under its panel's header: a row there is inside every clip yet covered (2026-11-10,
// Chromium: a notice's fold sat under the session header and no press found a point on it).
test('a target covered by a header laid over its scroller is wheeled out from under it, then pressed once', async ({ page: tab }) => {
  await serve(tab, `<div id="panel" style="position:relative;margin:40px;width:400px;height:300px">
    <div id="list" style="position:absolute;inset:0;overflow-y:auto"><div style="height:200px"></div>
    <button id="toggle" type="button">Earlier notice</button><div style="height:900px"></div></div>
    <div id="header" style="position:absolute;left:0;right:0;top:0;height:60px;background:#eef">Header</div></div>`)
  const covered = await tab.evaluate(() => {
    const list = document.getElementById('list')!
    list.scrollTop = document.getElementById('toggle')!.offsetTop - 20
    const r = document.getElementById('toggle')!.getBoundingClientRect()
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id
  })
  // The fixture is the case: the toggle is shown inside the list's box, under the header.
  expect(covered).toBe('header')
  const seen = { wheels: 0, downs: 0, clicks: 0 }
  await tab.exposeFunction('note', (what: 'wheels' | 'downs' | 'clicks') => { seen[what]++ })
  await tab.evaluate(() => {
    const note = (window as unknown as { note(w: string): void }).note
    document.addEventListener('wheel', (e) => { if (e.isTrusted) note('wheels') }, { capture: true, passive: true })
    document.addEventListener('mousedown', (e) => { if (e.isTrusted) note('downs') }, true)
    document.getElementById('toggle')!.addEventListener('click', (e) => { if (e.isTrusted) note('clicks') })
  })
  await press(tab, tab.locator('#toggle'))
  await expect.poll(() => seen.clicks, { timeout: 5_000 }).toBe(1)
  expect(seen.downs).toBe(1)
  expect(seen.wheels).toBeGreaterThan(0)
})

// A mail summary: the row cannot be selected, the summary can; its agent text is an inline span
// whose words sit in a block inside it, beside a link and code. The drag runs over those words.
test('a drag selects words in a block inside an inline span, in a row that cannot be selected', async ({ page: tab }) => {
  await serve(tab, `<div role="button" tabindex="0" id="row" style="margin:40px;width:520px;padding:6px 8px;user-select:none;-webkit-user-select:none;display:flex;flex-direction:column">
    <span style="height:24px">Fixture group</span>
    <span id="summary" style="display:block;overflow:hidden;white-space:nowrap;padding-left:17px;font:12px/16px sans-serif;user-select:text;-webkit-user-select:text">
      <span id="words" data-agent-text><div>Design review of <a href="${SITE}/pic" target="_blank">pic.png</a> and the <code>build</code> step notes</div></span>
    </span></div>`)
  const down: boolean[] = []
  await tab.exposeFunction('noteDown', (inWords: boolean) => { down.push(inWords) })
  await tab.evaluate(() => document.addEventListener('mousedown', (e) => (window as unknown as { noteDown(w: boolean): void })
    .noteDown(Boolean(e.isTrusted && document.getElementById('words')!.contains(e.target as Node))), true))
  const selected = await dragAcrossWords(tab, tab.locator('#words'), 40)
  expect(selected.trim().length).toBeGreaterThan(0)
  expect('Design review of pic.png and the build step notes').toContain(selected.trim())
  expect(down).toEqual([true])
})

test('an ambiguous target is reported as ambiguous and presses nothing', async ({ page: tab }) => {
  await serve(tab, '<button>Open</button><button>Open</button>')
  let downs = 0
  await tab.exposeFunction('noteDown', () => { downs++ })
  await tab.evaluate(() => document.addEventListener('mousedown', () => (window as unknown as { noteDown(): void }).noteDown(), true))
  await expect(press(tab, tab.getByRole('button', { name: 'Open', exact: true }))).rejects.toThrow(/strict mode violation/)
  expect(downs).toBe(0)
})

// Words a person cannot select are no drag: the helper says so, and presses nothing.
test('a drag over words that cannot be selected refuses with the reason and presses nothing', async ({ page: tab }) => {
  await serve(tab, `<div id="row" style="margin:40px;user-select:none;-webkit-user-select:none"><span id="words">Words nobody can select</span></div>`)
  let downs = 0
  await tab.exposeFunction('noteDown', () => { downs++ })
  await tab.evaluate(() => document.addEventListener('mousedown', () => (window as unknown as { noteDown(): void }).noteDown(), true))
  await expect(dragAcrossWords(tab, tab.locator('#words'), 40, 2)).rejects.toThrow(/no selectable words: 1 text runs are user-select none/)
  expect(downs).toBe(0)
})
