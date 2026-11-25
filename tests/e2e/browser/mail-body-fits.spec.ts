/**
 * An HTML mail body fits the paper it renders on, in the engine that draws it (run it with
 * `PW_WEBKIT=1 ... --project webkit` for the Mac app's engine).
 *
 * The frame document is the one the reader builds (`buildMailSrcdoc` over `hardenMailHtml`), laid out
 * at the paper widths the reader gives it. Each shape is one way a sender makes a table wider than the
 * paper; before the frame reset wrapped cells, both engines laid the first one out at 996px and cut its
 * button and title at the paper's edge (review 2026-11-08, a CI result mail; on 400 real bodies 337 of
 * 800 layouts overflowed, 34 after). A new shape that overflows belongs in SHAPES with its fix.
 */
import { expect, test } from '@playwright/test'
import { buildMailSrcdoc, hardenMailHtml } from '../../../web/src/apps/mail/mail-html'

const cell = 'style="white-space: nowrap; padding: 16px 16px 16px 0"'
const SHAPES: Record<string, string> = {
  // The CI result card: a centred 544px table whose result cells never wrap.
  'nowrap result cells': `<table width="100%" style="max-width: 544px; margin: 0 auto; width: 100% !important">
    <tr><td><h2>[acme/harbour-ferry] CI workflow run</h2></td></tr>
    <tr><td><a href="https://ci.example.invalid/run/1" style="display: inline-block; padding: 8px 16px">View workflow run</a></td></tr>
    <tr><td><table><tr><th ${cell}>Status</th><th ${cell}>Job</th><th ${cell}>Annotations</th></tr>
      <tr><td ${cell}>Failed</td><td ${cell}>CI / Node side 2/4 (browser specs load, plugin packages, release checks)</td>
      <td ${cell}><span>annotations for CI / Node side 2/4 (browser specs load, plugin packages)</span></td></tr></table></td></tr>
  </table>`,
  // A link with no break opportunity, in a cell.
  'long link in a cell': `<table><tr><td>Open https://tracking.example.invalid/c/eJyNkMFuwyAQRL_GdzBgEsXHqrfeKvXSa4XNGqMaEwFp1L8vjtM2laqqnFaa2Z3dNz3RMG2ECWi5ZrUSWsNqS6oN6qjZZCEjTbaYnThHK3Q2jZYL6t9X91 to read it</td></tr></table>`,
  // The newsletter shape: a table with a fixed pixel width (fitFixedTable).
  'fixed-width table': `<table width="720" border="1"><tr><td>Timetable</td><td>Departs</td><td>Arrives</td></tr></table>`,
  // The pricing-notice shape: a centred wrapper whose pixel width is also its minimum (fitBoxWidths).
  'min-width wrapper': `<table width="600" style="margin: 0 auto; max-width: 600px; min-width: 600px; width: 600px"><tr><td>
    <table style="width: 598px"><tr><td style="padding: 30px 40px 0 40px">${'You are receiving this communication because you have active projects using these tools. '.repeat(3)}</td></tr></table>
  </td></tr></table>`,
  // A block box with a pixel width, inside a full-width shell table's cell.
  'fixed-width block in a cell': `<table width="100%"><tr><td align="center"><div style="width: 520px; border-bottom: 1px solid #ddd">${'There was a recent sign-in to your account from a new device. '.repeat(3)}</div></td></tr></table>`,
  // The sign-in notice's button: a 280px inline-block with 60px side padding, in a padded column's cell.
  'fixed-width button in a padded cell': `<div style="max-width: 600px; padding: 32px 64px 0"><div style="width: 400px; max-width: 400px">
    <table style="width: 100%; border-collapse: collapse"><tr><td style="text-align: center">
      <a href="https://example.invalid/review" style="padding: 12px 60px; border: 1px solid #308bbf; display: inline-block; width: 280px">Review the sign-in</a>
    </td></tr></table></div></div>`,
  // A calendar notice: a sender reset clears the body's padding, and a full-width collapsing table
  // inside inline spans takes 16px side padding from a class rule; WebKit scrolled 32px past it.
  'padded collapsing table': `<style>body { margin: 0; padding: 0; } .body-container { padding-left: 16px; padding-right: 16px; }</style>
    <span><span><table class="body-container" style="width: 100%"><tr><td>${'Your event starts tomorrow at nine at the north pier. '.repeat(4)}</td></tr></table></span></span>`,
  // The `nowrap` attribute rather than a style.
  'nowrap attribute': `<table><tr><td nowrap>${'Ferry departures from the north pier every hour '.repeat(4)}</td></tr></table>`,
}

for (const [name, html] of Object.entries(SHAPES)) {
  test(`a mail body with ${name} fits the paper`, async ({ page }) => {
    const doc = buildMailSrcdoc(hardenMailHtml(html), { allowRemoteImages: false })
    for (const width of [360, 520, 560]) {
      await page.setViewportSize({ width, height: 700 })
      await page.setContent(doc)
      const box = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
      expect(box.scroll, `${name} at ${width}px`).toBeLessThanOrEqual(box.client + 1)
    }
  })
}

test('a preformatted block in a cell keeps its own lines', async ({ page }) => {
  await page.setContent(buildMailSrcdoc(hardenMailHtml('<table><tr><td><pre>line one\n  indented two</pre></td></tr></table>'), { allowRemoteImages: false }))
  expect(await page.locator('pre').evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
})
