import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  HARBOUR,
  MailFixtureServer,
  PANE,
  folderRow,
  openMail,
  paneGeometry,
  shoot,
  smartRow,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * The same review findings in WEBKIT, which is the engine the Mac app is.
 *
 * Only the ones an engine can disagree about: the pane's geometry (WebKit's scrollbars take layout width
 * from a 204px column, and a chevron on a text baseline is drawn differently), the collapse row's height
 * and its one-line budget, the account chip on a merged row, and the narrow drill down. The rest are the
 * same DOM in both engines and are graded once, in the Chromium file.
 *
 * A `test.use` browser pin only applies at the top level of its own spec file, so this is a file rather
 * than a project: the boot and the locators come from `mail-review-helpers`.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/review-webkit'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start()
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('F2 F7 F8 F9: one glyph column, one line, one type size, a real gap', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)

  const geometry = await paneGeometry(page)
  expect(geometry.smartGlyph, 'the smart chevron').toBe(12)
  expect(geometry.folderGlyph, 'the folder icon').toBe(12)
  expect(geometry.tailGlyph, 'the collapse chevron').toBe(12)
  // The box model IS the hierarchy: the group entry leftmost (a chevron and nothing else), an ordinary
  // folder 3px right of it (a glyph plus a gap), a child 8px inside its parent, and the collapse row in the
  // parent's column because it belongs to the list as a whole.
  expect(geometry.smartText).toBe(28)
  expect(geometry.folderText).toBe(31)
  expect(geometry.tailText).toBe(28)
  // About one glyph column, not 8px (round 3, N13): at 8px the pane's four left edges all lived within 8px
  // of each other and a child with no glyph read as loose text under its parent.
  expect(geometry.childText - geometry.smartText, 'the child indent').toBeGreaterThanOrEqual(16)

  // The collapse row in the engine whose scrollbar takes 15px out of a 204px column: still ONE line, both
  // clauses whole, a real gap between them, and the same height as a folder row. This is the measurement
  // the two-line version was hiding behind (45px against 31px in WebKit).
  const row = await tailToggle(page, HARBOUR).evaluate((el) => {
    const folder = document.querySelector('.mail-account .mail-mailbox') as HTMLElement
    const label = el.querySelector('.mail-tail-label') as HTMLElement
    const clause = el.querySelector('.mail-tail-unread') as HTMLElement
    const style = getComputedStyle(el)
    return {
      text: el.textContent?.trim() ?? '',
      height: Math.round(el.getBoundingClientRect().height),
      folderHeight: Math.round(folder.getBoundingClientRect().height),
      lines: Math.round(
        (el.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
        / Number.parseFloat(style.lineHeight),
      ),
      gap: Math.round(clause.getBoundingClientRect().left - label.getBoundingClientRect().right),
      cut: [label, clause].map((one) => one.scrollWidth - one.clientWidth),
      sizes: Array.from(new Set([label, clause].map((one) => getComputedStyle(one).fontSize))),
    }
  })
  expect(row.text).toBe('58 more folders, 6 with unread')
  expect(row.lines, 'one line at 204px').toBe(1)
  expect(Math.abs(row.height - row.folderHeight), 'the same height as a folder row').toBeLessThanOrEqual(1)
  expect(row.gap, 'a real gap, not a trailing space').toBeGreaterThanOrEqual(2)
  expect(row.cut.every((one) => one <= 1), `neither clause is cut off: ${row.cut.join(', ')}`).toBe(true)
  expect(row.sizes, 'one type size in one row').toHaveLength(1)
  console.log(`webkit collapse row: ${JSON.stringify({ ...geometry, ...row })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-pane')}`)
})

test('F16 F4 F3: role names, the account chip, and the sentence that explains the numbers', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  // N10: the provider's own name is the label, and a name that already says its role adds no hover text.
  await expect(folderRow(page, HARBOUR, 'INBOX').locator('.mail-mailbox-name')).toHaveText('INBOX')
  await expect(folderRow(page, HARBOUR, 'INBOX')).not.toHaveAttribute('title', /.+/)

  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-row-account').first()).toBeVisible({ timeout: 60_000 })
  // The sentence, on screen in the engine the Mac app is: the provider counts 7 unread in folders whose
  // cached window holds 18, and a title attribute renders in neither engine.
  await expect(page.getByTestId('mail-unread-gap')).toHaveText(
    'These folders report 7 unread and 18 of the messages loaded here are unread.',
  )
  await expect(page.getByTestId('mail-list-count-word')).toHaveText('total')

  const styles = await page.getByTestId('mail-row-account').first().evaluate((label) => {
    const time = label.parentElement!.querySelector('.mail-row-time') as HTMLElement
    const read = (el: Element) => {
      const style = getComputedStyle(el)
      return {
        background: style.backgroundColor,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        weight: style.fontWeight,
        colour: style.color,
      }
    }
    return { label: read(label), time: read(time), clipped: label.scrollWidth - label.clientWidth }
  })
  const differing = (['background', 'border', 'radius', 'weight', 'colour'] as const)
    .filter((key) => styles.label[key] !== styles.time[key])
  expect(differing.length, `label ${JSON.stringify(styles.label)} vs time ${JSON.stringify(styles.time)}`)
    .toBeGreaterThanOrEqual(3)
  expect(styles.label.background).not.toBe('rgba(0, 0, 0, 0)')
  console.log(`webkit row chip: ${JSON.stringify(styles)}`)
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'webkit-merged-list')}`)
})

test('F17: the narrow drill down keeps a count beside its own row', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await page.setViewportSize({ width: 980, height: 800 })
  await page.getByTestId('mail-show-mailboxes').click()
  await expect(page.locator(PANE)).toBeVisible()

  const spread = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.mail-accounts-pane .mail-mailbox')) as HTMLElement[]
    const gaps = rows.map((row) => {
      const name = row.querySelector('.mail-mailbox-name') as HTMLElement | null
      const badge = row.querySelector('.mail-unread-badge') as HTMLElement | null
      if (!name || !badge) return 0
      return Math.round(badge.getBoundingClientRect().left - name.getBoundingClientRect().left)
    })
    return {
      paneWidth: Math.round(document.querySelector('.mail-accounts-pane')!.getBoundingClientRect().width),
      widest: Math.max(...rows.map((row) => Math.round(row.getBoundingClientRect().width))),
      furthest: Math.max(...gaps),
      counted: gaps.filter((gap) => gap > 0).length,
    }
  })
  expect(spread.paneWidth).toBeGreaterThan(600)
  expect(spread.widest, 'rows keep a sane measure').toBeLessThanOrEqual(420)
  expect(spread.counted).toBeGreaterThan(0)
  expect(spread.furthest, 'a count is not across the screen from its name').toBeLessThan(420)
  console.log(`webkit narrow pane: ${JSON.stringify(spread)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-narrow-pane')}`)
})
