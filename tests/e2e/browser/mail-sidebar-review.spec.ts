import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  TAIL_FOLDER,
  accountSection,
  folderRow,
  openMail,
  paneGeometry,
  shoot,
  smartRow,
  tailToggle,
  twist,
} from './mail-review-helpers'

/**
 * The review's own findings, each pinned by the case that found it, at the dense fixture's density.
 *
 * One test per defect, named by its id, because each of these shipped once already:
 *
 *   F1  the All Drafts badge disagreed with the header over its own view (blank row above "3")
 *   F2  the collapse row printed "58 more folders,6 with unread": a trailing space is dropped in layout
 *   F3  three unread numbers on one screen with the explanation only in a title attribute
 *   F4  the per-row account label was typographically identical to the time beside it
 *   F5  compose from a merged list picked the FIRST account and offered no way to change it
 *   F6  "No drafts. Start one with New message." sat unlabelled above a list of real drafts
 *   F7  the collapse row was half again as tall as its neighbours, with two type sizes
 *   F8  three glyph columns in one 204px pane
 *   F9  a parent 3px left of the rows it aggregates, its children 8px inside it
 *   F10 the folder filter filtered the tail only, leaving six rows above it ignoring the query
 *   F11 the collapse row's second number counted folders while every other number counts mail
 *   F12 one uppercase header directly above two title-case ones
 *   F13 a folder lifted out of the tail arrived with nothing marking it as new
 *   F14 the only way back from a 58 row tail was 1,860px above the end of it
 *   F15 a header total the list can never page to, with no word saying so
 *   F16 the same role named three ways, one of them a raw provider identifier
 *   F17 a count 660px from its own row in the narrow drill down
 *   C35 the degraded line under the list header was never built
 *   C58 the mailbox number and the rows on screen disagree with nothing on screen to explain it
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/review'
const NARROW_COLUMN = { width: 1280, height: 800 }

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

test('F7 F8 F9 F12: one glyph column, one text column, a stepped child, one header style', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)

  const geometry = await paneGeometry(page)
  // ONE glyph column for the whole pane. They used to sit at 12, 16 and 20px, so scanning one narrow
  // column crossed three left edges for the same kind of mark.
  expect(geometry.smartGlyph, 'the smart chevron').toBe(12)
  expect(geometry.folderGlyph, 'the folder icon').toBe(12)
  expect(geometry.tailGlyph, 'the collapse chevron').toBe(12)
  // Every top level row's text starts in the same place, and a child is a step a person can see.
  // The box model IS the hierarchy: the group entry leftmost (a chevron and nothing else), an ordinary
  // folder 3px right of it (a glyph plus a gap), a child about one glyph column inside its parent, and the
  // collapse row in the parent's column because it belongs to the list as a whole. The child's step was 8px
  // (round 3, N13): all four left edges then lived within 8px of each other, the child sat 5px right of a
  // folder row it does not belong to, and with no glyph of its own it read as loose text.
  expect(geometry.smartText).toBe(28)
  expect(geometry.folderText).toBe(31)
  expect(geometry.tailText).toBe(28)
  expect(geometry.childText - geometry.smartText, 'the child indent').toBeGreaterThanOrEqual(16)

  // F7: the collapse row is one line, one type size, the same height as its neighbours, and its chevron
  // is on the line it discloses.
  const shape = await tailToggle(page, HARBOUR).evaluate((row) => {
    const folder = document.querySelector('.mail-account .mail-mailbox') as HTMLElement
    const clauses = Array.from(row.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
    const glyph = row.querySelector('.mail-tail-twist') as HTMLElement
    const label = row.querySelector('.mail-tail-label') as HTMLElement
    return {
      height: Math.round(row.getBoundingClientRect().height),
      folderHeight: Math.round(folder.getBoundingClientRect().height),
      sizes: Array.from(new Set(clauses.map((one) => getComputedStyle(one).fontSize))),
      glyphMiddle: Math.round(glyph.getBoundingClientRect().top + glyph.getBoundingClientRect().height / 2),
      textMiddle: Math.round(label.getBoundingClientRect().top + label.getBoundingClientRect().height / 2),
    }
  })
  expect(Math.abs(shape.height - shape.folderHeight), 'the same height as a folder row')
    .toBeLessThanOrEqual(1)
  expect(shape.sizes, 'one type size in one row').toHaveLength(1)
  expect(Math.abs(shape.glyphMiddle - shape.textMiddle), 'the chevron is on its text')
    .toBeLessThanOrEqual(2)

  // F12: one header style in one pane. The group title used to be the only uppercase header in it.
  const heads = await page.evaluate(() => ({
    smart: getComputedStyle(document.querySelector('.mail-smart-head')!).textTransform,
    account: getComputedStyle(document.querySelector('.mail-account-head')!).textTransform,
  }))
  expect(heads.smart, 'the group title is not shouted').toBe('none')
  expect(heads.smart).toBe(heads.account)
  console.log(`F7 F8 F9 geometry: ${JSON.stringify({ ...geometry, ...shape })}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-pane')}`)
})

// F16 REVERSED in round 3 (N10, C9): the LABEL is the provider's own name and the ROLE is what hover adds.
// The canonical relabel it used to assert put `Archive` over a folder the provider calls something else,
// left the real name unsearchable by the tail filter, and gave two folders of one role one label.
test('N10: a folder row carries the provider name, the role on hover', async ({ page }) => {
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  // The two accounts spell the same role differently (`INBOX` against `Inbox`), and both spellings are
  // what their own provider answers, so both are on screen.
  await expect(folderRow(page, HARBOUR, 'INBOX').locator('.mail-mailbox-name')).toHaveText('INBOX')
  await expect(folderRow(page, MARINA, 'inbox').locator('.mail-mailbox-name')).toHaveText('Inbox')
  // A name that already says its role adds no hover text at all.
  await expect(folderRow(page, HARBOUR, 'INBOX')).not.toHaveAttribute('title', /.+/)
  await expect(folderRow(page, MARINA, 'inbox')).not.toHaveAttribute('title', /.+/)
  // Where the name does NOT say the role, the role is the hover text.
  // B's sent folder id is 90 characters, so it is reached by its prefix rather than spelled out here.
  const marinaSent = accountSection(page, MARINA)
    .locator('.mail-mailbox[data-mailbox-id^="marina/all-mail/sent"]')
  await expect(marinaSent.locator('.mail-mailbox-name')).toHaveText('Sent Mail')
  await expect(marinaSent).toHaveAttribute('title', 'Sent')
  await expect(folderRow(page, MARINA, 'archive').locator('.mail-mailbox-name')).toHaveText('Archived')
  await expect(folderRow(page, MARINA, 'archive')).toHaveAttribute('title', 'Archive')
  await expect(folderRow(page, HARBOUR, 'Spam').locator('.mail-mailbox-name')).toHaveText('Spam')
  await expect(folderRow(page, HARBOUR, 'Spam')).toHaveAttribute('title', 'Junk')
  // An ordinary label keeps the provider's name, which is the only name it has.
  await tailToggle(page, HARBOUR).click()
  const label = folderRow(page, HARBOUR, TAIL_FOLDER)
  await expect(label.locator('.mail-mailbox-name')).toHaveText('Receipts')
  await expect(label).not.toHaveAttribute('title', /.+/)
})

test('F10: the folder filter reaches the labels and never hides a mailbox', async ({ page }) => {
  await openMail(page, port)
  // Reading this account's inbox while filtering, which is the state the defect was worst in: typing
  // deleted the row the person was reading and left nothing in the pane highlighted.
  await folderRow(page, HARBOUR, 'INBOX').click()
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  await tailToggle(page, HARBOUR).click()
  const filter = page.getByTestId('mail-tail-filter')
  await expect(filter).toBeVisible({ timeout: 90_000 })
  const rows = accountSection(page, HARBOUR).locator('ul.mail-mailboxes .mail-mailbox')
  const ROLES = ['INBOX', 'Archive', 'Drafts', 'Sent', 'Spam', 'Trash']

  await filter.fill('re')
  // The role rows are PINNED, and every row after them matches. `Receipts`, `Renewals`, `Reports`,
  // `Reservations`, `Refunds` and `Rewards` are among the labels that do.
  const names = await rows.locator('.mail-mailbox-name').allInnerTexts()
  expect(names.slice(0, 6), `the six role rows stay: ${names.join(', ')}`).toEqual(ROLES)
  expect(names.length, 'and labels match').toBeGreaterThan(6)
  expect(names.slice(6).every((one) => one.toLowerCase().includes('re')), `labels: ${names.join(', ')}`)
    .toBe(true)
  // The row being read is still the highlighted one, and it is the only one.
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator(`${PANE} .mail-mailbox[aria-current="true"]`)).toHaveCount(1)

  // A zero hit takes away the labels and nothing else, so the sentence describes what it replaced.
  await filter.fill('no such folder')
  await expect(page.getByTestId('mail-tail-empty')).toHaveText('No folder matches that.')
  expect(await rows.locator('.mail-mailbox-name').allInnerTexts()).toEqual(ROLES)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toHaveAttribute('aria-current', 'true')
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-filter')}`)
})

test('F14 C64: the collapse row is the last li, with a repeat above a long tail', async ({ page }) => {
  await openMail(page, port)
  await tailToggle(page, HARBOUR).click()
  const head = page.getByTestId('mail-tail-toggle-head')
  await expect(head).toHaveCount(1, { timeout: 90_000 })
  await expect(head).toHaveText('Show fewer folders')

  // The CANONICAL control is the last li, which is where a person scrolling to the end of 58 rows
  // arrives; the repeat sits above the tail, because that end is 1,860px below its start.
  const distance = await page.evaluate((accountId) => {
    const list = document.querySelector(`.mail-account[data-account-id="${accountId}"] ul.mail-mailboxes`)!
    const items = Array.from(list.children)
    const toggleAt = items.findIndex((li) => li.querySelector('.mail-tail-toggle'))
    const lastRow = items.filter((li) => li.querySelector('.mail-mailbox')).pop()!
    const repeat = list.querySelector('.mail-tail-head')!
    return {
      toggleAt,
      items: items.length,
      headAt: items.findIndex((li) => li.querySelector('.mail-tail-head')),
      last: items.indexOf(lastRow),
      apart: Math.round(
        lastRow.getBoundingClientRect().top - repeat.getBoundingClientRect().top,
      ),
    }
  }, HARBOUR)
  expect(distance.toggleAt, 'the collapse row is the last li').toBe(distance.items - 1)
  expect(distance.toggleAt, 'and it is after the last folder row').toBe(distance.last + 1)
  expect(distance.headAt, 'the repeat is above the tail').toBeLessThan(distance.last)
  expect(distance.apart, 'and the way back was this far up').toBeGreaterThan(1_000)

  // It closes the tail, exactly as the one at the end does.
  await head.click()
  await expect(page.getByTestId('mail-tail-filter')).toHaveCount(0)
  await expect(tailToggle(page, HARBOUR)).toHaveText('58 more folders, 6 with unread')
})

test('F13: a folder lifted out of the tail says it received mail, until it is opened', async ({ page }) => {
  // The arrival rides the real client path: a `sync-completed` frame at the socket, then the mailbox
  // read that carries the counts.
  let inject: ((frame: string) => void) | null = null
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => ws.send(message))
    inject = (frame) => ws.send(frame)
  })
  await openMail(page, port)
  const tail = tailToggle(page, HARBOUR)
  await expect(tail).toHaveText('58 more folders, 6 with unread', { timeout: 90_000 })
  const lifted = folderRow(page, HARBOUR, TAIL_FOLDER)
  await expect(lifted).toHaveCount(0)

  expect(inject, 'the socket route is installed').not.toBeNull()
  inject!(JSON.stringify({
    type: 'event',
    name: 'plugin:mail:sync-completed',
    data: { accountId: HARBOUR, mailboxId: TAIL_FOLDER, added: 3, updated: 0 },
    seq: 1,
  }))
  await expect(lifted).toHaveCount(1, { timeout: 20_000 })

  // The row that was LIFTED says so. Without this the collapse row's own hover text ("anything that
  // just received mail is above this line") cannot be checked on screen: the row arrived looking exactly
  // like its neighbours, and its badge is the folder's unread rather than what arrived.
  await expect(lifted).toHaveAttribute('data-arrived', 'true')
  await expect(lifted.getByTestId('mail-mailbox-new')).toHaveText('New')
  await expect(lifted.getByTestId('mail-mailbox-new')).toHaveAttribute('aria-label', 'new mail')
  // No other row claims it.
  await expect(page.locator(`${PANE} [data-arrived="true"]`)).toHaveCount(1)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-promotion-marked')}`)

  // Opening it is what ends the claim: the mark is about mail you have not looked at.
  await lifted.click()
  await expect(lifted).toHaveAttribute('aria-current', 'true')
  await expect(lifted.getByTestId('mail-mailbox-new')).toHaveCount(0)
  await expect(page.locator(`${PANE} [data-arrived="true"]`)).toHaveCount(0)
})

test('F17: in the narrow drill down a count stays beside its own row', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await page.setViewportSize({ width: 980, height: 800 })
  // One pane at a time below 1100px: the folder list is reached through the list's own control.
  await page.getByTestId('mail-show-mailboxes').click()
  await expect(page.locator(PANE)).toBeVisible()
  await twist(page, 'inbox').click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)

  const spread = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(
      '.mail-accounts-pane .mail-mailbox',
    )) as HTMLElement[]
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
  expect(spread.paneWidth, 'the pane really is the whole window here').toBeGreaterThan(600)
  expect(spread.widest, 'rows keep a sane measure').toBeLessThanOrEqual(420)
  expect(spread.counted, 'some rows really do carry a count').toBeGreaterThan(0)
  // It used to be about 660px: a folder name at x=280 paired with its badge at x=945.
  expect(spread.furthest, 'a count is not across the screen from its name').toBeLessThan(420)
  console.log(`F17 narrow pane: ${JSON.stringify(spread)}`)
  console.log(`shot: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-narrow-pane')}`)
})

test('F1 F6 F15: All Drafts, its badge and its header say the same number', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'drafts')).toBeVisible({ timeout: 90_000 })

  // STATE A: nothing written in this console, three drafts in the two providers' own Drafts folders.
  // The BADGE is the first section, which is empty here, so there is no badge: it printed the provider
  // folders' declared sizes, and those count drafts the cache cannot list (51 above the words "No
  // drafts." on the real install). The HEADER counts every row under it, which is three.
  const badge = smartRow(page, 'drafts').getByTestId('mail-smart-unread')
  await expect(badge).toHaveCount(0, { timeout: 60_000 })
  const harbourRow = page.locator(`[data-testid="mail-drafts-row"][data-account-id="${HARBOUR}"]`)
  const marinaRow = page.locator(`[data-testid="mail-drafts-row"][data-account-id="${MARINA}"]`)
  await expect(harbourRow.getByTestId('mail-drafts-count')).toHaveCount(0)
  await expect(marinaRow.getByTestId('mail-drafts-count')).toHaveCount(0)

  await smartRow(page, 'drafts').click()
  const count = page.locator('.mail-list-section .mail-list-section-count')
  await expect(page.locator('.mail-list-section-name')).toHaveText('All Drafts', { timeout: 60_000 })
  await expect(page.getByTestId('mail-row'), 'the view lists three').toHaveCount(3, { timeout: 60_000 })
  await expect(count, 'and the header counts what is under it').toHaveText('3')
  // `loaded`, not `total`: the second half of this view is a page of a folder that can hold drafts older
  // than this cache's window, and calling that a total claims a number Load older can never reach.
  await expect(page.getByTestId('mail-list-count-word')).toHaveText('loaded')

  // F6: the empty sentence has its own section label, so it cannot read as the empty state of a view
  // that is listing three drafts under labelled groups.
  const written = page.locator('[data-testid="mail-drafts-group"][data-group="written-here"]')
  await expect(written).toHaveCount(1)
  await expect(written).toContainText('Written here')
  const emptyLine = page.locator('.mail-rows p', { hasText: 'No drafts.' })
  await expect(emptyLine).toHaveCount(1)
  const order = await page.locator('.mail-rows').evaluate((rowsEl) => {
    const kids = Array.from(rowsEl.children)
    const label = kids.findIndex((kid) => kid.getAttribute('data-group') === 'written-here')
    const sentence = kids.findIndex((kid) => (kid.textContent ?? '').startsWith('No drafts.'))
    return { label, sentence }
  })
  expect(order.label, 'the sentence is under its own heading').toBeLessThan(order.sentence)
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-all-drafts')}`)

  // STATE B: one draft written here. Every number moves by one, and they still agree.
  await page.getByTestId('mail-compose-new').click()
  await expect(page.getByTestId('mail-composer')).toBeVisible()
  const identity = page.getByTestId('mail-compose-account')
  const writingAs = (await identity.textContent())?.trim() ?? ''
  await page.getByTestId('mail-compose-subject').fill('A draft for the count')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  // The badge is now a number a person can COUNT in the first section: one draft written here, one row.
  await expect(badge).toHaveText('1', { timeout: 60_000 })
  await smartRow(page, 'drafts').click()
  await expect(count, 'the header moved with it').toHaveText('4', { timeout: 60_000 })
  await expect(page.getByTestId('mail-draft-row'), 'and section one really lists one')
    .toHaveCount(1, { timeout: 60_000 })
  const mine = writingAs === 'Harbour mail' ? harbourRow : marinaRow
  const other = writingAs === 'Harbour mail' ? marinaRow : harbourRow
  await expect(mine.getByTestId('mail-drafts-count'), 'the account that owns it').toHaveText('1')
  await expect(other.getByTestId('mail-drafts-count'), 'and only that one').toHaveCount(0)
  console.log(`shot: ${await shoot(page.locator('.mail-list-pane'), SHOT_DIR, 'chromium-all-drafts-one')}`)
})

test('F5: compose from a merged list writes as the identity in use, and it can be changed', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })

  // Read a message belonging to the SECOND account, then press New message. It used to open as the
  // first sendable account whatever was on screen, with an inert grey chip naming it.
  const theirs = page.locator(`[data-testid="mail-row"][data-account-id="${MARINA}"]`).first()
  await expect(theirs).toBeVisible({ timeout: 60_000 })
  await theirs.click()
  await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('mail-compose-new').click()
  const identity = page.getByTestId('mail-compose-account')
  await expect(identity).toHaveText('Marina mail', { timeout: 30_000 })
  await expect(identity).toHaveAttribute('data-account-id', MARINA)
  // And the pane's own button said so before the click.
  await expect(page.getByTestId('mail-compose-new'))
    .toHaveAttribute('title', 'Write a new message as Marina mail')

  // The identity is a CONTROL: changing it does not mean leaving the merged view and picking a folder
  // in the other account.
  await page.getByTestId('mail-compose-subject').fill('Which identity signs this')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  await identity.click()
  const menu = page.getByTestId('mail-compose-identity-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[role="menuitem"], button')).toContainText(['Harbour mail'])
  console.log(`shot: ${await shoot(page.locator('.mail-compose-card-head'), SHOT_DIR, 'chromium-identity-menu')}`)
  await menu.getByText('Harbour mail', { exact: true }).click()
  await expect(identity).toHaveText('Harbour mail', { timeout: 30_000 })
  await expect(identity).toHaveAttribute('data-account-id', HARBOUR)
  // The text came with it, and the draft did not stay behind under the identity that was rejected.
  await expect(page.getByTestId('mail-compose-subject')).toHaveValue('Which identity signs this')
  await expect(page.getByTestId('mail-compose-save')).toHaveText('Saved', { timeout: 60_000 })
  const marinaCount = page.locator(`[data-testid="mail-drafts-row"][data-account-id="${MARINA}"]`)
    .getByTestId('mail-drafts-count')
  // The badge counts the drafts written HERE, so the account the draft moved off has none: its provider
  // Drafts folder is still listed under its own heading in the view, and no longer inside this number.
  await expect(marinaCount, 'no copy left in the identity that was rejected')
    .toHaveCount(0, { timeout: 60_000 })
})

test('F4: the account label on a row reads as an identity, not as a second clock', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-row-account').first()).toBeVisible({ timeout: 60_000 })

  const styles = await page.getByTestId('mail-row-account').first().evaluate((label) => {
    const time = label.parentElement!.querySelector('.mail-row-time') as HTMLElement
    const read = (el: Element) => {
      const style = getComputedStyle(el)
      return {
        background: style.backgroundColor,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        weight: style.fontWeight,
        size: style.fontSize,
        colour: style.color,
      }
    }
    return { label: read(label), time: read(time) }
  })
  // The whole finding was that these two were the SAME: 11px, weight 400, the same muted grey, side by
  // side, so a merged row printed a bold name, a grey name and a grey time with nothing saying which
  // name was the account. At least three of the five properties have to differ.
  const differing = (['background', 'border', 'radius', 'weight', 'colour'] as const)
    .filter((key) => styles.label[key] !== styles.time[key])
  expect(differing.length, `label ${JSON.stringify(styles.label)} vs time ${JSON.stringify(styles.time)}`)
    .toBeGreaterThanOrEqual(3)
  expect(styles.label.background, 'a chip has a fill of its own').not.toBe('rgba(0, 0, 0, 0)')
  console.log(`F4 styles: ${JSON.stringify(styles)}`)
  console.log(`shot: ${await shoot(page.locator('.mail-rows'), SHOT_DIR, 'chromium-row-account')}`)
})
