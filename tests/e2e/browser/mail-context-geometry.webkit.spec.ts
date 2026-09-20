import { expect, test, type Page } from '@playwright/test'
import {
  HARBOUR,
  MailFixtureServer,
  PANE,
  folderRow,
  openMail,
  pickTheme,
  smartRow,
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
 * The three checks that have to hold in the engine the Mac app actually is (WKWebView): where the menu
 * lands at a corner, whether it can be read in both themes, and whether every point on a row's line
 * answers the gesture. WebKit is the engine that differs on all three: it measures text differently, it
 * does not focus a <button> on mousedown, and a row's own text is not selectable unless asked.
 *
 * A `browserName` pin only applies at the top level of its own file, which is why this is a file rather
 * than a project loop inside the chromium spec.
 */

test.setTimeout(600_000)
test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
// Not serial: the local worker budget is ONE anyway, every test navigates its own page, and a serial
// describe SKIPS the rest after the first failure, which hides the verdict of every other check behind
// whichever one happens to be first.
test.describe.configure({ mode: 'default' })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await shotsDir()
  const fixture = await server.start({ PW_MAIL_DENSE: '1' })
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

async function openDenseList(page: Page, at: number): Promise<void> {
  await openMail(page, at)
  await smartRow(page, 'inbox').click()
  await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
}

test('C4 a right-click 8px from the bottom right corner lands the whole menu on screen', async ({ page }) => {
  // Wide while the list is picked (under 1000px the sidebar is a drawer), narrow while it is measured.
  await openDenseList(page, port)
  await page.setViewportSize({ width: 820, height: 620 })
  const size = page.viewportSize()!
  const corner = await lowestRowPointAt(page, size.width - 8)
  expect(corner.above, `the lowest row sits ${corner.above}px above the bottom edge`).toBeLessThan(80)
  const what = await describePoint(page, corner.x, corner.y)
  expect(what, `expected a message row, found ${what}`).toContain('mail-row')
  await rightClickPoint(page, corner.x, corner.y)
  await expect(page.locator(MENU)).toHaveCount(1)
  const geometry = await menuGeometry(page)
  expectInsideViewport(geometry)
  await shoot(page, 'c4-corner-webkit')
  await writeEvidence('c4-corner-webkit.txt', [
    'C4 right-click at the bottom right corner (webkit, 820x620)',
    `point: ${corner.x},${corner.y}, ${corner.above}px above the bottom edge`,
    `the corner itself holds: ${corner.atCorner}`,
    `over: ${what}`,
    `menu: ${JSON.stringify(geometry)}`,
  ])
  await closeMenu(page)
})

test('C42 the menu reads in both themes here too', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDenseList(page, port)
  const measured: string[] = []
  for (const theme of ['Light', 'Dark'] as const) {
    await pickTheme(page, theme)
    await smartRow(page, 'inbox').click()
    await expect(page.locator(ROW).first()).toBeVisible({ timeout: 60_000 })
    // Opened from the row's right-hand end rather than over its text. WebKit selects the word under the
    // pointer on a right-click, and a live selection is exactly when the browser's own menu is the
    // better one (`keepNativeContextMenu`), so a colour check aimed at the subject line would be
    // measuring that rule instead of the menu. C66 below is the test that grades the text half.
    const row = page.locator(ROW).nth(1)
    const box = (await row.boundingBox())!
    await rightClickPoint(page, Math.round(box.x + box.width - 20), Math.round(box.y + box.height / 2))
    await expect(page.locator(MENU)).toHaveCount(1)
    const resting = await contrastOf(page, `${ITEM}:not(.focused) .wn-context-menu-label`)
    await page.locator(ITEM).nth(1).hover()
    await expect(page.locator(`${ITEM}.focused`)).toHaveCount(1)
    // Past the 100ms background transition, or the reading is an interpolated alpha.
    await page.waitForTimeout(300)
    const hovered = await contrastOf(page, `${ITEM}.focused .wn-context-menu-label`)
    measured.push(`${theme}: resting ${resting}:1, hovered ${hovered}:1`)
    expect(resting, `${theme} resting label contrast`).toBeGreaterThanOrEqual(3)
    expect(hovered, `${theme} hovered label contrast`).toBeGreaterThanOrEqual(3)
    await shoot(page.locator(MENU), `c42-${theme.toLowerCase()}-menu-webkit`)
    await closeMenu(page)
  }
  await writeEvidence('c42-themes-webkit.txt', ['C42 menu in both themes (webkit)', ...measured])
})

test('C66 every kind of row answers a right-click at its start, its centre and its end', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDenseList(page, port)
  await twist(page, 'inbox').click()
  await expect(page.locator(`${PANE} .mail-mailbox.child`).first()).toBeVisible()
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
    {
      name: 'smart account child',
      line: page.locator(`${PANE} .mail-mailbox.child`).first().locator('xpath=ancestor::li[1]'),
    },
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
  await writeEvidence('c66-sweep-webkit.txt', ['C66 the whole-line sweep (webkit)', ...seen])
})
