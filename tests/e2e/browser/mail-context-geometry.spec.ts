import { expect, test, type Page } from '@playwright/test'
import {
  HARBOUR,
  MailFixtureServer,
  PANE,
  folderRow,
  openMail,
  pickTheme,
  smartRow,
  tailToggle,
  twist,
} from './mail-review-helpers'
import {
  ITEM,
  MENU,
  ROW,
  closeMenu,
  contrastOf,
  describePoint,
  expectInsideViewport,
  lowestRowPointAt,
  menuCount,
  menuGeometry,
  rightClickPoint,
  shoot,
  shotsDir,
  sweepPoints,
  writeEvidence,
} from './mail-context-audit-helpers'

/**
 * The half of the mail right-click slice that is neither an item list nor a request: where the menu
 * LANDS, what it looks like in both themes, what the keyboard does with it, and which surfaces have to
 * keep the browser's own menu. Every check here is a shape the item logic cannot be wrong about and a
 * unit test cannot see.
 *
 * Three fixture servers, because the questions need different mailboxes:
 *   · DENSE (two accounts, 200+ rows, a 90-character folder id) for geometry, density and the sweep.
 *     Only a list that fills the viewport can be right-clicked 8px from its bottom right corner.
 *   · CTX (one account that can mark read and send, one that can do neither) for the disabled rows the
 *     keyboard has to skip, and for the empty / loading / error paragraphs.
 *   · CTX + every write refused, for the replica sentences and for the failure a narrow window has to
 *     show inside the message pane when the sidebar is not on screen.
 */

test.setTimeout(600_000)
// Not serial: the local worker budget is ONE anyway, every test navigates its own page, and a serial
// describe SKIPS the rest after the first failure, which hides the verdict of every other check behind
// whichever one happens to be first.
test.describe.configure({ mode: 'default' })

/** Into the dense merged inbox: the one list with enough rows to reach any corner of the viewport. */
async function openDenseList(page: Page, port: number): Promise<void> {
  await openMail(page, port)
  await smartRow(page, 'inbox').click()
  await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
}

/** Right-click one row and prove the gesture produced exactly one Walnut menu. */
async function openRowMenu(page: Page, row = 0): Promise<void> {
  await closeMenu(page)
  const target = page.locator(ROW).nth(row)
  await target.click({ button: 'right', position: { x: 40, y: 12 } })
  await expect(page.locator(MENU)).toHaveCount(1)
}

test.describe('dense: geometry, density, the sweep', () => {
  const server = new MailFixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await shotsDir()
    const fixture = await server.start({ PW_MAIL_DENSE: '1' })
    port = fixture.port
  })
  test.afterAll(async () => { await server.stop() })

  test('C4 a right-click 8px from the bottom right corner lands the whole menu on screen', async ({ page }) => {
    // The list is picked while the window is wide, THEN narrowed: under 1000px the sidebar becomes a
    // drawer and the smart row it is picked from is not on screen at all. Narrow is what puts rows in
    // the corner, because the list then spans the window. The point is proven to be a row before the
    // click: a menu that never opened would pass vacuously.
    await openDenseList(page, port)
    await page.setViewportSize({ width: 820, height: 620 })
    const size = page.viewportSize()!
    const corner = await lowestRowPointAt(page, size.width - 8)
    // 8px from the right edge, and as low as a ROW ever gets: the pane's own `Load older` footer owns
    // the last few pixels above the bottom edge, so the probe reports how far above it landed rather
    // than quietly clicking that button.
    expect(corner.above, `the lowest row sits ${corner.above}px above the bottom edge`).toBeLessThan(80)
    const what = await describePoint(page, corner.x, corner.y)
    expect(what, `expected a message row, found ${what}`).toContain('mail-row')
    await rightClickPoint(page, corner.x, corner.y)
    await expect(page.locator(MENU)).toHaveCount(1)
    const geometry = await menuGeometry(page)
    expectInsideViewport(geometry)
    await shoot(page, 'c4-corner-chromium')
    await writeEvidence('c4-corner-chromium.txt', [
      'C4 right-click at the bottom right corner (chromium, 820x620)',
      `point: ${corner.x},${corner.y}, ${corner.above}px above the bottom edge`,
      `the corner itself holds: ${corner.atCorner}`,
      `over: ${what}`,
      `menu: ${JSON.stringify(geometry)}`,
    ])
    await closeMenu(page)
  })

  test('C5 a menu taller than the window caps its height and keeps its last item reachable', async ({ page }) => {
    // 240px of window against a menu of a dozen rows. `useMenuPlacement` measures the natural height
    // and hands back a maxHeight; the shared CSS turns that into a scroller. Without the pair the
    // overflowing items are not merely scrolled away, they are unreachable with no scrollbar.
    await openDenseList(page, port)
    await page.setViewportSize({ width: 1100, height: 240 })
    await openRowMenu(page, 1)
    const geometry = await menuGeometry(page)
    expectInsideViewport(geometry)
    expect(geometry.maxHeight).toMatch(/px$/)
    expect(Number.parseFloat(geometry.maxHeight)).toBeLessThanOrEqual(geometry.viewport.height)
    expect(['auto', 'scroll']).toContain(geometry.overflowY)
    const scroll = await page.locator(MENU).evaluate((box) => {
      box.scrollTop = box.scrollHeight
      return { scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, scrollTop: box.scrollTop }
    })
    expect(scroll.scrollHeight, JSON.stringify(scroll)).toBeGreaterThan(scroll.clientHeight)
    const last = page.locator(ITEM).last()
    await expect(last).toBeVisible()
    const box = await last.boundingBox()
    expect(box!.y + box!.height, JSON.stringify(box)).toBeLessThanOrEqual(geometry.viewport.height)
    await shoot(page, 'c5-capped-height')
    await closeMenu(page)
  })

  test('C3 the menu holds no field and does not grow after it opens', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openDenseList(page, port)
    await openRowMenu(page, 2)
    const first = await menuGeometry(page)
    expect(first.fields, 'a select or an input inside a menu is the banned shape').toBe(0)
    // A second later: nothing in this menu waits on a request, so a height that moved would mean an
    // item list that arrives late, which is the growing-flyout shape the menu rules forbid.
    await page.waitForTimeout(1_000)
    const second = await menuGeometry(page)
    expect({ height: second.height, fields: second.fields }).toEqual({ height: first.height, fields: 0 })
    await closeMenu(page)
  })

  test('C43 at 820px the menu is capped by the shared rule and the page gains no sideways scroll', async ({ page }) => {
    await openDenseList(page, port)
    await page.setViewportSize({ width: 820, height: 700 })
    // The density this describe claims, asserted once and measured rather than assumed: the merged list
    // pages at 50, so `Load older` is pressed until the fixture runs out. The fixture's whole mailbox is
    // 160-odd messages, which is the real ceiling here, and a long DOM is what the menu has to sit in.
    for (let page_index = 0; page_index < 6; page_index += 1) {
      const older = page.getByTestId('mail-load-older')
      if (!(await older.count())) break
      await older.click()
      await page.waitForTimeout(700)
    }
    const rows = await page.locator(ROW).count()
    expect(rows, `only ${rows} rows loaded`).toBeGreaterThanOrEqual(120)
    await openRowMenu(page, 3)
    const geometry = await menuGeometry(page)
    expectInsideViewport(geometry)
    // The cap is `min(340px, 100vw - 16px)` on the SHARED rule, so the number is computed from the
    // window rather than typed here: a mail-private width rule would answer something else.
    const expected = Math.min(340, geometry.viewport.width - 16)
    expect(geometry.maxWidth).toBe(`${expected}px`)
    expect(geometry.width).toBeLessThanOrEqual(expected)
    const page_overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(page_overflow.scrollWidth, JSON.stringify(page_overflow)).toBeLessThanOrEqual(page_overflow.clientWidth)
    await shoot(page, 'c43-820px')
    await closeMenu(page)
  })

  test('C47 scrolling the list closes the menu, and twenty right-clicks produce twenty menus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openDenseList(page, port)
    await openRowMenu(page, 4)
    // The anchor is a frozen viewport point, so a scrolled list no longer has the row under it. The
    // dismisser arms one frame late on purpose (a mount can settle the container's own scrollTop), so
    // this waits a frame before scrolling rather than racing that.
    await page.waitForTimeout(100)
    await page.locator('.mail-rows').evaluate((box) => { box.scrollTop += 300 })
    await expect(page.locator(MENU)).toHaveCount(0)

    // Twenty in a row, because a menu that dismisses itself on its own opening shows up as an
    // intermittent no-menu rather than a failure, and one right-click cannot tell the difference.
    for (let index = 0; index < 20; index += 1) {
      const row = page.locator(ROW).nth(index)
      await row.scrollIntoViewIfNeeded()
      await row.click({ button: 'right', position: { x: 40, y: 12 } })
      await expect(page.locator(MENU), `right-click ${index + 1} of 20`).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(page.locator(MENU)).toHaveCount(0)
    }
  })

  test('C66 every kind of row answers a right-click at its start, its centre and its end', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openDenseList(page, port)
    await twist(page, 'inbox').click()
    await expect(page.locator(`${PANE} .mail-mailbox.child`).first()).toBeVisible()
    // The LINE, not the row button: a folder row's badge and a smart row's chevron are siblings of the
    // button, so a gesture bound to the button alone hands those ~20px back to the browser, and "most
    // of this line has a menu" is the complaint this slice exists to answer.
    const lines = [
      { name: 'message row', line: page.locator(ROW).first() },
      { name: 'folder row', line: folderRow(page, HARBOUR, 'INBOX').locator('xpath=ancestor::li[1]') },
      {
        name: 'Drafts row',
        line: page.locator(`${PANE} .mail-mailbox[data-mailbox-id="__walnut_drafts__"]`).first()
          .locator('xpath=ancestor::li[1]'),
      },
      {
        name: 'smart row',
        line: smartRow(page, 'inbox').locator('xpath=ancestor::*[contains(@class,"mail-mailbox-line")][1]'),
      },
      { name: 'smart account child', line: page.locator(`${PANE} .mail-mailbox.child`).first().locator('xpath=ancestor::li[1]') },
    ]
    const seen: string[] = []
    for (const { name, line } of lines) {
      await expect(line, `${name} is not on screen`).toBeVisible()
      for (const point of await sweepPoints(line)) {
        await rightClickPoint(page, point.x, point.y, false)
        const count = await menuCount(page)
        expect(count, `${name} at ${point.label} produced ${count} menus`).toBe(1)
        seen.push(`${name} ${point.label}: 1 menu`)
        await closeMenu(page)
      }
    }
    await writeEvidence('c66-sweep-chromium.txt', ['C66 the whole-line sweep (chromium)', ...seen])
  })

  test('C42 the menu reads in both themes, and the hover is visible in each', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openDenseList(page, port)
    const measured: string[] = []
    for (const theme of ['Light', 'Dark'] as const) {
      await pickTheme(page, theme)
      await smartRow(page, 'inbox').click()
      await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
      await openRowMenu(page, 1)
      const resting = await contrastOf(page, `${ITEM}:not(.focused) .wn-context-menu-label`)
      await page.locator(ITEM).nth(1).hover()
      await expect(page.locator(`${ITEM}.focused`)).toHaveCount(1)
      // The hover background transitions over 100ms, and a reading taken inside that window catches an
      // interpolated alpha (measured 0.016 against the token's 0.08) and calls the hover invisible.
      await page.waitForTimeout(300)
      const hovered = await contrastOf(page, `${ITEM}.focused .wn-context-menu-label`)
      const backgrounds = await page.evaluate((selectors) => {
        const [menuSelector, itemSelector] = selectors
        const box = document.querySelector(menuSelector) as HTMLElement
        const item = document.querySelector(itemSelector) as HTMLElement
        return { menu: getComputedStyle(box).backgroundColor, item: getComputedStyle(item).backgroundColor }
      }, [MENU, `${ITEM}.focused`])
      // The numbers go in the note rather than in a tight assertion: the tokens are the shared menu's
      // and this check exists to prove the mail menu did not override them into something unreadable.
      measured.push(`${theme}: resting ${resting}:1, hovered ${hovered}:1, menu ${backgrounds.menu}, hovered row ${backgrounds.item}`)
      expect(resting, `${theme} resting label contrast`).toBeGreaterThanOrEqual(3)
      expect(hovered, `${theme} hovered label contrast`).toBeGreaterThanOrEqual(3)
      expect(backgrounds.item, 'the hovered row must not look like the menu behind it').not.toBe(backgrounds.menu)
      // And it must be a real tint rather than a trace of one: the shared token is 8% in light, 12% in dark.
      const alpha = Number((backgrounds.item.match(/[\d.]+\)$/) ?? ['1)'])[0]!.replace(')', ''))
      expect(alpha, `hover background ${backgrounds.item}`).toBeGreaterThanOrEqual(0.05)
      await shoot(page.locator(MENU), `c42-${theme.toLowerCase()}-menu`)
      await shoot(page, `c42-${theme.toLowerCase()}-console`)
      await closeMenu(page)
    }
    await writeEvidence('c42-themes-chromium.txt', ['C42 menu in both themes (chromium)', ...measured])
  })

  test('C28 the search box and the folder filter keep the browser menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openDenseList(page, port)
    // Paste, Undo, spelling and dictation are things only the browser can offer, and rule 6 keeps that
    // decision in `keepNativeContextMenu` rather than in a mail-side exception.
    const search = page.getByTestId('mail-search-input')
    await expect(search).toBeVisible()
    await search.click({ button: 'right' })
    await expect(page.locator(MENU)).toHaveCount(0)

    await tailToggle(page, HARBOUR).click()
    const filter = page.locator('.mail-tail-filter').first()
    await expect(filter).toBeVisible()
    await filter.click({ button: 'right' })
    await expect(page.locator(MENU)).toHaveCount(0)
    // And typing into it still works, which is the point of leaving the native menu there.
    await filter.fill('berth')
    await expect(filter).toHaveValue('berth')
  })
})

/** The two accounts `PW_MAIL_CTX` adopts: one can mark read and send, the other can do neither. */
const CTX_WRITER = 'fixture:ctx-writer@example.invalid'
const CTX_READER = 'inbound:ctx-reader@example.invalid'
/** The canned row whose sender and subject together run past 80 characters. */
const LONG_ROW = 'INBOX:1:118'

test.describe('ctx: paragraphs, the keyboard, and a long title', () => {
  const server = new MailFixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await shotsDir()
    // `MAIL_FIXTURE_DENSE` is the canned provider's own flag for its forty-row inbox, which is where the
    // 142-character subject lives: without it the account holds four rows and none of them is long.
    const fixture = await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '', MAIL_FIXTURE_DENSE: '1' })
    port = fixture.port
    // A fixture precondition, asserted against the API rather than discovered as a 90 second wait for a
    // pane that will never mount. `PW_MAIL_CTX` is supposed to adopt two accounts with no dialog; when
    // its provider plugin fails to register (measured: `Mail provider "fixture" requires setup
    // { fields: [], submit() }`), the console shows onboarding instead of rows and every test below
    // times out on the sidebar. This says which half is broken in one line.
    const adopted = await fetch(`http://127.0.0.1:${port}/api/plugins/mail/accounts`)
      .then((one) => one.json() as Promise<{ accounts?: unknown[] }>)
      .catch(() => ({ accounts: [] as unknown[] }))
    expect(
      adopted.accounts?.length ?? 0,
      'PW_MAIL_CTX adopted no accounts: the fixture provider plugin did not register, so there are no rows to right-click',
    ).toBeGreaterThan(0)
  })
  test.afterAll(async () => { await server.stop() })

  async function openWriterInbox(page: Page): Promise<void> {
    await openMail(page, port)
    await folderRow(page, CTX_WRITER, 'INBOX').click()
    await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
  }

  test('C46 the empty sentence, the loading line and the unfetched paragraph keep the browser menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openWriterInbox(page)
    const found: string[] = []

    // A folder with nothing cached: whichever paragraph the pane settles on (the empty sentence, or the
    // unfetched one with its own Fetch button) is prose about a folder, not a row, so it is not a target.
    // The folder with nothing cached sits in the collapsed TAIL at this fixture's folder count, so the
    // tail is opened first. Bounded on purpose: Playwright's action timeout is 0, so a click on a row
    // that is not there waits out the whole test budget instead of saying which row was missing.
    const tail = tailToggle(page, CTX_WRITER)
    if (await tail.count()) await tail.click()
    const folder = folderRow(page, CTX_WRITER, 'ctx-fetch-unknown')
    await expect(folder, 'the uncached folder is not in the sidebar').toBeVisible({ timeout: 20_000 })
    await folder.click()
    const settled = page.locator('.mail-pane-empty').first()
    await expect(settled).toBeVisible({ timeout: 60_000 })
    // A folder with nothing cached shows `Loading…` FIRST, and measuring that frame checks the loading
    // line twice while never reaching the sentence this half is about.
    await expect
      .poll(async () => (await settled.textContent())?.trim() ?? '', {
        timeout: 30_000,
        message: 'the pane never settled past Loading',
      })
      .not.toMatch(/Loading/)
    const text = (await settled.textContent())?.trim() ?? ''
    await settled.click({ button: 'right' })
    expect(await menuCount(page), `right-click on "${text}" opened a menu`).toBe(0)
    found.push(`settled paragraph: ${text}`)

    // The Loading line, held still by delaying exactly ONE page read. `times: 1` matters: a standing
    // delay on every read leaves the whole list re-rendering behind every later click in this test.
    await page.route('**/api/plugins/mail/messages?**', async (route) => {
      await new Promise((wake) => { setTimeout(wake, 2_500) })
      await route.continue().catch(() => undefined)
    }, { times: 1 })
    await folderRow(page, CTX_WRITER, 'Archive').click()
    const loading = page.locator('.mail-pane-empty').filter({ hasText: 'Loading' }).first()
    if (await loading.count()) {
      await loading.click({ button: 'right' })
      expect(await menuCount(page), 'the Loading line is not an object').toBe(0)
      found.push('Loading line: no menu')
    } else found.push('Loading line: not caught in this run')
    await writeEvidence('c46-paragraphs.txt', ['C46 paragraphs keep the browser menu', ...found])
  })

  test('C48 the keyboard walks the items only, and Tab never leaves a live backdrop behind', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openMail(page, port)
    // The reader account can neither mark read nor send, so its menu carries the info line, dividers
    // and DISABLED send items: everything the arrow keys have to step over in one menu.
    await folderRow(page, CTX_READER, 'INBOX').click()
    await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
    const posts: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/api/plugins/mail')) posts.push(`${request.method()} ${request.url()}`)
    })
    await openRowMenu(page, 0)

    // EVERY item, disabled ones included (R2-11): the walk used to skip them, so the reason they are
    // greyed out was reachable with a mouse and with nothing else. What they must not do is RUN, which
    // the `posts` assertion below is the proof of.
    const focusable = await page.locator(ITEM).allInnerTexts()
    expect(focusable.length, 'this menu has nothing to walk').toBeGreaterThan(1)
    const info = (await page.locator('.wn-context-menu-info').innerText()).trim()

    const walk: string[] = []
    for (let step = 0; step < focusable.length + 2; step += 1) {
      await page.keyboard.press('ArrowDown')
      const row = page.locator(`${ITEM}.focused`)
      await expect(row).toHaveCount(1)
      const label = (await row.innerText()).trim()
      expect(label, 'the arrow keys stopped on the info line').not.toBe(info)
      // A disabled row may hold the highlight, and pressing Enter on it must do nothing at all.
      if (await row.isDisabled()) await page.keyboard.press('Enter')
      await expect(page.locator(MENU), 'Enter on a disabled item closed the menu').toHaveCount(1)
      walk.push(label)
    }
    // It cycles rather than sticking at the end, and it never repeats out of order.
    expect(walk.slice(0, focusable.length)).toEqual(focusable.map((one) => one.trim()))

    await page.keyboard.press('Home')
    expect((await page.locator(`${ITEM}.focused`).innerText()).trim()).toBe(focusable[0]!.trim())
    await page.keyboard.press('End')
    expect((await page.locator(`${ITEM}.focused`).innerText()).trim()).toBe(focusable[focusable.length - 1]!.trim())
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(`${ITEM}.focused`)).toHaveCount(1)

    // Escape closes and runs nothing: no write left the page.
    await page.keyboard.press('Escape')
    await expect(page.locator(MENU)).toHaveCount(0)
    expect(posts, 'a right-click and a walk of the menu wrote something').toEqual([])

    // Tab (G18): either the menu goes, or it stays AND is still steerable. What is not allowed is a
    // menu that stays with its `inset: 0` backdrop while the arrow keys no longer reach it.
    await openRowMenu(page, 1)
    await page.keyboard.press('Tab')
    const stillOpen = await menuCount(page)
    if (stillOpen) {
      await page.keyboard.press('ArrowDown')
      await expect(page.locator(`${ITEM}.focused`), 'the menu stayed but the arrow keys died').toHaveCount(1)
      await closeMenu(page)
    } else {
      await expect(page.locator('.wn-context-backdrop')).toHaveCount(0)
    }
    await writeEvidence('c48-keyboard.txt', [
      'C48 keyboard walk (chromium)',
      `info line: ${info}`,
      `focusable: ${JSON.stringify(focusable.map((one) => one.trim()))}`,
      `after Tab: ${stillOpen ? 'menu stayed and still steers' : 'menu closed and the backdrop went with it'}`,
    ])
  })

  test('C45 and C76 a title past 80 characters is one truncated line that keeps its full text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openWriterInbox(page)
    const row = page.locator(`${ROW}[data-message-id="${LONG_ROW}"]`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right', position: { x: 40, y: 12 } })
    await expect(page.locator(MENU)).toHaveCount(1)

    const title = await page.evaluate(() => {
      const info = document.querySelector('.wn-context-menu-info') as HTMLElement
      const label = info.querySelector('.wn-context-menu-label') as HTMLElement
      const style = getComputedStyle(label)
      return {
        full: info.getAttribute('title') ?? '',
        shown: label.textContent ?? '',
        lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2,
        height: label.getBoundingClientRect().height,
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
        overflow: style.textOverflow,
      }
    })
    // The whole target goes in `title` (this is the only place the row is named once the backdrop has
    // stopped hover), while the line itself stays ONE line and is cut.
    expect(title.full.length, JSON.stringify(title)).toBeGreaterThanOrEqual(80)
    expect(title.height, JSON.stringify(title)).toBeLessThanOrEqual(Math.ceil(title.lineHeight * 1.5))
    // Cut in the TEXT and made to FIT (N6): the heading used to be cut by the box instead, and a line
    // clipped from the right loses its last field, which on a merged list is the account. The CSS
    // ellipsis stays as the backstop for a glyph set wider than the budget assumed.
    // R2-08 reversed which layer cuts it. The JS cap used to ellipse the text at 44 characters while the
    // box had clipped nothing (measured: 254px of label inside a 254px box, 60px of the menu unused), so
    // about ten characters of subject were dropped for free. The BOX cuts now: one line, `ellipsis`, and
    // the whole target in `title`, which is the only place the row is named once hover is frozen.
    expect(title.shown.length, JSON.stringify(title)).toBeGreaterThan(44)
    expect(title.scrollWidth, 'the box is what clips it now').toBeGreaterThan(title.clientWidth + 1)
    expect(title.overflow).toBe('ellipsis')

    const geometry = await menuGeometry(page)
    // 340px is the primitive's own ceiling. 280 was the number an earlier draft promised, and matching
    // it would have meant a mail-private width rule, which is the thing rule 1 forbids.
    expect(geometry.maxWidth).toBe(`${Math.min(340, geometry.viewport.width - 16)}px`)
    expect(geometry.width).toBeLessThanOrEqual(340)
    expectInsideViewport(geometry)
    await shoot(page.locator(MENU), 'c45-long-title')
    await writeEvidence('c45-long-title.txt', [
      'C45 and C76 long title (chromium)',
      `title characters: ${title.full.length}`,
      `label height ${Math.round(title.height)} against line-height ${Math.round(title.lineHeight)}`,
      `menu ${JSON.stringify(geometry)}`,
    ])
    await closeMenu(page)
  })
})

test.describe('replica: every write refused', () => {
  const server = new MailFixtureServer()
  let port = 0
  /**
   * The replica family, not one sentence. Each path is allowed its own words (C72 asks for exactly
   * that), and the measured wordings differ by path: the read flip says the copy only reads mail, the
   * task path says mail runs on the primary box. What every one of them must do is say the COPY is the
   * reason and never blame Walnut, so the family is matched and the exact sentence is recorded.
   */
  const REPLICA = /only reads mail|runs on your primary/i

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await shotsDir()
    // The DENSE mailbox with every write refused. The refusal is what this describe is about, and dense
    // is the fixture whose accounts are adopted with no dialog, so the rows are there to right-click.
    const fixture = await server.start({ PW_MAIL_DENSE: '1', PW_MAIL_WRITES_503: '1' })
    port = fixture.port
  })
  test.afterAll(async () => { await server.stop() })

  // The sidebar's fetch answer has its OWN testid (`mail-folder-fetch-note`) and only shares the
  // `mail-refresh-note` CLASS, so a list without it collected every path's sentence except the one the
  // folder menu writes, and the fetch item read as an item that answers nothing.
  const NOTES = '[data-testid="mail-row-note"], [data-testid="mail-refresh-note"],'
    + ' [data-testid="mail-folder-fetch-note"], .mail-list-note, .mail-folder-note'
  const COMPOSER = '.mail-compose-status, .mail-compose-notice'

  /** Every sentence the app is showing right now, tagged by who owns it. */
  async function sentences(page: Page): Promise<string[]> {
    const tidy = (list: string[], tag: string) => list
      .map((one) => `${tag}: ${one.replace(/\s+/g, ' ').trim()}`)
      .filter((one) => one.length > tag.length + 2)
    // Deduped: `.mail-list-note` and the `mail-row-note` span inside it both match, so one sentence
    // would otherwise be recorded twice and read as two answers.
    return Array.from(new Set([
      ...tidy(await page.locator(NOTES).allInnerTexts(), 'note'),
      ...tidy(await page.locator(COMPOSER).allInnerTexts(), 'composer'),
    ]))
  }

  test('C72 each refused path says the replica sentence, and none of them blames Walnut', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openMail(page, port)
    await folderRow(page, HARBOUR, 'INBOX').click()
    await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })

    const said: string[] = []
    // Written in a finally: the run that FAILS is the one whose per-path sentences are worth reading.
    const items: { name: RegExp, on: 'row' | 'folder' }[] = [
      { name: /^Mark as (read|unread)$/, on: 'row' },
      { name: /^Make a task$/, on: 'row' },
      { name: /^Reply$/, on: 'row' },
      { name: /^Reply all$/, on: 'row' },
      { name: /^Forward$/, on: 'row' },
      { name: /^Fetch this folder now$/, on: 'folder' },
    ]
    try {
      for (const { name, on } of items) {
        await closeMenu(page)
        if (on === 'row') await openRowMenu(page, 0)
        else {
          await folderRow(page, HARBOUR, 'Archive').click({ button: 'right' })
          await expect(page.locator(MENU)).toHaveCount(1)
        }
        const item = page.getByRole('menuitem').filter({ hasText: name }).first()
        const count = await item.count()
        expect(count, `no item matching ${name} in the ${on} menu`).toBe(1)
        expect(await item.isDisabled(), `${name} is disabled, so it can say nothing`).toBe(false)
        // THIS path's own answer, not whatever is still on screen from the last one. Without the diff a
        // stale composer error from the previous item passed this test for an item that said nothing at
        // all (measured: folder fetch went green on the Forward item's sentence).
        const before = await sentences(page)
        await item.click()
        await expect
          .poll(async () => (await sentences(page)).filter((one) => !before.includes(one)).join(' | '), {
            timeout: 20_000,
            message: `${name.source} produced no fresh sentence of its own`,
          })
          .toMatch(REPLICA)
        const fresh = (await sentences(page)).filter((one) => !before.includes(one))
        // `Walnut could not` is banned in the sentences the SLICE writes: `replica` is a real answer, not a
        // failure, and blaming Walnut sends the user off to restart the app when the thing to do is go to
        // the primary box. The composer's own draft-save copy is recorded rather than graded, because
        // section 8.5 leaves it alone and it is not written by a menu item.
        expect(
          fresh.filter((one) => one.startsWith('note:')).join(' | '),
          `${name.source} blamed Walnut in a note this slice writes`,
        ).not.toContain('Walnut could not')
        said.push(`${name.source}: ${JSON.stringify(fresh)}`)
        // Close a composer if one opened, so the next item starts from a clean screen.
        const close = page.getByTestId('mail-composer-close')
        if (await close.count()) await close.click()
        await page.keyboard.press('Escape')
      }
    } finally {
      await shoot(page, 'c72-replica')
      await writeEvidence('c72-replica.txt', ['C72 replica answers (chromium)', ...said])
    }
  })

  test('C44 in a narrow window with the sidebar away, the failure is inside the message pane', async ({ page }) => {
    await openMail(page, port)
    await folderRow(page, HARBOUR, 'INBOX').click()
    await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
    await page.setViewportSize({ width: 820, height: 700 })
    // Narrow is a two-drawer layout: with the list on screen the folder pane is not, so a sentence
    // written only into the sidebar's own note would be invisible exactly when the user acts.
    // Waited for rather than sampled: the layout at this width is a render, so the frame right after a
    // resize can still hold the pane and the check would prove nothing (or everything, by accident).
    await expect(page.locator(PANE), 'the sidebar never went away, so this proves nothing').toBeHidden({ timeout: 15_000 })
    await openRowMenu(page, 0)
    await page.getByRole('menuitem').filter({ hasText: /^Mark as (read|unread)$/ }).first().click()
    const note = page.getByTestId('mail-row-note')
    await expect(note).toBeVisible({ timeout: 20_000 })
    await expect(note).toContainText(REPLICA)
    const inside = await page.evaluate(() => {
      const one = document.querySelector('[data-testid="mail-row-note"]') as HTMLElement
      const pane = one.closest('.mail-list-pane')
      const box = one.getBoundingClientRect()
      return { insidePane: Boolean(pane), onScreen: box.top >= 0 && box.bottom <= window.innerHeight && box.width > 0 }
    })
    expect(inside).toEqual({ insidePane: true, onScreen: true })
    await shoot(page, 'c44-narrow-note')
  })
})
