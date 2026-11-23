import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * The reader's sender line keeps the sender readable on a narrow reader (2026-10-15): the account pill
 * and the date never shrink, and with the name as the only item that could, an address-only sender
 * broke one letter per line. The real stylesheet on the header's own structure, at the reader widths
 * a three-pane console reaches, plain and at 125% page zoom (where the report came from).
 *
 * 2026-11-22 review: the header read out of order (the sender, the account and the date spread
 * across the row, the date far right over its Details), and a grouped row's address wrapped a lone
 * ".org" under the subject. The account, date and Details are one line under the sender, and an
 * address breaks only after its "@" (AddressWords.tsx's <wbr>).
 */

const CSS = process.env.MAIL_READER_CSS || path.join(process.cwd(), 'web/src/apps/mail/mail-reader.css')
const ROW_CSS = ['web/src/styles/text-fit.css', 'web/src/apps/mail/mail-groups.css'].map((f) => path.join(process.cwd(), f))

async function header(page: Page, width: number, from: { name: string; address?: string }): Promise<void> {
  const css = await fs.readFile(CSS, 'utf8')
  const address = from.address ? `<span class="mail-reader-address">${from.address}</span>` : ''
  await page.setContent(`<!doctype html><style>${css}</style>
    <div class="mail-app"><header class="mail-reader-head mail-reader-column" style="width:${width}px;box-sizing:border-box">
      <div class="mail-reader-sender">
        <span class="mail-avatar">S</span>
        <span class="mail-reader-who">
          <span class="mail-reader-identity"><span class="mail-reader-from">${from.name}</span>${address}</span>
          <span class="mail-reader-when"><span class="mail-reader-account">reader@mail.example.invalid</span>
            <time class="mail-reader-date">Wed, Oct 14, 2026 at 11:17 AM</time>
            <button type="button" class="btn btn-sm mail-reader-details-btn">Details</button></span>
        </span>
      </div>
    </header></div>`)
}

const CASES = [
  { label: 'an address-only sender', from: { name: 'statements@realty.example.invalid' } },
  { label: 'a named sender', from: { name: 'Harbour Airlines', address: 'notices@airline.example.invalid' } },
]

for (const zoom of [1, 1.25]) {
  for (const { label, from } of CASES) {
    test(`${label} stays readable on a narrow reader at ${zoom * 100}% zoom`, async ({ page }) => {
      for (const width of [440, 540, 720]) {
        await header(page, width, from)
        if (zoom !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z) }, zoom)
        const box = await page.locator('.mail-reader-from').boundingBox()
        const identity = await page.locator('.mail-reader-identity').boundingBox()
        const line = await page.locator('.mail-reader-from').evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight) || 20)
        // The sender's block keeps a readable measure, and the name never takes more than two lines
        // (the old break was one letter per line).
        expect(identity!.width, `${width}px reader`).toBeGreaterThan(150 * zoom)
        expect(box!.height, `${width}px reader`).toBeLessThanOrEqual(line * 2 * zoom + 2)
        // The date stays inside the reader, right-aligned.
        const when = await page.locator('.mail-reader-when').boundingBox()
        const head = await page.locator('.mail-reader-head').boundingBox()
        expect(when!.x + when!.width).toBeLessThanOrEqual(head!.x + head!.width + 1)
        // Where and when read under who, starting where the sender starts.
        const fromBox = (await page.locator('.mail-reader-identity').boundingBox())!
        expect(when!.y, `${width}px reader`).toBeGreaterThanOrEqual(fromBox.y + fromBox.height - 1)
        expect(Math.abs(when!.x - fromBox.x), `${width}px reader`).toBeLessThanOrEqual(1)
        const date = (await page.locator('.mail-reader-date').boundingBox())!
        const pill = (await page.locator('.mail-reader-account').boundingBox())!
        // The line wraps between whole items, never inside the date; with room they share one line.
        expect(date.height, `${width}px: the date stays one line`).toBeLessThanOrEqual(line * zoom + 2)
        if (width >= 540 * zoom) expect(Math.abs(date.y + date.height / 2 - (pill.y + pill.height / 2)), `${width}px: account and date share a line`).toBeLessThanOrEqual(3)
      }
    })
  }
}

// A grouped row's sender beside its subject (MailGroupLine.tsx's kid row, its real stylesheet).
test('an address-only sender in a grouped row breaks after its "@", never before a lone ending', async ({ page }) => {
  const css = (await Promise.all(ROW_CSS.map((f) => fs.readFile(f, 'utf8')))).join('\n')
  for (const width of [500, 560, 640]) {
    await page.setContent(`<!doctype html><style>${css} body { font: 14px sans-serif; margin: 0 }</style>
      <div class="mail-row mail-kid" style="width:${width}px;box-sizing:border-box">
        <span class="mail-kid-dot"></span>
        <span class="mail-kid-from wn-title">donotreply@<wbr>riversidebakery.example</span>
        <span class="mail-kid-subject wn-title">Action needed: your bread club payment is due</span>
        <span class="mail-row-time wn-fixed">19m ago</span>
      </div>`)
    // Each half of the address stays on one line: the break, when there is one, is at its "@".
    const parts = await page.locator('.mail-kid-from').evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => {
      const range = document.createRange()
      range.selectNodeContents(n)
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
    }))
    expect(parts, `${width}px row`).toEqual([1, 1])
  }
})
