import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * The reader's sender line keeps the sender readable on a narrow reader (2026-10-15): the account pill
 * and the date never shrink, and with the name as the only item that could, an address-only sender
 * broke one letter per line. The real stylesheet on the header's own structure, at the reader widths
 * a three-pane console reaches, plain and at 125% page zoom (where the report came from).
 */

const CSS = process.env.MAIL_READER_CSS || path.join(process.cwd(), 'web/src/apps/mail/mail-reader.css')

async function header(page: Page, width: number, from: { name: string; address?: string }): Promise<void> {
  const css = await fs.readFile(CSS, 'utf8')
  const address = from.address ? `<span class="mail-reader-address">${from.address}</span>` : ''
  await page.setContent(`<!doctype html><style>${css}</style>
    <div class="mail-app"><header class="mail-reader-head mail-reader-column" style="width:${width}px;box-sizing:border-box">
      <div class="mail-reader-sender">
        <span class="mail-avatar">S</span>
        <span class="mail-reader-identity"><span class="mail-reader-from">${from.name}</span>${address}</span>
        <span class="mail-reader-account">reader@mail.example.invalid</span>
        <span class="mail-reader-when"><time class="mail-reader-date">Wed, Oct 14, 2026 at 11:17 AM</time>
          <button type="button" class="mail-reader-details-btn">Details</button></span>
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
      }
    })
  }
}
