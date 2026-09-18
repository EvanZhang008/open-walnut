import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  TAIL_FOLDER,
  accountSection,
  folderRow,
  openMail,
  pickTheme,
  shoot,
  smartRow,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * The third review round, one test per finding, at the dense fixture's density.
 *
 *   N1  the collapse row printed `6 unread` over 202 hidden unread messages: a count of FOLDERS in the
 *       unit of MESSAGES, one thirty-third of the number it was standing over
 *   N2  the account chip took more width than the sender and was itself ellipsised on 19 of 50 rows
 *   N3  All Sent printed the account name as the sender AND again as the chip, and never said who to
 *   N4  the expanded tail showed two identical `Show fewer folders` buttons a row apart while filtering
 *   N5  a promoted row got its `New` mark back after it had been opened and read
 *   N6  selecting a smart child filled two rows, and the louder one carried no `aria-current`
 *   N7  the narrow drill page stopped every row 312px short of a pane its head filled
 *   N8  `Smart mailboxes` measured 3.33:1 in the light theme at 11px
 *  N12  the collapse row is one type size smaller than its neighbours, which is a measurement
 *  N14  All Sent spent two lines explaining unread in a list where unread is not a thing
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/round3'
const NARROW_COLUMN = { width: 1280, height: 800 }
const WIDE_COLUMN = { width: 1440, height: 900 }

test.setTimeout(420_000)
test.use({ viewport: NARROW_COLUMN })
test.describe.configure({ mode: 'serial' })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start()
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

/** The width one string needs in an element's own font, and what it would need one step larger. */
async function textWidths(page: Page, selector: string, text: string): Promise<Record<string, number>> {
  return page.locator(selector).evaluate((el, sentence) => {
    const style = getComputedStyle(el)
    const canvas = document.createElement('canvas')
    const pen = canvas.getContext('2d')!
    const measure = (size: string) => {
      pen.font = `${style.fontStyle} ${style.fontWeight} ${size} ${style.fontFamily}`
      return Math.ceil(pen.measureText(sentence).width)
    }
    const text = el.querySelector('.mail-tail-text') as HTMLElement
    return {
      slot: Math.round(text.clientWidth),
      at11: measure('11px'),
      at12: measure('12px'),
      at13: measure('13px'),
      size: Number.parseFloat(style.fontSize),
    }
  }, text)
}

test('N1 N12: the collapse clause names its unit, and both clauses fit at both pane widths', async ({ page }) => {
  await openMail(page, port)
  const tail = tailToggle(page, HARBOUR)
  await expect(tail).toBeVisible({ timeout: 90_000 })

  // The string the spec names, verbatim. `6 unread` fitted the row and was read as six unread MESSAGES
  // while `data-hidden-unread` says the row stands over 200 of them.
  await expect(tail).toHaveText('58 more folders, 6 with unread')
  await expect(tail).toHaveAttribute('data-hidden-unread', '200')
  await expect(tail).toHaveAttribute('data-hidden-unread-folders', '6')

  const measured: string[] = []
  for (const [label, size] of [['204px', NARROW_COLUMN], ['232px', WIDE_COLUMN]] as const) {
    await page.setViewportSize(size)
    await expect(tail).toBeVisible()
    const paneWidth = Math.round((await page.locator(PANE).boundingBox())!.width)
    expect(String(paneWidth), 'the pane width this measurement belongs to').toBe(label.replace('px', ''))
    // Both clauses whole: not merely present in the DOM, but inside the row with nothing clipped.
    const shape = await tail.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const right = box.right - Number.parseFloat(getComputedStyle(el).paddingRight)
      const spans = Array.from(el.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
      return {
        height: Math.round(box.height),
        lines: (el.querySelector('.mail-tail-text') as HTMLElement).getClientRects().length,
        parts: spans.map((span) => ({
          text: span.textContent ?? '',
          cut: span.scrollWidth - span.clientWidth,
          past: Math.round(span.getBoundingClientRect().right - right),
        })),
      }
    })
    const widths = await textWidths(page, '.mail-tail-row', '58 more folders, 6 with unread')
    console.log(`N1 ${label}: ${JSON.stringify({ pane: paneWidth, ...shape, ...widths })}`)
    expect(shape.parts.map((one) => one.text), `clauses at ${label}`)
      .toEqual(['58 more folders, ', '6 with unread'])
    expect(shape.parts.every((one) => one.cut <= 1 && one.past <= 1), `nothing clipped at ${label}`)
      .toBe(true)
    expect(shape.lines, `one line at ${label}`).toBe(1)
    expect(widths.size, 'one size for the whole row').toBe(10)
    const rowHeight = await folderRow(page, HARBOUR, 'INBOX').evaluate((el) => (
      Math.round(el.getBoundingClientRect().height)
    ))
    // To the pixel the engine rounds to: WebKit lays a 13px folder row out at 31px against this row's 32px
    // floor, Chromium at 32px, and neither difference is visible.
    expect(Math.abs(shape.height - rowHeight), `at ${label}: row ${shape.height}, folder ${rowHeight}`)
      .toBeLessThanOrEqual(1)
    measured.push(`${label}: ${JSON.stringify({ ...shape, ...widths })}`)
  }
  await page.setViewportSize(NARROW_COLUMN)

  // And in the state the pane is normally in: SCROLLING. A scrollbar takes layout width out of a 204px
  // column (15px in WebKit, and this is where the two engine specs caught an ellipsis that the unscrolled
  // measurement above could not see), so the sentence has to fit the smaller slot, not the bigger one.
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
  const scrolled = await page.locator('.mail-accounts-scroll').evaluate((el) => (
    el.scrollHeight - el.clientHeight
  ))
  expect(scrolled, 'the pane really does scroll in this state').toBeGreaterThan(0)
  const tight = await tail.evaluate((el) => {
    const spans = Array.from(el.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
    return spans.map((span) => span.scrollWidth - span.clientWidth)
  })
  const tightWidths = await textWidths(page, '.mail-tail-row', '58 more folders, 6 with unread')
  expect(tight.every((one) => one <= 1), `nothing clipped while scrolling: ${JSON.stringify(tight)}`)
    .toBe(true)
  // The other half of the size trade, measured in THIS slot: the sentence does not fit one line at 12px or
  // 13px, and the alternatives are a wrapped 46px row or an ellipsis through the number the row exists to
  // admit. 11px fits HERE and not in WebKit, whose scrollbar takes layout width out of the same column
  // (measured in the WebKit twin), which is why the row is 10px rather than 11px. Recorded so a future pass
  // re-measures instead of re-arguing.
  for (const [size, need] of [[12, tightWidths.at12], [13, tightWidths.at13]] as const) {
    expect(need, `${size}px needs ${need}px of a ${tightWidths.slot}px slot`)
      .toBeGreaterThan(tightWidths.slot)
  }
  measured.push(`scrolled: ${JSON.stringify({ tight, ...tightWidths })}`)
  console.log(`N1 N12 collapse row\n${measured.join('\n')}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-collapse-row')}`)
})

test('N4: one collapse control on screen, and none repeated while the filter narrows the tail', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  await tailToggle(page, HARBOUR).click()
  const filter = page.getByTestId('mail-tail-filter')
  await expect(filter).toBeVisible({ timeout: 90_000 })

  // Expanded and unfiltered, the repeat is the way back from a 58 row tail whose end is 1,860px down.
  await expect(page.getByTestId('mail-tail-toggle-head')).toHaveCount(1)
  const controls = page.locator(`${PANE} .mail-tail-row`)
  await expect(controls).toHaveCount(2)

  // Filtered down to one row, the tail is short and its own control is on screen, so the repeat goes. It
  // used to be gated on how many folders were HIDDEN (58), never on how many were DRAWN, so the pane
  // rendered `Show fewer folders`, the filter box, one folder, `Show fewer folders`: two buttons with the
  // same label, the same title and the same `aria-expanded` a row apart, and one name and state twice to a
  // screen reader.
  await filter.fill('receipts')
  await expect(accountSection(page, HARBOUR).locator(`.mail-mailbox[data-mailbox-id="${TAIL_FOLDER}"]`))
    .toHaveCount(1)
  await expect(page.getByTestId('mail-tail-toggle-head')).toHaveCount(0)
  await expect(controls).toHaveCount(1)
  const labels = await controls.allInnerTexts()
  expect(new Set(labels).size, 'no two controls with one label').toBe(labels.length)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-tail-filtered')}`)

  // A filter that still matches a long list keeps the repeat, because the way back is far again: the gate
  // is the number of rows drawn, not the presence of a filter. `a` matches 23 of this account's 58 labels.
  await filter.fill('a')
  await expect(accountSection(page, HARBOUR).locator('ul.mail-mailboxes .mail-mailbox'))
    .toHaveCount(29)
  await expect(page.getByTestId('mail-tail-toggle-head')).toHaveCount(1)
  // And a filter that narrows it below the repeat's own threshold drops the repeat again.
  await filter.fill('re')
  await expect(page.getByTestId('mail-tail-toggle-head')).toHaveCount(0)
  await filter.fill('')
  await expect(controls).toHaveCount(2)
})

test('N5: a folder that has been opened does not get its `New` mark back', async ({ page }) => {
  let inject: ((frame: string) => void) | null = null
  await page.routeWebSocket(/\/ws/, (ws) => {
    const upstream = ws.connectToServer()
    ws.onMessage((message) => upstream.send(message))
    upstream.onMessage((message) => ws.send(message))
    inject = (frame) => ws.send(frame)
  })
  await openMail(page, port)
  const tail = tailToggle(page, HARBOUR)
  await expect(tail).toHaveText('58 more folders, 6 with unread', { timeout: 90_000 })

  expect(inject, 'the socket route is installed').not.toBeNull()
  inject!(JSON.stringify({
    type: 'event',
    name: 'plugin:mail:sync-completed',
    data: { accountId: HARBOUR, mailboxId: TAIL_FOLDER, added: 4, updated: 0 },
    seq: 1,
  }))
  const promoted = accountSection(page, HARBOUR).locator(`.mail-mailbox[data-mailbox-id="${TAIL_FOLDER}"]`)
  await expect(promoted).toHaveCount(1, { timeout: 30_000 })
  await expect(promoted).toHaveAttribute('data-promoted', 'true')
  await expect(promoted.getByTestId('mail-mailbox-new')).toHaveCount(1)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-promoted-new')}`)

  // Open it: the mark's job is done, and it is the OPENING that ends it, not the selection highlight.
  await promoted.click()
  await expect(promoted).toHaveAttribute('aria-current', 'true')
  await expect(promoted.getByTestId('mail-mailbox-new')).toHaveCount(0)

  // Move on. The mark used to come straight back, saying New about mail that had just been read, and it
  // was only cleared by remounting Mail.
  await folderRow(page, HARBOUR, 'INBOX').click()
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  await expect(promoted, 'the row is still lifted out, as a folder opened lately').toHaveCount(1)
  await expect(promoted.getByTestId('mail-mailbox-new'), 'and it is not New any more').toHaveCount(0)
  await expect(promoted).not.toHaveAttribute('data-arrived', /.+/)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-new-mark-gone')}`)
})

/** Every row's sender width, and how many of them the column cuts. */
async function senderShape(page: Page): Promise<Record<string, number>> {
  return page.locator('.mail-rows').evaluate((list) => {
    const rows = Array.from(list.querySelectorAll('.mail-row')) as HTMLElement[]
    const cut = (el: Element | null) => (el ? Number(el.scrollWidth - el.clientWidth > 1) : 0)
    return {
      rows: rows.length,
      sender: Math.round(rows[0]?.querySelector('.mail-row-from')?.getBoundingClientRect().width ?? 0),
      mark: Math.round(rows[0]?.querySelector('.mail-row-account')?.getBoundingClientRect().width ?? 0),
      sendersCut: rows.reduce((sum, row) => sum + cut(row.querySelector('.mail-row-from')), 0),
      marksCut: rows.reduce((sum, row) => sum + cut(row.querySelector('.mail-row-account')), 0),
    }
  })
}

test('N2: the account mark costs the sender column almost nothing and can never truncate', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })

  // The same account's own inbox first, as the measure to compare against.
  await folderRow(page, MARINA, 'inbox').click()
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
  const alone = await senderShape(page)

  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-row-account').first()).toBeVisible({ timeout: 60_000 })
  const merged = await senderShape(page)

  // The finding: the name chip took 110px against the sender's 102px, and was itself ellipsised on 19 of
  // 50 rows. One glyph cannot truncate, and the sender keeps almost all of its per-account measure.
  expect(merged.marksCut, 'a one glyph mark is never cut').toBe(0)
  expect(merged.mark, 'the mark is a glyph, not a column').toBeLessThanOrEqual(20)
  expect(merged.mark, 'and much narrower than the sender').toBeLessThan(merged.sender / 2)
  expect(merged.sender, 'the sender keeps most of the width it has in a single account list')
    .toBeGreaterThan(alone.sender * 0.75)
  expect(merged.sendersCut, 'and cuts no more senders than the per-account list does')
    .toBeLessThanOrEqual(alone.sendersCut)
  console.log(`N2 sender widths: alone ${JSON.stringify(alone)} merged ${JSON.stringify(merged)}`)
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-merged-list')}`)
})

test('N3 N14: All Sent names the recipient, prints no duplicate, and explains no unread', async ({ page }) => {
  // One live provider reports unread on its SENT folder (measured: 8, the same number as its inbox), so the
  // note has to be suppressed by the SCOPE and not merely by a zero. The fixture's sent rows declare none,
  // so the number is added on the wire here rather than in the fixture, which other specs count on.
  await page.route((url) => url.pathname.endsWith('/mailboxes'), async (route) => {
    const answer = await route.fetch()
    const body = await answer.json() as { mailboxes?: Array<Record<string, unknown>> }
    for (const row of body.mailboxes ?? []) if (row.role === 'sent') row.unread = 2
    await route.fulfill({ status: answer.status(), contentType: 'application/json', body: JSON.stringify(body) })
  })
  await openMail(page, port)
  await expect(smartRow(page, 'sent')).toBeVisible({ timeout: 90_000 })
  await smartRow(page, 'sent').click()
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })

  const rows = await page.locator('.mail-rows').evaluate((list) => (
    Array.from(list.querySelectorAll('.mail-row')).slice(0, 10).map((row) => ({
      first: row.querySelector('.mail-row-from')?.textContent ?? '',
      field: row.querySelector('.mail-row-from')?.getAttribute('data-field') ?? '',
      mark: row.querySelector('.mail-row-account')?.textContent ?? '',
    }))
  ))
  expect(rows.length, 'a screenful of sent mail').toBeGreaterThan(5)
  // The one fact a sent list is scanned for. It used to print the account's display name here, and the
  // same string again as the chip beside it, so six of ten rows carried one name twice and no recipient.
  expect(rows.every((one) => one.field === 'to'), `every row names a recipient: ${JSON.stringify(rows)}`)
    .toBe(true)
  expect(rows.every((one) => one.first.startsWith('To ')), 'and says what the name is').toBe(true)
  expect(rows.every((one) => !one.first.includes('To Unknown')), 'never `To Unknown recipient`').toBe(true)
  expect(rows.some((one) => one.first.includes('Berth Office')), 'an outside party').toBe(true)
  expect(rows.some((one) => /\+\d+$/.test(one.first)), 'and a count when there were more').toBe(true)
  expect(rows.every((one) => !one.first.includes(one.mark) || one.mark.length === 1), 'no duplicate name')
    .toBe(true)
  expect(rows.every((one) => one.mark.length <= 1), 'the mark is one glyph').toBe(true)

  // N14: no unread explanation in a list where unread is not a thing, even though these folders DO report
  // unread (2, added on the wire above, which is what the live provider does). The sentence used to sit two
  // lines above the first row explaining a number nobody reads a sent list for.
  // Two accounts, each sent row given 2 on the wire above, and the scope's number is their SUM.
  await expect(page.getByTestId('mail-unread-filter')).toHaveText('4 unread')
  await expect(page.getByTestId('mail-unread-gap')).toHaveCount(0)
  console.log(`N3 rows: ${JSON.stringify(rows.slice(0, 4))}`)
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-all-sent')}`)

  // And it is still said where a person can see the two numbers disagree: the merged inbox.
  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-unread-gap')).toHaveText(
    'These folders report 7 unread and 18 of the messages loaded here are unread.',
    { timeout: 60_000 },
  )
  await page.unroute((url) => url.pathname.endsWith('/mailboxes'))
})

test('N7: the narrow drill page gives the head and the rows one measure', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await page.setViewportSize({ width: 980, height: 800 })
  await page.getByTestId('mail-show-mailboxes').click()
  await expect(page.locator(PANE)).toBeVisible()

  // Relative to the PANE's own left edge: the shell's own width is not what this measures.
  const edges = await page.evaluate(() => {
    const pane = document.querySelector('.mail-accounts-pane') as HTMLElement
    const from = pane.getBoundingClientRect().left
    const right = (selector: string) => {
      const el = pane.querySelector(selector) as HTMLElement | null
      return el ? Math.round(el.getBoundingClientRect().right - from) : 0
    }
    const head = pane.querySelector('.mail-pane-head') as HTMLElement
    return {
      pane: Math.round(pane.getBoundingClientRect().width),
      head: right('.mail-pane-head'),
      headMax: getComputedStyle(head).maxWidth,
      compose: right('.mail-compose-new'),
      smart: right('ul.mail-smart'),
      rows: right('ul.mail-mailboxes'),
      rowsMax: getComputedStyle(pane.querySelector('ul.mail-mailboxes')!).maxWidth,
    }
  })
  console.log(`N7 edges: ${JSON.stringify(edges)}`)
  // The rows and the smart group's hairline used to end 312px short of a pane whose New message button
  // filled it, so the badges landed mid page and the hairline read as a line that failed to draw.
  expect(Math.abs(edges.head - edges.rows), `head ${edges.head} against rows ${edges.rows}`)
    .toBeLessThanOrEqual(2)
  expect(Math.abs(edges.smart - edges.rows), 'the hairline ends where the rows do').toBeLessThanOrEqual(2)
  expect(edges.compose, 'and the primary button no longer reaches past them').toBeLessThanOrEqual(edges.rows + 1)
  expect(edges.pane - edges.rows, 'the column is still a column, not the whole window').toBeGreaterThan(100)
  console.log(`N7 edges: ${JSON.stringify(edges)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-980-pane')}`)
  await page.setViewportSize(NARROW_COLUMN)
})

/** WCAG relative luminance contrast of two `rgb(...)` strings. */
function contrast(fg: string, bg: string): number {
  const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const channel = (raw: number) => {
    const one = raw / 255
    return one <= 0.03928 ? one / 12.92 : ((one + 0.055) / 1.055) ** 2.4
  }
  const lum = (value: string) => {
    const [r, g, b] = parse(value).map(channel) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const a = lum(fg)
  const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('N8: the group title clears AA in both themes', async ({ page }) => {
  await openMail(page, port)
  await expect(page.getByTestId('mail-smart-head')).toBeVisible({ timeout: 90_000 })
  const measured: string[] = []
  for (const theme of ['Light', 'Dark'] as const) {
    await pickTheme(page, theme)
    await expect(page.getByTestId('mail-smart-head')).toBeVisible()
    const read = await page.getByTestId('mail-smart-head').evaluate((el) => {
      const style = getComputedStyle(el)
      let node: HTMLElement | null = el as HTMLElement
      let background = 'rgba(0, 0, 0, 0)'
      while (node && background === 'rgba(0, 0, 0, 0)') {
        background = getComputedStyle(node).backgroundColor
        node = node.parentElement
      }
      return { colour: style.color, background, size: style.fontSize, weight: style.fontWeight }
    })
    const ratio = contrast(read.colour, read.background)
    // 11px at weight 600 is not large text, so the threshold is 4.5:1. Light measured 3.33:1.
    expect(ratio, `${theme}: ${JSON.stringify(read)} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    measured.push(`${theme}: ${ratio.toFixed(2)}:1 ${JSON.stringify(read)}`)
    console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, `chromium-${theme.toLowerCase()}-pane`)}`)
  }
  await pickTheme(page, 'Light')
  console.log(`N8 contrast\n${measured.join('\n')}`)
})
