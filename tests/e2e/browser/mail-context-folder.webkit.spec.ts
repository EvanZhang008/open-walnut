import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { HARBOUR, MailFixtureServer, MARINA, PANE, folderRow, openMail, shoot } from './mail-review-helpers'

/**
 * The left pane's right-click menus in WEBKIT, which is the engine the Mac app is.
 *
 * Only the parts an engine can disagree about, which here is the GESTURE. The rows are `<button>`s
 * that WebKit leaves out of its own tab order, a smart row's chevron is a SIBLING button on the same
 * line, and Control-click is the gesture a Mac user makes: if the handler sat on the row rather than
 * on the line, this is the engine where "most of the line has a menu and the chevron does not" would
 * be seen first. The children are here for the same reason: the outer `<li>` holds both the line and
 * the expanded list, so a gesture placed on it would hand every child row the parent's menu.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file
 * rather than a project; the boot and the locators come from `mail-review-helpers`.
 */

const SHOT_DIR = '/tmp/mail-context-folder/webkit'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  port = (await server.start()).port
})

test.afterAll(async () => { await server.stop() })

function menu(page: Page, testId = 'mail-folder-ctx-menu'): Locator {
  return page.getByTestId(testId)
}

function itemLabels(page: Page, testId = 'mail-folder-ctx-menu'): Promise<string[]> {
  return menu(page, testId).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
}

function smartLine(page: Page, role: string): Locator {
  return page.locator(`${PANE} .mail-smart li:has(.mail-mailbox.smart[data-smart="${role}"]) > .mail-mailbox-line`)
}

function child(page: Page, role: string, accountId: string): Locator {
  return page.locator(
    `${PANE} .mail-smart li:has(.mail-mailbox.smart[data-smart="${role}"])`
    + ` .mail-smart-children li:has(> .mail-mailbox.child[data-account-id="${accountId}"])`,
  )
}

async function expand(page: Page, role: string): Promise<void> {
  const twist = page.locator(`${PANE} .mail-twist[data-smart="${role}"]`)
  await expect(twist).toHaveCount(1, { timeout: 120_000 })
  if ((await twist.getAttribute('aria-expanded')) !== 'true') await twist.click()
}

test('G10: the whole smart line owns the gesture, chevron included', async ({ page }) => {
  await openMail(page, port)
  const line = smartLine(page, 'inbox')
  await expect(line).toHaveCount(1, { timeout: 120_000 })
  const box = await line.boundingBox()
  expect(box, 'the line has a box to aim at').not.toBeNull()

  // The front, the middle and the back of ONE line. The front is the chevron, which is a sibling
  // button: a handler on the row would leave those 20px to WebKit's own menu.
  const y = Math.round((box?.height ?? 28) / 2)
  for (const x of [8, Math.round((box?.width ?? 200) / 2), Math.round((box?.width ?? 200) - 8)]) {
    if (await overText(line, x, y)) {
      // Not this package's to decide: a right-click that lands on the row's own label makes WebKit
      // select that word, and the SHARED rule then keeps the browser's menu on purpose (rule 6). The
      // gesture is graded everywhere else on the line.
      console.log(`x=${x} sits on the row's label, where WebKit keeps its own menu`)
      continue
    }
    await line.click({ button: 'right', position: { x, y } })
    await expect(menu(page, 'mail-smart-ctx-menu'), `x=${x} opened the Walnut menu`).toHaveCount(1)
    expect(await itemLabels(page, 'mail-smart-ctx-menu')).toEqual([
      'Open this list',
      'Check for new mail',
      'Show accounts in this list',
    ])
    // Exactly one menu, never two stacked: the second right-click moves the first one.
    await expect(page.locator('.wn-context-menu')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(menu(page, 'mail-smart-ctx-menu')).toHaveCount(0)
  }
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-smart-line')}`)
})


/**
 * Whether a point inside this line sits on the row's own TEXT.
 *
 * WebKit selects the word under the cursor as part of a right-click (that is how Safari can offer
 * "Look Up"), and the shared rule then keeps the BROWSER's menu because a live selection inside the
 * row is one of the three cases where the native menu is the better one. Measured here rather than
 * assumed: it decides where a gesture can be aimed, and it is reported as a finding of its own.
 */
function overText(row: Locator, x: number, y: number): Promise<boolean> {
  return row.evaluate((element, point) => {
    const box = element.getBoundingClientRect()
    const at = { x: box.left + point.x, y: box.top + point.y }
    // The CHARACTERS, not the boxes around them. A row's name span is a flex item that stretches
    // across the line, so its box says "text" over empty space where WebKit selects nothing: the
    // glyph rectangles come from a Range over each text node.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const rects: DOMRect[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      rects.push(...Array.from(range.getClientRects()))
    }
    return rects.some((rect) => (
      at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom
    ))
  }, { x, y })
}

/** A point inside this line that is over no text, so the gesture is the only thing happening. */
async function pointOffText(row: Locator): Promise<{ x: number, y: number }> {
  const box = await row.boundingBox()
  const width = Math.round(box?.width ?? 200)
  const y = Math.round((box?.height ?? 24) / 2)
  for (let x = width - 6; x > 6; x -= 6) {
    if (!(await overText(row, x, y))) return { x, y }
  }
  return { x: width - 6, y }
}

test('a Mac Control-click is the same gesture', async ({ page }) => {
  await openMail(page, port)
  const row = folderRow(page, HARBOUR, 'Archive')
  await expect(row).toHaveCount(1, { timeout: 120_000 })
  // WebKit dispatches `contextmenu` for Control plus the left button, which is how this is done on a
  // Mac. Same path, so the row must not be opened by it either.
  await page.keyboard.down('Control')
  await row.click({ position: await pointOffText(row) })
  await page.keyboard.up('Control')
  await expect(menu(page)).toHaveCount(1)
  expect(await itemLabels(page)).toContain('Fetch this folder now')
  await expect(row).not.toHaveClass(/active/)
  await page.keyboard.press('Escape')
})

test('C39 and C58: a child row carries its own pair, and All Drafts children are Drafts rows', async ({ page }) => {
  await openMail(page, port)
  const bodies: { accountId?: string, mailboxId?: string }[] = []
  await page.route('**/api/plugins/mail/mailboxes/fetch', async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}') as { accountId?: string })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched: true, added: 0, updated: 0 }),
    })
  })

  await expand(page, 'inbox')
  const marina = child(page, 'inbox', MARINA)
  await expect(marina).toHaveCount(1, { timeout: 60_000 })
  const mailboxId = await marina.locator('.mail-mailbox.child').getAttribute('data-mailbox-id')
  await marina.click({ button: 'right', position: await pointOffText(marina) })
  // The CHILD's own menu, not the merged row's: the line above owns a different one, and the outer
  // `<li>` wraps both, which is why the gesture is on the child's own `<li>` rather than on that.
  await expect(menu(page)).toHaveAttribute('aria-label', 'Folder actions')
  await expect(menu(page, 'mail-smart-ctx-menu')).toHaveCount(0)
  await menu(page).locator('[role="menuitem"]', { hasText: 'Fetch this folder now' }).click()
  await expect.poll(() => bodies.filter((one) => one.mailboxId === mailboxId).length, { timeout: 60_000 })
    .toBe(1)
  expect(bodies.filter((one) => one.mailboxId === mailboxId)[0]?.accountId).toBe(MARINA)

  await expand(page, 'drafts')
  const drafts = child(page, 'drafts', MARINA)
  await expect(drafts).toHaveCount(1, { timeout: 60_000 })
  await drafts.click({ button: 'right', position: await pointOffText(drafts) })
  expect(await itemLabels(page)).toEqual(['Open Drafts', 'New message'])
  await expect(menu(page)).toHaveAttribute('aria-label', 'Drafts actions')
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-children')}`)
  await page.keyboard.press('Escape')
  // The reserved pair never reached the fetch route.
  expect(bodies.some((one) => one.mailboxId === '__walnut_drafts__')).toBe(false)
})
