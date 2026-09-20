/**
 * Independent verification of the mail right-click slice, written by the verifier rather than by the
 * package that implemented it, and registered from TWO spec files so the same measurements run in
 * Chromium and in WebKit (a `test.use` browser pin only holds in the file it is written in).
 *
 * Nothing here imports the slice's own specs or helpers beyond the fixture boot: the point is a second
 * measurement of the same claims, not a re-run of the first one.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail } from './mail-review-helpers'

const SHOTS = '/tmp/mail-context-verify'
const WRITER = 'fixture:ctx-writer@example.invalid'
const READER = 'inbound:ctx-reader@example.invalid'
const KEEPER = 'INBOX:1:31'   // unread at first sight
const LUNCH = 'INBOX:1:30'    // unread at first sight
const LEASE = 'INBOX:1:29'    // read at first sight
const MENU = '.wn-context-menu'

/**
 * ONE fixture server per ENGINE, and the engine is pinned by a `test.use` inside this describe.
 *
 * Measured the hard way: a `test.use` at the top of a spec file does NOT reach tests a helper module
 * registers, because Playwright attributes a test to the file whose stack called `test()`. The first
 * attempt at this file ran both halves in Chromium and said so (`engine is really webkit` received
 * `chromium`), which is exactly the vacuous WebKit pass this slice has to avoid.
 */
let port = 0
/** Which engine this run is: the PROJECT decides (`--project=webkit`), never a pin inside a describe. */
let tag = 'engine'

export function registerIndependentAll(engine: 'chromium' | 'webkit'): void {
  test.describe(`independent verification`, () => {
    test.use({ viewport: { width: 1280, height: 800 } })
    test.describe.configure({ mode: 'default' })
    const server = new MailFixtureServer()

    test.beforeAll(async ({ browserName }) => {
      test.setTimeout(300_000)
      tag = browserName
      await fs.mkdir(SHOTS, { recursive: true })
      port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
    })
    test.afterAll(async () => { await server.stop() })

    registerIndependentChecks(engine)
    registerIndependentGeometry(engine)
    registerIndependentSelection(engine)
    registerIndependentWrites(engine)
  })
}

export function registerIndependentChecks(engine: 'chromium' | 'webkit'): void {
  const row = (page: Page, accountId: string, messageId: string): Locator =>
    page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)

  const labels = async (page: Page): Promise<string[]> =>
    // WebKit's innerText keeps the row's trailing newline; the LABEL is what is being graded.
    (await page.locator(`${MENU} [role="menuitem"]`).allInnerTexts()).map((one) => one.trim())

  async function engineName(page: Page): Promise<string> {
    const ua = await page.evaluate(() => navigator.userAgent)
    return /Chrome\//.test(ua) ? 'chromium' : 'webkit'
  }

  async function intoInbox(page: Page, accountId = WRITER): Promise<void> {
    await openMail(page, port)
    await expect(folderRow(page, accountId, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, accountId, 'INBOX').click()
    await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 90_000 })
  }

  /** The engine is proven from inside the browser, never from the project label. */
  test('the engine under test names itself', async ({ page, browserName }) => {
    await page.goto(`http://127.0.0.1:${port}/`)
    const seen = await engineName(page)
    console.log(`[${tag}] project=${browserName} userAgent says ${seen}: ${await page.evaluate(() => navigator.userAgent)}`)
    expect(seen).toBe(browserName === 'chromium' ? 'chromium' : 'webkit')
  })

  test('V-C6 C7 C8 C9 C10 C12: a right-click opens the menu and touches nothing else', async ({ page }) => {
    await intoInbox(page)
    await row(page, WRITER, LUNCH).click()
    await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LUNCH, { timeout: 60_000 })
    const readerBefore = await page.getByTestId('mail-reader-subject').innerText()
    const selectedBefore = await page.locator('.mail-row.selected').getAttribute('data-message-id')
    const unreadBefore = await row(page, WRITER, KEEPER).getAttribute('data-unread')
    const ariaBefore = await row(page, WRITER, KEEPER).getAttribute('aria-current')

    const traffic: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.includes('/api/plugins/mail/') && url.includes(encodeURIComponent(KEEPER))) {
        traffic.push(`${request.method()} ${url.replace(/^.*\/api/, '/api')}`)
      }
    })

    await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    expect(await page.locator(MENU).count(), 'exactly one menu, no ancestor opened a second').toBe(1)
    await expect(row(page, WRITER, KEEPER)).toHaveAttribute('data-ctx-open', 'true')
    await page.waitForTimeout(500)

    expect(await page.locator('.mail-row.selected').getAttribute('data-message-id')).toBe(selectedBefore)
    expect(await row(page, WRITER, KEEPER).getAttribute('data-unread')).toBe(unreadBefore)
    expect(await row(page, WRITER, KEEPER).getAttribute('aria-current')).toBe(ariaBefore)
    expect(await page.getByTestId('mail-reader-subject').innerText()).toBe(readerBefore)
    expect(await page.getByTestId('mail-reader').getAttribute('data-message-id')).toBe(LUNCH)
    expect(traffic, 'no GET of the body and no POST of the read flag for the right-clicked row').toEqual([])
    expect(await row(page, WRITER, KEEPER).getAttribute('class')).not.toContain('selected')

    await page.keyboard.press('Escape')
    await expect(page.locator(MENU)).toHaveCount(0)
    await expect(row(page, WRITER, KEEPER)).not.toHaveAttribute('data-ctx-open', /.*/)
    console.log(`[${tag}] V-C6..C12 selected=${selectedBefore} unread=${unreadBefore} traffic=${traffic.length}`)
  })

  test('V-C13 C14 C23 C48: the label reads the row, the title is info, arrows reach the items', async ({ page }) => {
    await intoInbox(page)
    await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    const unreadRowItems = await labels(page)
    const info = page.locator(`${MENU} .wn-context-menu-info`).first()
    const infoText = (await info.innerText()).trim()
    const infoTitle = await info.getAttribute('title')
    const infoIsItem = (await page.locator(`${MENU} [role="menuitem"]`).first().innerText()).trim()
    await page.keyboard.press('ArrowDown')
    const focused = (await page.locator(`${MENU} .wn-context-menu-item.focused`).innerText()).trim()
    await page.keyboard.press('Escape')
    await expect(page.locator(MENU)).toHaveCount(0)

    await row(page, WRITER, LEASE).click({ button: 'right', position: { x: 12, y: 10 } })
    await expect(page.locator(MENU)).toHaveCount(1)
    const readRowItems = await labels(page)
    await page.keyboard.press('Escape')

    console.log(`[${tag}] unread row items ${JSON.stringify(unreadRowItems)}`)
    console.log(`[${tag}] read row items ${JSON.stringify(readRowItems)}`)
    console.log(`[${tag}] info "${infoText}" title "${infoTitle}" firstMenuItem "${infoIsItem}" focusedAfterArrowDown "${focused}"`)
    expect(unreadRowItems[0]).toBe('Mark as read')
    expect(readRowItems[0]).toBe('Mark as unread')
    expect(unreadRowItems[0]).not.toBe(readRowItems[0])
    expect(infoText.length).toBeGreaterThan(0)
    expect(infoTitle && infoTitle.length).toBeTruthy()
    expect(focused).toBe('Mark as read')
  })
}

/** Geometry, density and the capability gates. Second registrar so each section is appended alone. */
export function registerIndependentGeometry(engine: 'chromium' | 'webkit'): void {
  test.describe('geometry and gates', () => {
    test.describe.configure({ mode: 'default' })

    const row = (page: Page, accountId: string, messageId: string): Locator =>
      page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)

    async function intoInbox(page: Page, accountId = WRITER): Promise<void> {
      await openMail(page, port)
      await expect(folderRow(page, accountId, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
      await folderRow(page, accountId, 'INBOX').click()
      await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 90_000 })
    }

    test('V-C4 C3: the menu at the bottom-right corner is wholly on screen and does not grow', async ({ page }) => {
      await intoInbox(page)
      // A row has to BE at the corner for this to measure anything. At 1280x800 this fixture's inbox is
      // three rows tall and the right half of the window is the reader, so the corner holds neither; a
      // short narrow window is the state where a row reaches the bottom-right 8px.
      await page.setViewportSize({ width: 820, height: 380 })
      await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(700)
      const point = await page.evaluate(() => {
        const x = window.innerWidth - 8
        for (let y = window.innerHeight - 8; y > window.innerHeight - 220; y -= 2) {
          const node = document.elementFromPoint(x, y) as HTMLElement | null
          if (node?.closest('[data-testid="mail-row"]')) return { x, y, above: window.innerHeight - y }
        }
        const at = document.elementFromPoint(x, window.innerHeight - 8) as HTMLElement | null
        return { x, y: -1, above: -1, corner: at ? `${at.tagName.toLowerCase()}.${at.className}` : 'nothing' }
      })
      expect(point.y, `a row within 220px of the bottom edge; the corner holds ${JSON.stringify(point)}`).toBeGreaterThan(0)
      await page.mouse.click(point.x, point.y, { button: 'right' })
      await expect(page.locator(MENU)).toHaveCount(1)
      const first = await page.locator(MENU).evaluate((node) => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          x: Math.round(box.left), y: Math.round(box.top),
          w: Math.round(box.width), h: Math.round(box.height),
          right: Math.round(box.right), bottom: Math.round(box.bottom),
          maxHeight: style.maxHeight, overflowY: style.overflowY, maxWidth: style.maxWidth,
          fields: node.querySelectorAll('select, input, textarea').length,
          offsetHeight: (node as HTMLElement).offsetHeight,
          vw: window.innerWidth, vh: window.innerHeight,
        }
      })
      await page.waitForTimeout(1000)
      const later = await page.locator(MENU).evaluate((node) => (node as HTMLElement).offsetHeight)
      await page.screenshot({ path: `${SHOTS}/${tag}-c4-corner.png` })
      console.log(`[${tag}] V-C4 point=${JSON.stringify(point)} menu=${JSON.stringify(first)} heightAfter1s=${later}`)
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(first.y).toBeGreaterThanOrEqual(0)
      expect(first.right).toBeLessThanOrEqual(first.vw)
      expect(first.bottom).toBeLessThanOrEqual(first.vh)
      expect(first.fields, 'no select or input inside a menu').toBe(0)
      expect(later, 'the menu does not grow after it opens').toBe(first.offsetHeight)
    })

    test('V-C17 C31: the account that cannot mark read shows no read item, and cannot-send is disabled', async ({ page }) => {
      await intoInbox(page, READER)
      const rows = page.locator(`.mail-row[data-account-id="${READER}"]`)
      await expect(rows.first()).toBeVisible({ timeout: 60_000 })
      await rows.first().click({ button: 'right', position: { x: 12, y: 10 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      // The LABEL span, not the whole button: a disabled item's reason is drawn as visible text (R2-11),
      // and since R3-03 it is a row UNDER the group rather than a second line inside the first button
      // (inside one row it made that row 52px tall next to its 30px siblings).
      const label = `${MENU} [role="menuitem"] .wn-context-menu-label`
      const items = (await page.locator(label).allInnerTexts()).map((one) => one.trim())
      const disabled = (await page.locator(`${MENU} [role="menuitem"][disabled] .wn-context-menu-label`)
        .allInnerTexts()).map((one) => one.trim())
      const reply = page.locator(`${MENU} [role="menuitem"]`)
        .filter({ has: page.locator('.wn-context-menu-label', { hasText: /^Reply$/ }) }).first()
      const replyTitle = await reply.getAttribute('title')
      const replyWhy = (await page.locator(`${MENU} .wn-context-menu-reason`).first().innerText()).trim()
      const writes: string[] = []
      page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api')) writes.push(`${request.method()} ${request.url()}`) })
      // A disabled button cannot be clicked the ordinary way (Playwright waits for enabled, which is
      // itself the answer), so the press is DISPATCHED: what is being graded is that nothing goes out.
      await reply.dispatchEvent('click')
      await page.waitForTimeout(600)
      console.log(`[${tag}] V-C17 items ${JSON.stringify(items)}`)
      console.log(`[${tag}] V-C31 disabled ${JSON.stringify(disabled)} replyTitle "${replyTitle}" writesAfterClick ${JSON.stringify(writes)}`)
      expect(items.filter((one) => /Mark as/.test(one)), 'no read item at all, not a disabled one').toEqual([])
      expect(disabled).toEqual(['Reply', 'Reply all', 'Forward'])
      expect(replyTitle).toBe('This account cannot send; add SMTP settings')
      // And the reason is readable without a pointer, which is what a keyboard walk can now reach.
      expect(replyWhy).toBe('This account cannot send; add SMTP settings')
      expect(writes.filter((one) => one.includes('/plugins/mail')), 'a disabled item sends nothing').toEqual([])
    })

    test('V-C30: no menu on either surface offers an action the server cannot do', async ({ page }) => {
      await intoInbox(page)
      const banned = /Delete|Move|Archive to|Flag|Star|Mark all as read|Unsubscribe/
      await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      const message = await page.locator(MENU).innerText()
      await page.keyboard.press('Escape')
      await folderRow(page, WRITER, 'INBOX').click({ button: 'right', position: { x: 12, y: 8 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      const folder = await page.locator(MENU).innerText()
      await page.keyboard.press('Escape')
      console.log(`[${tag}] V-C30 message ${JSON.stringify(message)} folder ${JSON.stringify(folder)}`)
      expect(message).not.toMatch(banned)
      expect(folder).not.toMatch(banned)
    })
  })
}

/** Rule 6 (the browser's menu stays where it is the better one) and the left pane's own rows. */
export function registerIndependentSelection(engine: 'chromium' | 'webkit'): void {
  test.describe('selection and the left pane', () => {
    test.describe.configure({ mode: 'default' })

    const row = (page: Page, accountId: string, messageId: string): Locator =>
      page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)

    async function intoInbox(page: Page): Promise<void> {
      await openMail(page, port)
      await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
      await folderRow(page, WRITER, 'INBOX').click()
      await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 90_000 })
    }

    /** A real press-move-release across an element's glyphs, the way a person selects. */
    async function dragAcross(page: Page, target: Locator): Promise<string> {
      const box = (await target.boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + 2, y)
      await page.mouse.down()
      for (let at = 6; at <= Math.min(box.width - 2, 180); at += 10) await page.mouse.move(box.x + at, y)
      await page.mouse.up()
      return page.evaluate(() => {
        const selection = window.getSelection()
        return selection && !selection.isCollapsed ? selection.toString() : ''
      })
    }

    test('V-C26 C74 C75: a real drag over a row, then a right-click inside what it selected', async ({ page }) => {
      await intoInbox(page)
      await row(page, WRITER, LUNCH).click()
      await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LUNCH, { timeout: 60_000 })
      const readerBefore = await page.getByTestId('mail-reader-subject').innerText()
      const traffic: string[] = []
      page.on('request', (request) => {
        const url = request.url()
        if (url.includes(encodeURIComponent(KEEPER)) || url.endsWith('/read')) traffic.push(`${request.method()} ${url.replace(/^.*\/api/, '/api')}`)
      })

      const subjectText = await dragAcross(page, row(page, WRITER, KEEPER).locator('.mail-row-subject-text'))
      const collapsedAfterSubject = await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      const snippetText = await dragAcross(page, row(page, WRITER, KEEPER).locator('.mail-row-snippet'))
      const collapsed = await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)
      let menusOverSelection = -1
      if (!collapsed) {
        const box = (await row(page, WRITER, KEEPER).locator('.mail-row-snippet').boundingBox())!
        await page.mouse.click(Math.round(box.x + 20), Math.round(box.y + box.height / 2), { button: 'right' })
        await page.waitForTimeout(400)
        menusOverSelection = await page.locator(MENU).count()
      }
      console.log(`[${tag}] V-C75 subject="${subjectText}" (collapsed ${collapsedAfterSubject}) snippet="${snippetText}" collapsed=${collapsed}`)
      console.log(`[${tag}] V-C26 menus over a live selection = ${menusOverSelection} (-1 means no selection could be made in this engine)`)
      console.log(`[${tag}] V-C74 traffic during the drags ${JSON.stringify(traffic)}`)
      expect(traffic, 'a drag over a row reads nothing and writes nothing').toEqual([])
      expect(await page.getByTestId('mail-reader-subject').innerText()).toBe(readerBefore)
      expect(subjectText.trim().length, `${tag}: the subject is selectable text`).toBeGreaterThan(0)
      expect(snippetText.trim().length, `${tag}: the snippet is selectable text`).toBeGreaterThan(0)
      expect(menusOverSelection, `${tag}: a live human selection keeps the browser's own menu`).toBe(0)
    })

    test('V-C27 C28: a stale selection elsewhere does not suppress the row menu, and fields keep theirs', async ({ page }) => {
      await intoInbox(page)
      // A selection in the READER pane, which is another pane entirely.
      await row(page, WRITER, LUNCH).click()
      await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', LUNCH, { timeout: 60_000 })
      const left = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="mail-reader"] .mail-reader-subject, [data-testid="mail-reader-subject"]')
        if (!node) return ''
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return selection?.toString() ?? ''
      })
      await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
      const withStale = await page.locator(MENU).count()
      await page.keyboard.press('Escape')
      await page.getByTestId('mail-search-input').click({ button: 'right' })
      await page.waitForTimeout(300)
      const onSearch = await page.locator(MENU).count()
      console.log(`[${tag}] V-C27 stale selection "${left.slice(0, 40)}" menus=${withStale}; V-C28 menus on the search box=${onSearch}`)
      expect(withStale, 'a selection in another pane is not this row\'s').toBe(1)
      expect(onSearch, 'an editable keeps the browser menu').toBe(0)
    })
  })
}

/** The optimistic flip and its rollback, the folder fetch's payload, the whole-line sweep, the themes. */
export function registerIndependentWrites(engine: 'chromium' | 'webkit'): void {
  test.describe('writes, the fetch payload and the sweep', () => {
    test.describe.configure({ mode: 'default' })

    const row = (page: Page, accountId: string, messageId: string): Locator =>
      page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)

    /**
     * Both badges in ONE round trip, read in the page.
     *
     * Two `innerText()` calls through locators is what this used to be, and the cost is why: under
     * machine load the pair measured over 1.6 SECONDS, which is longer than the optimistic window the
     * case below has to catch, so the reading arrived after the state it was taken to describe had
     * already been rolled back. A reader that is slower than the thing it reads cannot grade it.
     */
    const numbers = (page: Page): Promise<{ folder: string, smart: string }> => page.evaluate((account) => {
      const text = (selector: string): string => {
        const found = document.querySelector(selector)
        return found ? (found.textContent ?? '').trim() : ''
      }
      return {
        folder: text(`.mail-accounts-pane .mail-account[data-account-id="${account}"] .mail-mailbox[data-mailbox-id="INBOX"] [data-testid="mail-mailbox-unread"]`),
        smart: text('.mail-mailbox.smart[data-smart="inbox"] [data-testid="mail-smart-unread"]'),
      }
    }, WRITER)

    async function intoInbox(page: Page): Promise<void> {
      await openMail(page, port)
      await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
      await folderRow(page, WRITER, 'INBOX').click()
      await expect(page.locator('.mail-row').first()).toBeVisible({ timeout: 90_000 })
    }

    test('V-C15 C16: the flip lands before the answer, and a 409 puts the row and both numbers back', async ({ page }) => {
      await intoInbox(page)
      const unread = page.locator('.mail-row[data-unread="true"]').first()
      await expect(unread).toBeVisible({ timeout: 60_000 })
      const id = (await unread.getAttribute('data-message-id'))!
      const before = await numbers(page)

      const requests: string[] = []
      page.on('request', (request) => { if (request.url().endsWith('/read')) requests.push(`${Date.now()} ${request.method()} ${request.url().replace(/^.*\/messages\//, '')}`) })
      page.on('response', (response) => { if (response.url().endsWith('/read')) requests.push(`${Date.now()} <- ${response.status()}`) })
      // HELD UNTIL THIS TEST HAS SEEN THE FLIP, not for a fixed 1.5s. The sampler this replaces spent
      // two cross-process `innerText` calls per sample, and under machine load its FIRST sample landed
      // at +1617ms — after a 1552ms hold had already answered and rolled the row back. It reported the
      // optimistic flip as missing when the flip had happened and closed before it looked once. Gating
      // the answer on the observation makes "the flip lands BEFORE the answer" a fact about the order
      // rather than a race the load decides. Still bounded, for the reason the old comment gave: an
      // answer that never comes lets the client's own abort fire, and then the rollback under test
      // would be a timeout instead of the refusal.
      let release = (): void => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/read', async (route) => {
        if (route.request().method() !== 'POST') { await route.continue(); return }
        await Promise.race([held, new Promise<void>((resolve) => { setTimeout(resolve, 8_000) })])
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'cannot_mark_read', message: 'This provider cannot mark mail read.' }) })
      })

      await row(page, WRITER, id).click({ button: 'right', position: { x: 12, y: 10 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      const started = Date.now()
      await page.locator(`${MENU} [role="menuitem"]`, { hasText: /^Mark as read$/ }).first().click()
      // Observed IN THE PAGE, which is what makes this cheap enough to be reliable: the poll runs in the
      // renderer instead of paying a round trip per look.
      await expect(row(page, WRITER, id)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
      const flipAt = Date.now() - started
      // Sampled with NOTHING awaited in between, which is the whole point of this line: taken one
      // round trip later it recorded the hold's own cap firing rather than the order under test.
      const answered = requests.some((one) => one.includes('<-'))
      // Read while the answer is STILL HELD, so these two numbers are the optimistic pair by
      // construction rather than by timing.
      const during = await numbers(page)
      release()
      console.log(`[${tag}] V-C15 flip seen at +${flipAt}ms, answered before the flip=${answered}`)
      const requested = requests.slice()
      console.log(`[${tag}] V-C15 read requests ${JSON.stringify(requested)}`)
      expect(answered, 'the flip was on screen BEFORE the provider answered').toBe(false)
      await expect(row(page, WRITER, id)).toHaveAttribute('data-unread', 'true', { timeout: 30_000 })
      const after = await numbers(page)
      const note = await page.getByTestId('mail-row-note').innerText().catch(() => '')
      const failed = await row(page, WRITER, id).getAttribute('data-flag-failed')
      const failedTitle = await row(page, WRITER, id).getAttribute('title')
      await page.screenshot({ path: `${SHOTS}/${tag}-c16-rollback.png` })
      console.log(`[${tag}] V-C15/16 id=${id} before=${JSON.stringify(before)} during=${JSON.stringify(during)} after=${JSON.stringify(after)}`)
      console.log(`[${tag}] V-C16 note="${note}" data-flag-failed=${failed} title="${failedTitle}"`)
      const count = (text: string): number => Number((text || '0').replace(/[^\d]/g, '') || '0')
      expect(count(during.folder), 'the folder badge moved with the row').toBe(count(before.folder) - 1)
      expect(count(during.smart), 'and so did the account total').toBe(count(before.smart) - 1)
      expect({ folder: count(after.folder), smart: count(after.smart) }).toEqual({ folder: count(before.folder), smart: count(before.smart) })
      expect(failed, 'the row carries the refusal').toBeTruthy()
      expect(note.length, 'the pane names the row').toBeGreaterThan(0)
      await page.unroute('**/read')
    })

    test('V-C34 C35: the fetch names the right-clicked pair while another folder is selected', async ({ page }) => {
      await intoInbox(page)
      const activeBefore = await page.locator('.mail-mailbox.active').getAttribute('data-mailbox-id')
      const listBefore = await page.locator('.mail-row').count()
      const bodies: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('/mailboxes/fetch')) bodies.push(`${request.method()} ${request.postData() ?? ''}`)
      })
      const other = folderRow(page, WRITER, 'Archive')
      await expect(other).toHaveCount(1)
      await other.click({ button: 'right', position: { x: 12, y: 8 } })
      await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)
      const items = (await page.locator(`${MENU} [role="menuitem"]`).allInnerTexts()).map((one) => one.trim())
      await page.locator(`${MENU} [role="menuitem"]`, { hasText: /^Fetch this folder now$/ }).first().click()
      await page.waitForTimeout(1200)
      const activeAfter = await page.locator('.mail-mailbox.active').getAttribute('data-mailbox-id')
      console.log(`[${tag}] V-C34 active ${activeBefore} -> ${activeAfter}, rows ${listBefore} -> ${await page.locator('.mail-row').count()}`)
      console.log(`[${tag}] V-C35 folder items ${JSON.stringify(items)} fetch ${JSON.stringify(bodies)}`)
      expect(activeAfter, 'a right-click never changes the selected folder').toBe(activeBefore)
      expect(bodies.length).toBe(1)
      expect(bodies[0]).toContain('Archive')
      expect(bodies[0]).toContain(WRITER)
    })

    test('V-C66: every row kind answers on the whole line, three points each', async ({ page }) => {
      await intoInbox(page)
      const kinds: { label: string, locator: Locator }[] = [
        { label: 'message row', locator: row(page, WRITER, KEEPER) },
        { label: 'folder row', locator: folderRow(page, WRITER, 'INBOX') },
        { label: 'drafts row', locator: page.locator(`.mail-account[data-account-id="${WRITER}"] [data-testid="mail-drafts-row"]`).first() },
        { label: 'smart row', locator: page.locator('.mail-mailbox.smart[data-smart="inbox"]').first() },
      ]
      const found: string[] = []
      for (const kind of kinds) {
        await expect(kind.locator).toHaveCount(1)
        const box = (await kind.locator.boundingBox())!
        for (const [name, x] of [['start+12', box.x + 12], ['centre', box.x + box.width / 2], ['end-12', box.x + box.width - 12]] as [string, number][]) {
          await page.mouse.click(Math.round(x), Math.round(box.y + box.height / 2), { button: 'right' })
          const count = await page.locator(MENU).count()
          found.push(`${kind.label} ${name}=${count}`)
          if (count) { await page.keyboard.press('Escape'); await expect(page.locator(MENU)).toHaveCount(0) }
        }
      }
      console.log(`[${tag}] V-C66 ${JSON.stringify(found)}`)
      expect(found.filter((one) => !one.endsWith('=1'))).toEqual([])
    })

    test('V-C32: the row that already has a task offers to OPEN it, and the click navigates', async ({ page }) => {
      await intoInbox(page)
      const tasked = page.locator('.mail-row[data-task-id]').first()
      await expect(tasked, 'the fixture has one row with a task on it').toHaveCount(1)
      const id = await tasked.getAttribute('data-task-id')
      await tasked.click({ button: 'right', position: { x: 12, y: 10 } })
      await expect(page.locator(MENU)).toHaveCount(1)
      const items = (await page.locator(`${MENU} [role="menuitem"]`).allInnerTexts()).map((one) => one.trim())
      await page.locator(`${MENU} [role="menuitem"]`, { hasText: /^Open task$/ }).first().click()
      await page.waitForTimeout(1200)
      const url = page.url()
      console.log(`[${tag}] V-C32 taskId=${id} items=${JSON.stringify(items)} url=${url.replace(/^https?:\/\/[^/]+/, '')}`)
      expect(items, 'never a second task for a row that has one').not.toContain('Make a task')
      expect(url).toContain(`/tasks/${id}`)
    })

    test('V-C42 C43: both themes, and an 820px window', async ({ page }) => {
      await intoInbox(page)
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((mode) => { document.documentElement.setAttribute('data-theme', mode) }, theme)
        await row(page, WRITER, KEEPER).click({ button: 'right', position: { x: 12, y: 10 } })
        await expect(page.locator(MENU)).toHaveCount(1)
        await page.locator(`${MENU} [role="menuitem"]`).first().hover()
        await page.waitForTimeout(200)
        await page.screenshot({ path: `${SHOTS}/${tag}-c42-${theme}.png` })
        await page.keyboard.press('Escape')
      }
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light') })
      await page.setViewportSize({ width: 820, height: 800 })
      await page.waitForTimeout(600)
      const narrow = page.locator('.mail-row').first()
      await expect(narrow).toBeVisible()
      const box = (await narrow.boundingBox())!
      await page.mouse.click(Math.round(box.x + box.width - 10), Math.round(box.y + box.height / 2), { button: 'right' })
      await expect(page.locator(MENU)).toHaveCount(1)
      const shape = await page.locator(MENU).evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return {
          left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom),
          maxWidth: getComputedStyle(node).maxWidth, vw: window.innerWidth, vh: window.innerHeight,
          sideways: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      await page.screenshot({ path: `${SHOTS}/${tag}-c43-820.png` })
      console.log(`[${tag}] V-C43 ${JSON.stringify(shape)}`)
      expect(shape.left).toBeGreaterThanOrEqual(0)
      expect(shape.right).toBeLessThanOrEqual(shape.vw)
      expect(shape.sideways, 'no sideways scrollbar at 820px').toBe(false)
    })
  })
}
