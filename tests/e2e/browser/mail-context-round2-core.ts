/**
 * Round 2 of the mail right-click slice, measured in the browser and shared by both engines.
 *
 * Helpers only. Every `test()` lives in its own spec file, because a `test.use({ browserName })` pin
 * does not reach tests a helper module registers (that mistake once ran a "WebKit" half in Chromium).
 *
 * What each helper answers:
 *
 *  · `unreadChip`    (R2-01): the chip and the folder menu's switch have to read ONE preference.
 *  · `stripShape`    (R2-03, R2-15): an answer never covers a row it is not about.
 *  · `highlightBox`  (R2-05): the keyboard highlight has to stay inside the clamped box.
 *  · `markShape`     (R2-10): the right-clicked mark differs from the selection in KIND.
 *  · `contrastOf`    (R2-09): the heading naming the target row is load bearing, so it clears AA.
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

export function row(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${accountId}"][data-message-id="${messageId}"]`)
}

export function menu(page: Page): Locator {
  return page.locator(MENU)
}

export function item(page: Page, label: string): Locator {
  return menu(page).locator('[role="menuitem"]', { hasText: label }).first()
}

export async function openRowMenu(page: Page, accountId: string, messageId: string): Promise<void> {
  await row(page, accountId, messageId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

export async function openFolderMenu(page: Page, accountId: string, mailboxId: string): Promise<void> {
  await folderRow(page, accountId, mailboxId).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
}

/** Into the writer's inbox with its rows on screen: most cases start here. */
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

/** The header chip's own state, next to what the list is showing. */
export function unreadChip(page: Page): Promise<{
  present: boolean, on: string | null, pressed: string | null, text: string,
  rows: number, unreadRows: number, emptyState: boolean, showAll: boolean, cacheLine: boolean,
}> {
  return page.evaluate(() => {
    const chip = document.querySelector('[data-testid="mail-unread-filter"]') as HTMLElement | null
    const rows = Array.from(document.querySelectorAll('.mail-rows .mail-row'))
    return {
      present: !!chip,
      on: chip?.getAttribute('data-on') ?? null,
      pressed: chip?.getAttribute('aria-pressed') ?? null,
      text: (chip?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      rows: rows.length,
      unreadRows: rows.filter((one) => one.getAttribute('data-unread') === 'true').length,
      emptyState: !!document.querySelector('[data-testid="mail-unread-empty"]'),
      showAll: !!document.querySelector('[data-testid="mail-unread-show-all"]'),
      cacheLine: !!document.querySelector('[data-testid="mail-folder-outside-window"]'),
    }
  })
}

/**
 * The answer strip in either pane: where it is, and whether it is standing over anything.
 *
 * `covers` counts the rows of the pane it belongs to whose box it overlaps. Floated, the sidebar's three
 * cards covered a whole second account and the list's card covered the last row of a full list.
 */
export function stripShape(page: Page, which: 'pane' | 'row'): Promise<{
  present: boolean, positioned: string, lines: number, covers: number, dismiss: boolean, zIndex: string,
}> {
  return page.evaluate((side) => {
    const testId = side === 'pane' ? 'mail-pane-toast' : 'mail-row-toast'
    const strip = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
    if (!strip) return { present: false, positioned: 'none', lines: 0, covers: -1, dismiss: false, zIndex: '' }
    const box = strip.getBoundingClientRect()
    const rowSelector = side === 'pane' ? '.mail-accounts-pane .mail-mailbox' : '.mail-rows .mail-row'
    const covers = Array.from(document.querySelectorAll(rowSelector)).filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1
    }).length
    const dismissId = side === 'pane' ? 'mail-pane-strip-close' : 'mail-row-note-close'
    return {
      present: true,
      positioned: getComputedStyle(strip).position,
      lines: strip.querySelectorAll('p').length || 1,
      covers,
      dismiss: !!strip.querySelector(`[data-testid="${dismissId}"]`),
      zIndex: getComputedStyle(strip).zIndex,
    }
  }, which)
}

/** The top of every folder row in the sidebar, for "did the answer move the list". */
export function folderTops(page: Page): Promise<number[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mail-accounts-pane .mail-mailbox'))
    .map((one) => Math.round(one.getBoundingClientRect().top)))
}

/** The highlighted item against the clamped box: is it inside, and did the box follow it? */
export function highlightBox(page: Page): Promise<{
  label: string, inside: boolean, scrollTop: number, hidden: number, more: string | null,
  scrollbar: number, masked: boolean,
}> {
  return page.evaluate(() => {
    const box = document.querySelector('.wn-context-menu') as HTMLElement | null
    if (!box) return { label: '', inside: false, scrollTop: -1, hidden: -1, more: null, scrollbar: -1, masked: false }
    const lit = box.querySelector('.wn-context-menu-item.focused') as HTMLElement | null
    const outer = box.getBoundingClientRect()
    const rect = lit?.getBoundingClientRect()
    const style = getComputedStyle(box)
    const mask = style.maskImage || style.webkitMaskImage || 'none'
    return {
      label: (lit?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      inside: !!rect && rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1,
      scrollTop: Math.round(box.scrollTop),
      hidden: box.scrollHeight - box.clientHeight,
      more: box.getAttribute('data-more'),
      scrollbar: box.offsetWidth - box.clientWidth,
      masked: mask !== 'none' && mask !== '',
    }
  })
}

/** The two marks on one row: the selection bar and the right-clicked ring, as they really compute. */
export function markShape(page: Page, accountId: string, messageId: string): Promise<{
  shadow: string, background: string, accent: string, ringsWithAccent: boolean, keepsBar: boolean,
}> {
  return page.evaluate(([account, message]) => {
    const one = document.querySelector(
      `.mail-row[data-account-id="${account}"][data-message-id="${message}"]`,
    ) as HTMLElement | null
    if (!one) return { shadow: '', background: '', accent: '', ringsWithAccent: false, keepsBar: false }
    const style = getComputedStyle(one)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const shadow = style.boxShadow
    // The ring is the `0 0 0 2px inset` shadow; the selection bar is the `2px 0 0` one.
    const parts = shadow.split(/,(?![^(]*\))/).map((part) => part.trim())
    const ring = parts.find((part) => /0px 0px 0px 2px/.test(part)) ?? ''
    const bar = parts.find((part) => /2px 0px 0px( 0px)? inset/.test(part)) ?? ''
    return {
      shadow,
      background: style.backgroundColor,
      accent,
      ringsWithAccent: ring.includes('0, 122, 255'),
      keepsBar: bar.length > 0,
    }
  }, [accountId, messageId])
}

/** Contrast of the menu heading against the menu's own background, computed in the page. */
export function contrastOf(page: Page, selector: string): Promise<{
  ratio: number, colour: string, background: string, size: string,
}> {
  return page.evaluate((target) => {
    const node = document.querySelector(target) as HTMLElement | null
    if (!node) return { ratio: -1, colour: '', background: '', size: '' }
    const style = getComputedStyle(node)
    const paint = (value: string): number[] => {
      const found = value.match(/[\d.]+/g) ?? []
      return found.slice(0, 3).map(Number)
    }
    // The nearest ancestor with a real background is what the text sits on.
    let behind: HTMLElement | null = node
    let backdrop = 'rgba(0, 0, 0, 0)'
    while (behind) {
      const own = getComputedStyle(behind).backgroundColor
      if (own && !/rgba\(0, 0, 0, 0\)|transparent/.test(own)) { backdrop = own; break }
      behind = behind.parentElement
    }
    const lum = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const unit = channel / 255
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    }
    const one = lum(paint(style.color))
    const other = lum(paint(backdrop))
    const ratio = (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05)
    return {
      ratio: Math.round(ratio * 100) / 100,
      colour: style.color,
      background: backdrop,
      size: style.fontSize,
    }
  }, selector)
}
