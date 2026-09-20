/**
 * The measurements behind the second round of fixes to the mail right-click slice, shared by the
 * Chromium and the WebKit spec so both engines answer the same questions.
 *
 * Helpers only: every `test()` is written in the spec file itself, because Playwright attributes a
 * test to the file whose stack called `test()` and a `test.use({ browserName })` pin therefore does
 * not reach tests a helper module registers (that mistake ran a "WebKit" half in Chromium once
 * already, see mail-context-independent-core.ts).
 *
 * What each helper is for, in the order the specs use them:
 *
 *  · `probeKeyboard`  (N1): Tab used to walk DOM focus through the items while the arrow-key
 *    highlight stood still, so Enter ran an item the human could not see highlighted. On a mail row
 *    that is a provider write against the wrong message.
 *  · `rowTops`        (N2): an answer to a row action must not move the rows it is about.
 *  · `dragAcross`     (N3, C75): a row's own words have to be selectable in BOTH engines.
 *  · `menuOverflow`   (N11): a capped menu has to show that there is more below the fold.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { folderRow, openMail } from './mail-review-helpers'

/** The two accounts `PW_MAIL_CTX=1` adopts: the second can neither mark read nor send. */
export const WRITER = 'fixture:ctx-writer@example.invalid'
export const READER = 'inbound:ctx-reader@example.invalid'

/** Writer rows: unread with an html body, unread with a text body, read and already tasked. */
export const KEEPER = 'INBOX:1:31'
export const LUNCH = 'INBOX:1:30'
export const LEASE = 'INBOX:1:29'

export const MENU = '.wn-context-menu'
export const ROW_MENU = 'mail-row-ctx-menu'

export function row(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)
}

export function menu(page: Page): Locator {
  return page.getByTestId(ROW_MENU)
}

export function item(page: Page, label: string): Locator {
  return menu(page).locator('[role="menuitem"]', { hasText: label }).first()
}

/** The words a person reads in the menu, in order. The heading and the dividers are not items. */
export async function itemLabels(page: Page): Promise<string[]> {
  const found = await menu(page).locator('[role="menuitem"] .wn-context-menu-label').allInnerTexts()
  return found.map((one) => one.trim())
}

/** The heading lines (`info` rows), which is where the account moved to. */
export async function headingLines(page: Page): Promise<string[]> {
  const found = await menu(page).locator('.wn-context-menu-info .wn-context-menu-label').allInnerTexts()
  return found.map((one) => one.trim())
}

export async function openRowMenu(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

/** Into the writer's inbox with its rows on screen: every case starts here. */
export async function intoWriterInbox(page: Page, port: number): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, WRITER, KEEPER)).toBeVisible({ timeout: 90_000 })
}

/** Which engine this really is, read from the page rather than from the project name. */
export async function engineOf(page: Page): Promise<'chromium' | 'webkit'> {
  const ua = await page.evaluate(() => navigator.userAgent)
  return /Chrome\//.test(ua) ? 'chromium' : 'webkit'
}

/** What the keyboard is steering: the highlight, the DOM's focus, and what the menu says is active. */
export interface KeyboardProbe {
  highlighted: string
  domFocus: string
  activeDescendant: string
  activeDescendantText: string
  menus: number
}

export async function probeKeyboard(page: Page): Promise<KeyboardProbe> {
  return page.evaluate(() => {
    const box = document.querySelector('.wn-context-menu')
    const lit = box?.querySelector('.wn-context-menu-item.focused')
    const active = box?.getAttribute('aria-activedescendant') ?? ''
    const named = active ? document.getElementById(active) : null
    const focused = document.activeElement
    const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
    return {
      highlighted: text(lit),
      domFocus: focused ? `${focused.tagName}.${(focused.className || '').split(' ')[0]}` : 'none',
      activeDescendant: active ? 'set' : 'absent',
      activeDescendantText: text(named),
      menus: document.querySelectorAll('.wn-context-menu').length,
    }
  })
}

/** The top of every message row on screen, in order. N2 is a comparison of two of these. */
export function rowTops(page: Page): Promise<number[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mail-row'))
    .map((one) => Math.round(one.getBoundingClientRect().top)))
}

/** The top of every folder row in the sidebar, for the same question on the left pane. */
export function folderTops(page: Page): Promise<number[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mail-accounts-pane .mail-mailbox'))
    .map((one) => Math.round(one.getBoundingClientRect().top)))
}

/** Drag across an element's text the way a person does, and report what got selected. */
export async function dragAcross(page: Page, target: Locator): Promise<string> {
  const box = (await target.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  for (let at = 4; at <= Math.min(box.width - 2, 160); at += 12) {
    await page.mouse.move(box.x + at, y)
  }
  await page.mouse.up()
  return page.evaluate(() => {
    const selection = window.getSelection()
    return selection && !selection.isCollapsed ? selection.toString() : ''
  })
}

/** Is the menu taller than its capped box, and does it say so? */
export function menuOverflow(page: Page): Promise<{
  hidden: number, more: string | null, masked: boolean,
}> {
  return page.evaluate(() => {
    const box = document.querySelector('.wn-context-menu') as HTMLElement | null
    if (!box) return { hidden: -1, more: null, masked: false }
    const style = getComputedStyle(box)
    const mask = style.maskImage || style.webkitMaskImage || 'none'
    return {
      hidden: box.scrollHeight - box.clientHeight,
      more: box.getAttribute('data-more'),
      masked: mask !== 'none' && mask !== '',
    }
  })
}

/**
 * The one-line answer the pane gives for a row action.
 *
 * `positioned` was `absolute` until R2-15: floated, it kept the rows still (what N2 is about) but
 * covered the last row of a full list with an opaque card, so a row was clickable and unreadable. It is
 * a FOOTER now, space the list gives up, which keeps N2's promise and adds `overlaps: 0`.
 */
export function rowToast(page: Page): Promise<{
  text: string, positioned: string, insidePane: boolean, overlaps: number,
}> {
  return page.evaluate(() => {
    const one = document.querySelector('[data-testid="mail-row-toast"]') as HTMLElement | null
    if (!one) return { text: '', positioned: 'none', insidePane: false, overlaps: -1 }
    const box = one.getBoundingClientRect()
    const overlaps = Array.from(document.querySelectorAll('.mail-row')).filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1
    }).length
    return {
      text: (one.textContent ?? '').replace(/\s+/g, ' ').trim(),
      positioned: getComputedStyle(one).position,
      insidePane: Boolean(one.closest('.mail-list-pane')),
      overlaps,
    }
  })
}
