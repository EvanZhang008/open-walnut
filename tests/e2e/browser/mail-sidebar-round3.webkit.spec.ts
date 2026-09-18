import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  accountSection,
  folderRow,
  openMail,
  shoot,
  smartRow,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * Round three in the engine the Mac app is (WKWebView), where the findings that only exist here live.
 *
 *   N11 WebKit leaves a `button` out of its tab order, so the seven new sidebar stops the spec documents
 *       were reachable in Chromium only: the whole pane had no keyboard path in the Mac app
 *   N1  the collapse row's sentence has to fit in WebKit's own metrics too
 *   N6  one row looks clicked when a smart child is the current mailbox
 *
 * A `browserName` pin only applies at the top level of its own file, which is why this is a file.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/round3'

test.setTimeout(420_000)
test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
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

/** What has focus, named the way the pane's own tests name things. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return 'BODY'
    if (!el.closest('.mail-accounts-pane')) return `outside:${el.tagName.toLowerCase()}`
    const testId = el.getAttribute('data-testid') ?? ''
    const smart = el.getAttribute('data-smart') ?? ''
    const mailbox = el.getAttribute('data-mailbox-id') ?? ''
    return [testId, smart, mailbox].filter(Boolean).join(':') || el.tagName.toLowerCase()
  })
}

test('N11: Tab reaches the smart rows, their chevrons and the collapse row in WebKit', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })

  // Proof this file really is the Mac app's engine: a `browserName` pin only applies at the top level of
  // its own file, and a WebKit-only finding graded in Chromium is not graded at all. The USER AGENT cannot
  // answer this (the project's device profile sets a Chrome UA on the context whatever the engine is), so
  // the vendor and a WebKit-only global do.
  const engine = await page.evaluate(() => ({
    vendor: navigator.vendor,
    webkitOnly: 'GestureEvent' in window,
    chromium: 'chrome' in window,
  }))
  expect(engine, `WebKit expected, got ${JSON.stringify(engine)}`)
    .toMatchObject({ vendor: 'Apple Computer, Inc.', webkitOnly: true })

  // Clicking a non-focusable element moves the sequential focus starting point to it, so the walk begins
  // where it is clicked: the group's own title, one node above the first chevron. Clicking below the group
  // (an account head) starts the walk past it and the six stops under test are never visited.
  await page.getByTestId('mail-smart-head').click()
  const seen: string[] = []
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab')
    const where = await focused(page)
    if (where !== 'BODY' && !where.startsWith('outside:')) seen.push(where)
    if (seen.includes('mail-tail-toggle')) break
  }
  console.log(`N11 webkit tab stops: ${JSON.stringify(seen)}`)

  // The documented order (spec 6.3): three chevrons and three rows, then the account's folder rows, then
  // the collapse row. Every one of them used to be unreachable here: WebKit tabs to inputs and links, and
  // to a `button` only with an explicit `tabindex`.
  const wanted = [
    'mail-smart-twist:inbox',
    'mail-smart-row:inbox:__smart_inbox__',
    'mail-smart-twist:sent',
    'mail-smart-row:sent:__smart_sent__',
    'mail-smart-twist:drafts',
    'mail-smart-row:drafts:__smart_drafts__',
  ]
  const order = seen.filter((one) => wanted.includes(one))
  expect(order, `the six group stops, in visual order: ${JSON.stringify(seen)}`).toEqual(wanted)
  expect(seen, 'and the collapse row after the folder rows').toContain('mail-tail-toggle')
  expect(seen, 'the folder rows are reachable too').toContain('INBOX')

  // The ring, under a REAL keyboard focus: walk back to the group's first row and measure it there, so
  // this cannot pass on a programmatic `focus()` that `:focus-visible` would not have matched.
  await page.locator('.mail-account-head').first().click()
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab')
    if (await focused(page) === 'mail-smart-row:inbox:__smart_inbox__') break
  }
  expect(await focused(page), 'the walk landed on the row being measured')
    .toBe('mail-smart-row:inbox:__smart_inbox__')
  const ring = await smartRow(page, 'inbox').evaluate((el) => {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const scroll = (el.closest('.mail-accounts-scroll') as HTMLElement).getBoundingClientRect()
    return {
      width: style.outlineWidth,
      offset: style.outlineOffset,
      inside: box.left >= scroll.left - 0.5 && box.right <= scroll.right + 0.5,
    }
  })
  expect(ring.inside, 'the focused row is inside the clipping scroller').toBe(true)
  expect(Number.parseFloat(ring.width), 'and it draws a ring').toBeGreaterThan(0)
  console.log(`N11 focus ring: ${JSON.stringify(ring)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-tab-stops')}`)
})

test('N1 N6: the sentence fits WebKit metrics, and one row looks clicked', async ({ page }) => {
  await openMail(page, port)
  const tail = tailToggle(page, HARBOUR)
  await expect(tail).toBeVisible({ timeout: 90_000 })

  // WebKit has its own text metrics, so the row that has to hold `58 more folders, 6 with unread` in a
  // 204px pane is measured again here rather than assumed from the other engine.
  await expect(tail).toHaveText('58 more folders, 6 with unread')
  const shape = await tail.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const right = box.right - Number.parseFloat(getComputedStyle(el).paddingRight)
    const spans = Array.from(el.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
    return {
      height: Math.round(box.height),
      lines: (el.querySelector('.mail-tail-text') as HTMLElement).getClientRects().length,
      cut: spans.map((span) => span.scrollWidth - span.clientWidth),
      past: spans.map((span) => Math.round(span.getBoundingClientRect().right - right)),
    }
  })
  expect(shape.lines, 'one line in WebKit too').toBe(1)
  expect(shape.cut.every((one) => one <= 1), `nothing clipped: ${JSON.stringify(shape)}`).toBe(true)
  expect(shape.past.every((one) => one <= 1), 'and nothing past the row').toBe(true)
  const rowHeight = await folderRow(page, HARBOUR, 'INBOX').evaluate((el) => (
    Math.round(el.getBoundingClientRect().height)
  ))
  // The same height as its neighbours, to the pixel the engine rounds to: WebKit lays a 13px folder row
  // out at 31px against this row's 32px floor, Chromium at 32px, and neither difference is visible.
  expect(Math.abs(shape.height - rowHeight), `row ${shape.height} against folder ${rowHeight}`)
    .toBeLessThanOrEqual(1)
  // The pane must not gain a sideways scroll to hold this sentence: bleeding the row into the section's
  // 8px inset did buy the width for a 12px row in Chromium and cost 7px of horizontal overflow here.
  const geometry = await tail.evaluate((el) => {
    const scroll = el.closest('.mail-accounts-scroll') as HTMLElement
    const list = el.closest('ul') as HTMLElement
    const item = el.closest('li') as HTMLElement
    return {
      scrollClient: scroll.clientWidth,
      scrollScroll: scroll.scrollWidth,
      scrollOffset: scroll.offsetWidth,
      list: list.offsetWidth,
      item: item.offsetWidth,
      row: (el as HTMLElement).offsetWidth,
      rowRight: Math.round(el.getBoundingClientRect().right - scroll.getBoundingClientRect().left),
    }
  })
  console.log(`N1 webkit collapse row: ${JSON.stringify({ ...shape, ...geometry })}`)
  expect(geometry.scrollScroll - geometry.scrollClient, `no sideways overflow: ${JSON.stringify(geometry)}`)
    .toBeLessThanOrEqual(1)

  // The state the pane is normally in: SCROLLING, where WebKit's scrollbar takes layout width out of a
  // 204px column. This is the slot the sentence actually has to fit, and it is where the ellipsis the other
  // two WebKit specs caught was hiding while the unscrolled measurement above was clean.
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
  const scrolled = await page.locator('.mail-accounts-scroll').evaluate((el) => ({
    over: el.scrollHeight - el.clientHeight,
    sideways: el.scrollWidth - el.clientWidth,
  }))
  expect(scrolled.over, 'the pane really does scroll in this state').toBeGreaterThan(0)
  expect(scrolled.sideways, 'and never sideways').toBeLessThanOrEqual(1)
  const tight = await tail.evaluate((el) => (
    Array.from(el.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
      .map((span) => span.scrollWidth - span.clientWidth)
  ))
  expect(tight.every((one) => one <= 1), `nothing clipped while scrolling: ${JSON.stringify(tight)}`)
    .toBe(true)
  // THIS is the slot that decided the row's type size, and this engine is the only place it can be
  // measured: 11px fits the same column in Chromium and does not fit here, because a WebKit scrollbar takes
  // layout width. One step up from 10px would ellipsise the sentence in the Mac app and nowhere else.
  const need = await tail.evaluate((el) => {
    const style = getComputedStyle(el)
    const pen = document.createElement('canvas').getContext('2d')!
    const at = (size: string) => {
      pen.font = `${style.fontStyle} ${style.fontWeight} ${size} ${style.fontFamily}`
      return Math.ceil(pen.measureText('58 more folders, 6 with unread').width)
    }
    return {
      slot: Math.round((el.querySelector('.mail-tail-text') as HTMLElement).clientWidth),
      size: style.fontSize,
      at10: at('10px'),
      at11: at('11px'),
    }
  })
  expect(need.size, 'the size this slot forced').toBe('10px')
  expect(need.at10, `10px needs ${need.at10}px of a ${need.slot}px slot`).toBeLessThanOrEqual(need.slot)
  expect(need.at11, `11px needs ${need.at11}px of a ${need.slot}px slot`).toBeGreaterThan(need.slot)
  console.log(`N1 webkit scrolled: ${JSON.stringify({ ...scrolled, tight, ...need })}`)

  // N6: the child of an open group can show that its mailbox is the list on screen without becoming a
  // second thing that looks clicked. Two filled rows 400px apart is what shipped.
  const child = page.locator(`${PANE} [data-testid="mail-smart-child"][data-account-id="${MARINA}"]`)
  await expect(child).toBeVisible()
  await child.click()
  await expect(page.locator(`${PANE} .mail-mailbox.active`)).toHaveCount(1)
  await expect(child).toHaveAttribute('data-current', 'true')
  await expect(child).not.toHaveClass(/\bactive\b/)
  await expect(folderRow(page, MARINA, 'inbox')).toHaveAttribute('aria-current', 'true')
  const marks = await child.evaluate((row) => {
    const chosen = row.closest('.mail-accounts-pane')!.querySelector('.mail-mailbox.active')!
    return {
      child: getComputedStyle(row).backgroundColor,
      chosen: getComputedStyle(chosen).backgroundColor,
      rail: getComputedStyle(row).boxShadow,
    }
  })
  expect(marks.child, 'the child is not filled like the chosen row').not.toBe(marks.chosen)
  expect(marks.rail, 'it carries a rail instead').not.toBe('none')
  // N13: an indent a person can see without measuring, in this engine too.
  const edges = await page.evaluate(() => {
    const left = (selector: string) => {
      const el = document.querySelector(`.mail-accounts-pane ${selector}`) as HTMLElement
      const name = (el.querySelector('.mail-mailbox-name') ?? el) as HTMLElement
      const pane = document.querySelector('.mail-accounts-pane') as HTMLElement
      return Math.round(name.getBoundingClientRect().left - pane.getBoundingClientRect().left)
    }
    return {
      parent: left('.mail-mailbox.smart'),
      child: left('.mail-mailbox.child'),
      folder: left('ul.mail-mailboxes .mail-mailbox'),
    }
  })
  expect(edges.child - edges.parent, `child indent: ${JSON.stringify(edges)}`).toBeGreaterThanOrEqual(16)
  console.log(`N6 N13 webkit: ${JSON.stringify({ ...marks, ...edges })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'webkit-child-current')}`)
})
