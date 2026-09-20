/**
 * Measurements for the THIRD round of fixes to the mail right-click slice, shared by the Chromium and
 * the WebKit spec so both engines answer the same questions.
 *
 * Helpers only, no `test()`: Playwright attributes a test to the file whose stack called `test()`, so a
 * `test.use({ browserName })` pin does not reach a test registered by a helper module.
 *
 * What each one is for, in the order the specs use them:
 *
 *  · `headingShape`  (R3-01): the two heading lines were drawn as two more menu rows, 1px above the
 *    first action with no rule, and a click on the one directly above it did nothing.
 *  · `menuWidth`     (R3-02): the box was content-sized, so its own edge moved from row to row.
 *  · `reasonShape`   (R3-03): the disabled group's sentence rode inside the first row of the group,
 *    indented for an icon column this menu never draws.
 *  · `focusedShape`  (R3-08): the keyboard highlight was an 8% tint with no outline, read as
 *    transparent in the frame right after the key press.
 *  · `activeRowId`   (R3-09): Escape dropped focus to BODY instead of the row it started on.
 */
import { expect, type Page } from '@playwright/test'
import { menu } from './mail-context-fixes-core'

/** The title block against the first row that does something. Every number in R3-01's evidence. */
export async function headingShape(page: Page): Promise<{
  infos: { font: number, weight: number, cursor: string, rule: number, bottom: number }[]
  firstItem: { font: number, weight: number, top: number }
  gap: number
}> {
  await expect(menu(page)).toHaveCount(1)
  return page.evaluate(() => {
    const box = document.querySelector('.wn-context-menu')!
    const num = (value: string) => Math.round(parseFloat(value) * 100) / 100
    const infos = Array.from(box.querySelectorAll('.wn-context-menu-info')).map((one) => {
      const style = getComputedStyle(one)
      return {
        font: num(style.fontSize),
        weight: Number(style.fontWeight),
        cursor: style.cursor,
        rule: num(style.borderBottomWidth),
        bottom: Math.round(one.getBoundingClientRect().bottom),
      }
    })
    const item = box.querySelector('.wn-context-menu-item')!
    const style = getComputedStyle(item)
    const firstItem = {
      font: num(style.fontSize),
      weight: Number(style.fontWeight),
      top: Math.round(item.getBoundingClientRect().top),
    }
    const last = infos[infos.length - 1]
    return { infos, firstItem, gap: last ? firstItem.top - last.bottom : -1 }
  })
}

/** The box's own width, which R3-02 is about. */
export async function menuWidth(page: Page): Promise<number> {
  await expect(menu(page)).toHaveCount(1)
  return page.evaluate(() => Math.round(
    document.querySelector('.wn-context-menu')!.getBoundingClientRect().width,
  ))
}

/** The disabled group's sentence: how many, where its left edge is, and the rows' heights. */
export async function reasonShape(page: Page): Promise<{
  reasons: number
  reasonLeft: number
  labelLefts: number[]
  heights: number[]
  icons: number
}> {
  await expect(menu(page)).toHaveCount(1)
  return page.evaluate(() => {
    const box = document.querySelector('.wn-context-menu')!
    const left = (node: Element) => Math.round(node.getBoundingClientRect().left)
    const reason = box.querySelector('.wn-context-menu-reason')
    return {
      reasons: box.querySelectorAll('.wn-context-menu-reason').length,
      // The TEXT's left edge, not the box's: the sentence is a block with its own padding, and the
      // question is whether it lines up with the labels it explains.
      reasonLeft: reason
        ? Math.round(reason.getBoundingClientRect().left + parseFloat(getComputedStyle(reason).paddingLeft))
        : -1,
      labelLefts: Array.from(box.querySelectorAll('.wn-context-menu-item .wn-context-menu-label'))
        .map((one) => left(one)),
      heights: Array.from(box.querySelectorAll('.wn-context-menu-item'))
        .map((one) => Math.round(one.getBoundingClientRect().height)),
      icons: box.querySelectorAll('.wn-context-menu-icon').length,
    }
  })
}

/**
 * The keyboard highlight, read in the frame that FOLLOWS the key press with no settle.
 *
 * That timing is the point of R3-08: the row carries a background transition, so a read taken right
 * after the press returned `rgba(0, 0, 0, 0)` and a screenshot taken then showed no highlight at all.
 */
export async function focusedShape(page: Page): Promise<{
  label: string, ring: string, background: string, transition: string,
}> {
  return page.evaluate(() => {
    const lit = document.querySelector('.wn-context-menu-item.focused')
    if (!lit) return { label: '', ring: 'none', background: 'none', transition: 'none' }
    const style = getComputedStyle(lit)
    return {
      label: (lit.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ring: style.boxShadow,
      background: style.backgroundColor,
      transition: style.transitionProperty,
    }
  })
}

/** Where the keyboard ended up: the row's own message id when focus went back to a row. */
export function activeRowId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!active || active === document.body) return 'BODY'
    const row = active.closest('.mail-row')
    if (row) return `row ${row.getAttribute('data-message-id')}`
    const folder = active.closest('.mail-mailbox')
    if (folder) return `folder ${folder.getAttribute('data-mailbox-id')}`
    return active.tagName
  })
}

/** The header chip's words, the pane's held-row sentence, and the sidebar row's own mark. */
export async function filterShape(page: Page, accountId: string, mailboxId: string): Promise<{
  chip: string, held: string, sidebar: string | null, sidebarTitle: string,
}> {
  return page.evaluate(({ accountId, mailboxId }) => {
    const text = (selector: string) => {
      const node = document.querySelector(selector)
      return node ? (node.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
    }
    const rowNode = document.querySelector(
      `.mail-mailbox[data-account-id="${accountId}"][data-mailbox-id="${mailboxId}"]`,
    )
    return {
      chip: text('[data-testid="mail-unread-filter"]'),
      held: text('[data-testid="mail-held-rows-line"]'),
      sidebar: rowNode ? rowNode.getAttribute('data-unread-only') : null,
      sidebarTitle: rowNode?.getAttribute('title') ?? '',
    }
  }, { accountId, mailboxId })
}

/** The refusal marker on a row: the words it now carries, and whether it is a real control. */
export async function refusalMark(page: Page, messageId: string): Promise<{
  words: string, tag: string, title: string,
}> {
  return page.evaluate((messageId) => {
    const mark = document.querySelector(
      `.mail-row[data-message-id="${messageId}"] [data-testid="mail-row-flag-failed"]`,
    )
    if (!mark) return { words: '', tag: 'none', title: '' }
    return {
      words: (mark.textContent ?? '').replace(/\s+/g, ' ').trim(),
      tag: mark.tagName,
      title: mark.getAttribute('title') ?? '',
    }
  }, messageId)
}
