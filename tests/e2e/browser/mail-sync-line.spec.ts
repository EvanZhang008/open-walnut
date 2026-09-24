import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  HARBOUR,
  MARINA,
  MailFixtureServer,
  PANE,
  folderRow,
  openMail,
  shoot,
  smartRow,
  tailToggle,
} from './mail-review-helpers'

/**
 * The mail pane's last line: "Checked 2 min ago" (S1).
 *
 * Graded against the DENSE fixture (two accounts, 64 folders against 6, the same roles under different
 * mailbox ids) because every claim here is only interesting at that density: one account cannot show a
 * title that tells two accounts apart, and a six folder pane never scrolls, which is what the "no row
 * moves" rule is about.
 *
 * What is pinned:
 *   a. IT DATES THE FOLDER ON SCREEN, and the `title` adds the absolute local time plus one clause per
 *      account. A merged row takes the NEWEST of its members, which is the freshest thing that list can
 *      honestly claim.
 *   b. IT IS IN THE FLOW between the pane's answer strip and `+ Add account`, so changing its words
 *      moves no folder row and spends no scroll offset. Floated, this pane has already shipped a footer
 *      that covered a whole second account.
 *   c. A FOLDER NOBODY HAS FETCHED SAYS SO, and a folder off the inbox cadence reports its real age
 *      rather than borrowing the inbox's.
 *   d. AN ACCOUNT THAT NEEDS A PASSWORD ASKS FOR ONE instead of printing an age that stopped being true.
 *   e. THE CLOCK COSTS NOTHING: 90 seconds of page time moves the words and issues no request.
 *   f. THE LINE IS THE VERB TOO: clicking it checks every account once, and a second click inside that
 *      window is a no-op rather than a second poll.
 *
 * The WebKit twin is `mail-sync-line.webkit.spec.ts` (a `test.use` engine pin only applies at the top
 * level of its own file); the boot and the locators are shared through `mail-review-helpers`.
 */

const SHOT_DIR = '/tmp/mail-sync-line'
const LINE = 'mail-sync-line'
/** One of the 58 collapsed labels, used as the row that must not move. */
const TAIL_ROW = 'harbour/label/newsletters'

test.setTimeout(420_000)
test.use({ viewport: { width: 1280, height: 800 } })
// One fixture boot for the whole file. `default` rather than `serial`: the cases are independent, so a
// failure in one must not skip the rest, but the repo's `fullyParallel` would otherwise spread six cases
// across four workers and boot four dense fixtures to do it.
test.describe.configure({ mode: 'default' })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start()
  port = fixture.port
})

test.afterAll(async () => { await server.stop() })

/**
 * Drop the transport stubs before the page goes away.
 *
 * Several cases below reach their state by rewriting an answer at the transport, and the console keeps
 * polling: a handler can be inside `route.fetch()` when the test ends, the page closes under it, and the
 * throw fails a test whose every assertion has already passed.
 */
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

/** Rewrite every mailbox row of every account on the way to the browser. */
async function stubMailboxes(
  page: Page,
  edit: (row: { mailboxId: string, role: string, lastSyncAt?: number }) => void,
): Promise<void> {
  await page.route((url) => url.pathname.endsWith('/mailboxes'), async (route) => {
    const answer = await route.fetch()
    const body = await answer.json() as { mailboxes?: Array<{ mailboxId: string, role: string, lastSyncAt?: number }> }
    for (const row of body.mailboxes ?? []) edit(row)
    await route.fulfill({ response: answer, json: body })
  })
}

test('the pane foot dates the folder on screen and the title names both accounts', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openMail(page, port)
  await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 90_000 })

  await folderRow(page, HARBOUR, 'INBOX').click()
  const line = page.getByTestId(LINE)
  // ONE line, and it belongs to the pane rather than to the console.
  await expect(page.locator(`${PANE} [data-testid="${LINE}"]`)).toHaveCount(1)
  await expect(line).toHaveText(/^Checked (just now|\d+ min ago)$/, { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'checked')

  // The hover text carries what one line cannot: the absolute instant, then one clause per account, so a
  // person can tell which half of a two account console is the stale half.
  const title = await line.getAttribute('title')
  expect(title, `title was ${title}`).toMatch(
    /^Last checked .+ · Harbour mail: (just now|\d+ min ago|\d+ h ago|never checked) · Marina mail: (just now|\d+ min ago|\d+ h ago|never checked)$/,
  )

  // A merged row takes the NEWEST of its members. Read straight from the plugin, so the claim is graded
  // against the numbers the rows were drawn from rather than against another copy of the same guess.
  await smartRow(page, 'inbox').click()
  await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true')
  const newest = await page.evaluate(async (accounts) => {
    let best = 0
    for (const accountId of accounts) {
      const answer = await fetch(`/api/plugins/mail/mailboxes?account=${encodeURIComponent(accountId)}`)
      const body = await answer.json() as { mailboxes?: Array<{ role: string, lastSyncAt?: number }> }
      for (const row of body.mailboxes ?? []) {
        if (row.role === 'inbox' && typeof row.lastSyncAt === 'number') best = Math.max(best, row.lastSyncAt)
      }
    }
    return best
  }, [HARBOUR, MARINA])
  expect(newest, 'the fixture has polled both inboxes').toBeGreaterThan(0)
  await expect(line).toHaveAttribute('data-at', String(newest))
  await expect(line).toHaveAttribute('title', /Harbour mail: .+ · Marina mail: /)

  expect(pageErrors, 'the pane must not throw in the browser').toEqual([])
  console.log(`sync line: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-pane')}`)
})

test('the line is in the flow, and changing its words moves no folder row', async ({ page }) => {
  await openMail(page, port)
  await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
  // 58 rows open, so the scroller really has an offset to spend.
  await tailToggle(page, HARBOUR).click()
  const scroll = page.locator('.mail-accounts-scroll')
  await scroll.evaluate((el) => { el.scrollTop = 300 })
  const reference = folderRow(page, HARBOUR, TAIL_ROW)
  await expect(reference).toBeVisible()

  // IN THE FLOW: below the scroller, above `+ Add account`, and a sibling of both rather than an overlay
  // over either. Floated, three of this pane's earlier footers hid a whole second account.
  const shape = await page.locator(PANE).evaluate((pane) => {
    const children = Array.from(pane.children)
    const at = (selector: string) => children.findIndex((el) => el.matches(selector))
    const box = (selector: string) => {
      const el = pane.querySelector(selector) as HTMLElement
      const rect = el.getBoundingClientRect()
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
    }
    const line = pane.querySelector('[data-testid="mail-sync-line"]') as HTMLElement
    return {
      order: {
        scroll: at('.mail-accounts-scroll'),
        line: at('[data-testid="mail-sync-line"]'),
        add: at('[data-testid="mail-add-account"]'),
      },
      scrollBox: box('.mail-accounts-scroll'),
      lineBox: box('[data-testid="mail-sync-line"]'),
      addBox: box('[data-testid="mail-add-account"]'),
      position: getComputedStyle(line).position,
      lines: Math.round(
        line.clientHeight
        - Number.parseFloat(getComputedStyle(line).paddingTop)
        - Number.parseFloat(getComputedStyle(line).paddingBottom),
      ) / Number.parseFloat(getComputedStyle(line).lineHeight),
    }
  })
  expect(shape.order.scroll).toBeGreaterThanOrEqual(0)
  expect(shape.order.line, 'after the scroller').toBeGreaterThan(shape.order.scroll)
  expect(shape.order.add, 'before + Add account').toBeGreaterThan(shape.order.line)
  expect(shape.position, 'never an overlay').toBe('static')
  expect(shape.lineBox.top, 'below the scroller').toBeGreaterThanOrEqual(shape.scrollBox.bottom - 1)
  expect(shape.lineBox.bottom, 'above + Add account').toBeLessThanOrEqual(shape.addBox.top + 1)
  expect(Math.round(shape.lines), 'one line').toBe(1)
  expect(shape.lineBox.height, 'a footer, not a card').toBeLessThanOrEqual(26)

  // Now make it change its words, which is the moment a footer that grew would shove the list.
  const scrollBefore = await scroll.evaluate((el) => el.scrollTop)
  const rowBefore = Math.round((await reference.boundingBox())!.y)
  const heightBefore = shape.lineBox.height
  const line = page.getByTestId(LINE)
  await line.click()
  await expect(line).toHaveText('Checking…', { timeout: 30_000 })
  expect(await scroll.evaluate((el) => el.scrollTop), 'the scroll offset is untouched').toBe(scrollBefore)
  expect(Math.round((await reference.boundingBox())!.y), 'the row stays put').toBe(rowBefore)
  expect(Math.round((await line.boundingBox())!.height), 'and the line keeps its height')
    .toBe(heightBefore)

  // And back, once the refresh lands. The row is STILL where it was: the pane holds its shape while the
  // pointer is inside it, and this footer is not a row.
  await expect(line).toHaveText(/^Checked /, { timeout: 90_000 })
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(scrollBefore)
})

test('a folder nobody has fetched says so, and one off the cadence reports its real age', async ({ page }) => {
  // The two cases this fixture cannot produce on its own: the base stamps `last_sync_at` on every
  // successful poll, including an empty page, so an unfetched folder and a nine minute old one are
  // pinned at the transport. The arithmetic under test is the client's either way.
  const stale = Date.now() - 9 * 60_000
  await stubMailboxes(page, (row) => {
    if (row.role === 'inbox') delete row.lastSyncAt
    if (row.role === 'archive') row.lastSyncAt = stale
  })
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })

  await folderRow(page, HARBOUR, 'INBOX').click()
  const line = page.getByTestId(LINE)
  await expect(line).toHaveText('Not checked yet', { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'never')
  // Never `Checked ` with a trailing space, which is what an unguarded `timeAgo` of nothing renders.
  expect(await line.textContent()).toBe('Not checked yet')
  // A folder with rows is not an empty state: the line says nothing about what the list holds.
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-folder-unfetched')).toHaveCount(0)

  // Nine minutes is nine minutes. No rounding to "just now", no borrowing the inbox's clock.
  await folderRow(page, HARBOUR, 'Archive').click()
  await expect(line).toHaveText('Checked 9 min ago', { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'checked')
  console.log(`unfetched and stale: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-stale')}`)
})

test('an account that needs a password asks for one instead of printing an age', async ({ page }) => {
  // Stubbed at the transport, and it has to be: this provider reports `auth-required` and then polls
  // successfully, and one good poll is exactly what the base treats as proof the account syncs again.
  await page.route((url) => url.pathname.endsWith('/api/plugins/mail/accounts'), async (route) => {
    const answer = await route.fetch()
    const body = await answer.json() as {
      accounts: Array<{ accountId: string, state: string, health?: unknown }>
    }
    for (const account of body.accounts) {
      if (account.accountId !== MARINA) continue
      account.state = 'auth-required'
      account.health = { state: 'auth-required', checkedAt: Date.now(), detail: 'the stub parked it' }
    }
    await route.fulfill({ response: answer, json: body })
  })
  await openMail(page, port)
  await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 90_000 })

  await folderRow(page, MARINA, 'inbox').click()
  const line = page.getByTestId(LINE)
  await expect(line).toHaveText('Not syncing · sign in again', { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'auth-required')
  // The age is not lost, it is just not the headline.
  await expect(line).toHaveAttribute('title', /Marina mail: .+ \(not syncing\)/)

  // A merged list where only ONE member is locked out keeps its age and marks the degradation beside it:
  // the other half is still polling, so claiming the whole thing stopped would be the opposite lie.
  await smartRow(page, 'inbox').click()
  await expect(line).toHaveText(/^Checked .+ · not syncing$/, { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-state', 'degraded')
  console.log(`locked out: ${await shoot(page.locator(PANE), SHOT_DIR, 'chromium-auth-required')}`)
})

test('90 seconds of page time moves the words and asks the server for nothing', async ({ page }) => {
  // The clock is installed BEFORE the first navigation, which is the only point at which the page's
  // timers can be faked: the pane's 30 s interval is created when it mounts.
  await page.clock.install({ time: new Date() })
  // Pinned to the driver's clock at response time so the words are the ones this case is about rather
  // than however long the dense console took to boot.
  await stubMailboxes(page, (row) => { row.lastSyncAt = Date.now() })
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  await folderRow(page, HARBOUR, 'INBOX').click()

  const line = page.getByTestId(LINE)
  await expect(line).toHaveAttribute('data-at', /^\d+$/, { timeout: 60_000 })
  const at = Number(await line.getAttribute('data-at'))
  // Freeze one second after that check, so everything below is arithmetic and not a race with the boot.
  await page.clock.pauseAt(new Date(at + 1_000))
  await expect(line).toHaveText('Checked just now', { timeout: 30_000 })

  const calls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/mail/')) calls.push(request.url())
  })
  await page.clock.fastForward(90_000)
  await expect(line).toHaveText('Checked 1 min ago', { timeout: 30_000 })
  expect(calls, 'a relative time is arithmetic, not a request').toEqual([])

  // An hour later it reads in hours, still for free.
  await page.clock.fastForward(60 * 60_000)
  await expect(line).toHaveText('Checked 1 h ago', { timeout: 30_000 })
  expect(calls, 'still nothing on the wire').toEqual([])
})

test('clicking the line checks every account once, and a second click does not', async ({ page }) => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const refreshes: string[] = []
  await page.route((url) => url.pathname.endsWith('/api/plugins/mail/refresh'), async (route) => {
    refreshes.push(route.request().method())
    await gate
    await route.continue()
  })
  await openMail(page, port)
  await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
  await folderRow(page, HARBOUR, 'INBOX').click()
  const line = page.getByTestId(LINE)
  await expect(line).toHaveAttribute('data-state', 'checked', { timeout: 60_000 })
  const before = refreshes.length

  await line.click()
  // The verb is visible: a control that looked idle while its work was on the wire would be clicked
  // again, which is exactly what the next two lines do.
  await expect(line).toHaveText('Checking…', { timeout: 30_000 })
  await expect(line).toHaveAttribute('data-state', 'fetching')
  await line.click()
  await line.click()
  await page.waitForTimeout(750)
  expect(refreshes.length - before, 'one refresh per gesture, not one per click').toBe(1)

  expect(release, 'the refresh is gated').not.toBeNull()
  release!()
  await expect(line).toHaveText(/^Checked /, { timeout: 90_000 })
  // And it is clickable again once the window closes.
  await line.click()
  await expect(line).toHaveText('Checking…', { timeout: 30_000 })
  // Polled: a Refresh polls the folder on screen first, so its `/refresh` goes out a moment after the
  // line already says `Checking…`.
  await expect.poll(() => refreshes.length - before, { timeout: 30_000 }).toBe(2)
})
