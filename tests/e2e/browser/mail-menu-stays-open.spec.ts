/**
 * The row menu must still be there a few seconds later (reported 2026-09-22: "the right click will
 * auto cancel, like disappear after like 2 seconds").
 *
 * The menu's dismissers include `scroll` in the CAPTURE phase on `window`, which sees every scroll in
 * the page, not just one the person performed. The mail list is reloaded wholesale whenever a sync or
 * arrival event names the folder on screen, and a list whose rows are all replaced can clamp its
 * scroller — which fires `scroll` and takes the menu down under a hand that never moved.
 *
 * ContextMenu already arms that dismisser one frame late so a menu cannot close itself on its OWN
 * opening. This grades the case that delay does not cover: a list patch arriving later.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-menu-stays-open'
const WRITER = 'fixture:ctx-writer@example.invalid'
const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'

test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
})

test.afterAll(async () => { await server.stop() })

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

function menu(page: Page): Locator {
  return page.getByTestId('mail-row-ctx-menu')
}

async function openInbox(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  await expect(row(page, KEEPER)).toBeVisible({ timeout: 90_000 })
}

test('the menu is still open five seconds after the right-click, with no hand on the mouse', async ({ page }) => {
  await openInbox(page)
  // Every scroll event the page emits while the menu is up, with its target, so a close has a cause
  // rather than a guess.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __scrolls: string[] }).__scrolls = seen
    window.addEventListener('scroll', (e) => {
      const el = e.target as HTMLElement | Document
      seen.push(el instanceof HTMLElement ? `${el.tagName}.${el.className}`.slice(0, 80) : 'document')
    }, true)
  })

  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)

  await page.waitForTimeout(5_000)
  const scrolls = await page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls)
  console.log(`scroll events while the menu was up: ${JSON.stringify(scrolls)}`)
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'after-5s')}`)
  await expect(menu(page), 'nobody moved the mouse, so the menu must still be there').toHaveCount(1)
})

test('the menu survives with the reader open, whose body is a sandboxed iframe', async ({ page }) => {
  await openInbox(page)
  // The shape the report came from: they were reading mail, then right-clicked another row. The reader's
  // body is an iframe, and an iframe that takes focus blurs the WINDOW, which is one of the menu's
  // dismissers.
  await row(page, LUNCH).click()
  await expect(page.getByTestId('mail-reader')).toBeVisible({ timeout: 60_000 })

  const events: string[] = []
  page.on('console', (msg) => { if (msg.text().startsWith('[menu-probe]')) events.push(msg.text()) })
  await page.evaluate(() => {
    for (const name of ['blur', 'focus', 'resize'] as const) {
      window.addEventListener(name, () => console.log(`[menu-probe] window ${name}`
        + ` active=${(document.activeElement?.tagName ?? 'none')}`))
    }
    window.addEventListener('scroll', (e) => {
      const el = e.target as HTMLElement | Document
      console.log(`[menu-probe] scroll ${el instanceof HTMLElement ? el.tagName + '.' + el.className : 'document'}`)
    }, true)
  })

  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)
  await page.waitForTimeout(6_000)
  console.log(`events while the menu was up: ${JSON.stringify(events)}`)
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'reader-open-after-6s')}`)
  await expect(menu(page), 'the reader being open is not a dismissal').toHaveCount(1)
})

test('another pane scrolling is not a dismissal, but the row\'s own scroller still is', async ({ page }) => {
  await openInbox(page)
  await row(page, KEEPER).click({ button: 'right' })
  await expect(menu(page)).toHaveCount(1)

  // THE REPORTED CAUSE. Any scroll anywhere used to reach the menu's `window` capture listener, so a
  // pane the person never touched closed it: here, an element that does not contain the row.
  await page.evaluate(() => {
    const far = document.createElement('div')
    far.style.cssText = 'position:fixed;left:-9999px;width:50px;height:50px;overflow:auto'
    far.innerHTML = '<div style="height:500px"></div>'
    document.body.appendChild(far)
    far.scrollTop = 120
    far.dispatchEvent(new Event('scroll', { bubbles: false }))
  })
  await page.waitForTimeout(400)
  await expect(menu(page), 'a scroll in a pane that does not hold the row is not a gesture')
    .toHaveCount(1)

  // And the rule it must not break: scrolling the list the row lives in DOES close the menu, because
  // the row moves out from under it.
  await page.evaluate(() => {
    const anchored = document.querySelector('.mail-row[data-ctx-open="true"]')
      ?? document.querySelector('.mail-row')
    let node: HTMLElement | null = anchored?.parentElement ?? null
    while (node) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && node.scrollHeight > node.clientHeight) {
        node.dispatchEvent(new Event('scroll', { bubbles: false }))
        return
      }
      node = node.parentElement
    }
    // No overflowing ancestor in this small fixture list: the document is the scroller of record.
    document.dispatchEvent(new Event('scroll', { bubbles: false }))
  })
  await expect(menu(page), 'the row\'s own scroller moving the row away still closes it')
    .toHaveCount(0, { timeout: 5_000 })
})
