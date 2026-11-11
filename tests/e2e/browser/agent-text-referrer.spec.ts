// The browser's accepted links and meta tags cannot pass the reader token outside.
// The outside site is a page.route stand-in, so nothing leaves the machine.
// Run on WebKit: PW_WEBKIT=1 bun x playwright test tests/e2e/browser/agent-text-referrer.spec.ts --project webkit
import { test, expect, type Request } from '@playwright/test'
import { AGENT_TEXT_BASE as base, click, closeFile, closeLetter, expectText, openApp, seedAgentFiles, showPointer } from './agent-text-entry-helpers'

const stamp = Date.now().toString(36)
const OUTSIDE = 'https://outside.example'
/** Longer than the linker's REF_TAG_MAX (2048), so its href is never read. */
const LONG_TITLE = 't'.repeat(4096)
const letters: string[] = []

test.setTimeout(180_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
test.beforeAll(() => {
  if (new URL(base).port === '3456') throw new Error('Referrer acceptance must use an isolated server')
})
test.beforeEach(async ({ page }) => { await showPointer(page) })
test.afterAll(async ({ request }) => {
  for (const id of letters) await request.delete(`/api/v1/human-inbox/${id}`).catch(() => {})
})

const PARSER_BOUNDARIES = [
  ['comment-end', '<!-- x --!>', '<!-- -->'],
  ['foreign-style', '<svg><style><p>', ''],
  ['foreign-plaintext', '<svg><plaintext/></svg>', ''],
  ['html-cdata', '<![CDATA[ >', ''],
  ['comment-head', '<!-- <head> -->', ''],
  ['comment-header', '<!-- <header> -->', ''],
  ['noscript', '<noscript>', '</noscript>'],
  ['foreign-meta', '<svg><meta name="referrer" content="unsafe-url"><style><p>', '</style>'],
] as const

for (const [name, prefix, suffix] of PARSER_BOUNDARIES) for (const deferred of [false, true]) test(`browser parsing keeps the letter security floor: ${name}, deferred=${deferred}`, async ({ page, request, context }) => {
  const files = await seedAgentFiles(`parser-boundary-${deferred}-${stamp}`)
  const outside: Array<{ url: string; referer: string }> = []
  await context.route(`${OUTSIDE}/**`, async (route) => {
    outside.push({ url: route.request().url(), referer: (await route.request().allHeaders())['referer'] ?? '' })
    await route.fulfill({ contentType: 'text/html', body: '<h1>Outside page</h1>' })
  })
  await openApp(page)
  {
    const before = outside.length
    const subject = `Parser boundary ${name} ${deferred} ${stamp}`
    const link = (id: string) => `<a id="${id}" href="${OUTSIDE}/${name}" target="_blank" rel="opener" referrerpolicy="unsafe-url">Boundary outside</a>`
    const file = `<p>File: ${files.document}:2-3</p>`
    const document = prefix
      + link('boundary-out')
      + `<meta name="referrer" content="unsafe-url"><meta http-equiv="refresh" content="1;url=${OUTSIDE}/refresh-${name}">`
      + `<img src="${OUTSIDE}/pixel-${name}">` + file
      + suffix + (name === 'foreign-meta' ? link('boundary-after-style') + file : '')
      + (deferred ? `<p>${'Long report. '.repeat(100_000)}</p>` : '')
    const sent = await request.post('/api/v1/human-inbox', { data: { subject, type: 'info', html: document } })
    expect(sent.ok(), await sent.text()).toBeTruthy()
    const id = (await sent.json()).id
    letters.push(id)
    const center = page.locator('.notification-panel')
    if (!(await center.isVisible())) await click(page, page.getByRole('button', { name: /^Notifications(?:$|[,:.])/ }))
    await click(page, center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }))
    await click(page, center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject'))
    const frame = page.frameLocator('.hib-reader .hib-html-frame')
    const anchor = frame.locator(name === 'foreign-meta' ? '#boundary-after-style' : '#boundary-out')
    await expect(anchor).toBeVisible()
    if (name === 'foreign-meta') {
      // Meta exits SVG; the following HTML style holds markup as text until its closing tag.
      await expect(frame.locator('#boundary-out')).toHaveCount(0)
      await expect.poll(() => frame.locator('style').evaluateAll((styles) => styles.map((s) => s.textContent ?? '').join('\n'))).toContain(files.document)
    }
    await page.waitForTimeout(1_500)
    expect(outside.slice(before), `${name}: opening a letter sends no request outside`).toEqual([])
    expect(context.pages()).toHaveLength(1)
    await expect(anchor).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(frame.locator('meta[name="referrer" i]:not([content="no-referrer" i]), meta[http-equiv="refresh" i]')).toHaveCount(0)
    const popupP = context.waitForEvent('page')
    await click(page, anchor)
    const popup = await popupP
    await popup.waitForLoadState('domcontentloaded')
    await expect.poll(() => outside.length).toBe(before + 1)
    expect(outside[before]).toEqual({ url: `${OUTSIDE}/${name}`, referer: '' })
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.close()
    await click(page, frame.locator('a[data-walnut-ref="file"]').filter({ hasText: files.document }))
    await expectText(page)
    await closeFile(page)
    await expect.poll(() => context.pages().length).toBe(1)
    await closeLetter(page)
  }
})

for (const deferred of [false, true]) test(`an HTML letter sends no Referer and opens nothing by itself, deferred=${deferred}`, async ({ page, request, context }) => {
  const files = await seedAgentFiles(`referrer-${deferred}-${stamp}`)
  const subject = `Referrer check ${deferred} ${stamp}`
  const html = '<html><head>'
    + `<base href="${OUTSIDE}/redirected/">`
    + '<meta name="referrer" content="unsafe-url">'
    + `<meta http-equiv="refresh" content="1;url=${OUTSIDE}/refresh">`
    + '</head><body data-layout="referrer">'
    + `<meta name="referrer" content="unsafe-url">`
    + `<p><a id="out" href="${OUTSIDE}/plain" target="_blank">Outside plain</a></p>`
    + `<p><a id="long" title="${LONG_TITLE}" href="${OUTSIDE}/long" target="_blank" rel="opener" referrerpolicy="unsafe-url">Outside long</a></p>`
    + `<p>File: ${files.document}:2-3</p>`
    + (deferred ? `<p>${'Long report. '.repeat(100_000)}</p>` : '')
    + '</body></html>'
  const sent = await request.post('/api/v1/human-inbox', { data: { subject, type: 'info', text: 'Referrer acceptance', html } })
  expect(sent.ok(), await sent.text()).toBeTruthy()
  letters.push((await sent.json()).id)

  // Every request to the outside site, with the headers it carried; none is sent for real.
  const outside: Array<{ url: string; referer: string }> = []
  await context.route(`${OUTSIDE}/**`, async (route) => {
    const headers = await route.request().allHeaders()
    outside.push({ url: route.request().url(), referer: headers['referer'] ?? '' })
    await route.fulfill({ contentType: 'text/html', body: '<h1>Outside page</h1>' })
  })
  // Any request but the body's own that names the reader token is a leak.
  const tokenLeaks: string[] = []
  const watch = (r: Request) => {
    const u = r.url()
    if (/ref_token=/.test(u) && !/\/human-inbox\/[^/]+\/body\?/.test(u)) tokenLeaks.push(u.replace(/ref_token=[0-9a-f]+/, 'ref_token=<set>'))
  }
  context.on('request', watch)

  await openApp(page)
  await click(page, page.getByRole('button', { name: /^Notifications(?:$|[,:.])/ }))
  const center = page.locator('.notification-panel')
  await click(page, center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }))
  await click(page, center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject'))
  const frameEl = page.locator('.hib-reader .hib-html-frame')
  const frame = page.frameLocator('.hib-reader .hib-html-frame')
  await expect(frame.locator('body')).toHaveAttribute('data-layout', 'referrer')
  // The deferred body's own address carries the token: what the meta tried to send.
  if (deferred) expect(await frameEl.getAttribute('src')).toMatch(/[?&]ref_token=[0-9a-f]{32}(&|$)/)
  else expect(await frameEl.getAttribute('src')).toBeNull()

  // Nothing pressed yet: past the refresh delay, no navigation, no viewer, no other page.
  await page.waitForTimeout(2_500)
  expect(outside).toEqual([])
  await expect(frame.locator('body')).toHaveAttribute('data-layout', 'referrer')
  await expect(frame.locator('meta[name="referrer" i]:not([content="no-referrer" i]), meta[http-equiv="refresh" i]')).toHaveCount(0)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(context.pages()).toHaveLength(1)

  // One press each: an outside page in a new tab, sent no Referer, and nothing else.
  for (const [id, path] of [['out', '/plain'], ['long', '/long']] as const) {
    const anchor = frame.locator(`a#${id}`)
    await expect(anchor).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer')
    const before = outside.length
    const popupP = context.waitForEvent('page')
    await click(page, anchor)
    const popup = await popupP
    await popup.waitForLoadState('domcontentloaded')
    expect(popup.url()).toBe(`${OUTSIDE}${path}`)
    await expect.poll(() => outside.length).toBe(before + 1)
    const hit = outside[before]!
    expect(hit.url).toBe(`${OUTSIDE}${path}`)
    expect(hit.referer, `Referer sent to ${path}`).toBe('')
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.close()
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  }
  expect(outside.map((o) => o.url)).not.toContain(`${OUTSIDE}/refresh`)

  // A hostile base cannot redirect the file reference, including its reader token, to the outside site.
  const fileLink = frame.locator('a[data-walnut-ref="file"]').filter({ hasText: files.document })
  expect(new URL(await fileLink.evaluate((el: HTMLAnchorElement) => el.href)).origin).toBe(new URL(base).origin)
  await click(page, fileLink)
  await expectText(page)
  await closeFile(page)
  await expect.poll(() => context.pages().length, { timeout: 10_000 }).toBe(1)

  context.off('request', watch)
  expect(tokenLeaks).toEqual([])
  await closeLetter(page)
})
