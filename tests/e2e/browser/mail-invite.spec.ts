/**
 * Answering a meeting invite from the Mail reader, driven as a person drives it.
 *
 * Engine-neutral, so the same file runs in Chromium and (with `PW_WEBKIT=1 --project=webkit`) in
 * WebKit, the engine the Mac app is. The fixture (`PW_MAIL_INVITE=1`, invite-set.mjs) puts five
 * invites on the writer account and records every RSVP it is asked for, so the assertions are the
 * answers that went out, not only the words on screen:
 *
 *   1. AN ORDINARY INVITE: when, where, what you answered, three buttons. One click sends ONE answer,
 *      the clicked button says it is working on the first frame, and a second click while it is in
 *      flight sends nothing. Changing your mind sends a second answer. Reopening reads the calendar
 *      again rather than trusting the card.
 *   2. A SERIES is shown and not answerable here, with the reason; a CANCELLATION says so; neither has
 *      a button.
 *   3. A SLOW CALENDAR READ does not block the click: the buttons are live while it says "Checking".
 *   4. A FAILED ANSWER says so in the provider's words and re-reads the calendar, which still holds
 *      the old answer.
 *   5. An ordinary mail has no card, and the card never overflows the reader at 1280px or at 900px.
 *   6. AN ANSWER THAT OUTLIVES THE ROUTE'S 15s BUDGET (a 202): the button keeps saying it is working,
 *      nothing can be clicked twice, and the card follows it to the calendar's answer on its own.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, folderRow, openMail, shoot } from './mail-review-helpers'

const WRITER = 'fixture:ctx-writer@example.invalid'
const OPEN = 'INBOX:9:1'
const SERIES = 'INBOX:9:2'
const CANCELED = 'INBOX:9:3'
const SLOW = 'INBOX:9:4'
const FAIL = 'INBOX:9:5'
const SLOW_ANSWER = 'INBOX:9:6'
/** A base fixture message in the same inbox, from a person, with no invite. */
const ORDINARY_SUBJECT = 'Lunch tomorrow'

test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0
let home = ''
let shotDir = ''

test.beforeAll(async ({ browserName }) => {
  test.setTimeout(300_000)
  shotDir = `/tmp/invite-rsvp/shots/${browserName}`
  await fs.mkdir(shotDir, { recursive: true })
  const fixture = await server.start({ PW_MAIL_INVITE: '1', PW_MAIL_DENSE: '', PW_MAIL_INVITE_SLOW_MS: '3000' })
  port = fixture.port
  home = fixture.home
})

test.afterAll(async () => { await server.stop() })

const errors: string[] = []
test.beforeEach(({ page }) => {
  errors.length = 0
  page.on('pageerror', (error) => { errors.push(error.message); console.log(`[pageerror] ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`)
  })
})

test.afterEach(() => { expect(errors, 'the page threw').toEqual([]) })

interface InviteCall { method: string; messageId: string; response?: string }

async function inviteCalls(): Promise<InviteCall[]> {
  try { return JSON.parse(await fs.readFile(`${home}/mail-fixture-invite-calls.json`, 'utf8')) as InviteCall[] }
  catch { return [] }
}

async function answersFor(messageId: string): Promise<string[]> {
  return (await inviteCalls()).filter((one) => one.method === 'respond' && one.messageId === messageId).map((one) => one.response!)
}

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

function card(page: Page): Locator {
  return page.getByTestId('mail-invite')
}

async function openInbox(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(folderRow(page, WRITER, 'INBOX')).toHaveCount(1, { timeout: 90_000 })
  await folderRow(page, WRITER, 'INBOX').click()
  // The Inbox opens Grouped, which lists unread mail only, and these invites were read on arrival:
  // switch to All mail the way a person does, through the list's own view menu.
  const view = page.getByTestId('mail-view-menu').first()
  await expect(view).toBeVisible({ timeout: 90_000 })
  if ((await view.getAttribute('data-grouped')) === 'true') {
    await view.click()
    const menu = page.getByTestId('mail-view-menu-list')
    await expect(menu).toBeVisible()
    await menu.locator('[role^="menuitem"]').filter({ hasText: 'All mail' }).first().click()
  }
  await expect(row(page, OPEN)).toBeVisible({ timeout: 90_000 })
}

async function openMessage(page: Page, messageId: string): Promise<void> {
  await row(page, messageId).click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', messageId, { timeout: 60_000 })
}

test('an ordinary invite: one click sends one answer, a change of mind sends another, reopening re-reads', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, OPEN)

  await expect(card(page)).toBeVisible()
  await expect(page.getByTestId('mail-invite-when')).toHaveText(/, 3:00\sPM to 4:00\sPM$/)
  await expect(page.getByTestId('mail-invite-where')).toHaveText('Room 5 | Meeting URL: https://meet.example.invalid/j/41')
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You have not answered yet')
  for (const which of ['accept', 'tentative', 'decline']) {
    await expect(page.getByTestId(`mail-invite-${which}`)).toBeEnabled()
    await expect(page.getByTestId(`mail-invite-${which}`)).toHaveAttribute('aria-pressed', 'false')
  }
  console.log(`shot: ${await shoot(card(page), shotDir, 'open-unanswered')}`)

  // The click answers on the first frame: the button says it is working and every button locks.
  const accept = page.getByTestId('mail-invite-accept')
  await accept.click()
  await expect(accept).toHaveText('Accepting…')
  await expect(page.getByTestId('mail-invite-decline')).toBeDisabled()
  // A second click while the first is in flight sends nothing (the button is disabled; force the click).
  await accept.click({ force: true }).catch(() => undefined)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You accepted', { timeout: 15_000 })
  await expect(accept).toHaveAttribute('aria-pressed', 'true')
  // The mouse is still on Accept after the click: hover must not hide that it is the answer.
  await accept.hover()
  const border = (id: string) => page.getByTestId(id).evaluate((element) => getComputedStyle(element).borderColor)
  const accent = await card(page).evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    element.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  expect(await border('mail-invite-accept')).toBe(accent)
  expect(await border('mail-invite-tentative')).not.toBe(accent)
  // The status line confirms it with a tick; no second sentence repeats it.
  await expect(page.getByTestId('mail-invite-status')).toHaveAttribute('data-confirmed', 'true')
  await expect(page.getByTestId('mail-invite-note')).toHaveCount(0)
  expect(await answersFor(OPEN)).toEqual(['accept'])
  console.log(`shot: ${await shoot(card(page), shotDir, 'open-accepted')}`)

  // A change of mind is a second, separate answer.
  await page.getByTestId('mail-invite-decline').click()
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You declined', { timeout: 15_000 })
  expect(await answersFor(OPEN)).toEqual(['accept', 'decline'])

  // Away and back: the card is the calendar's, read again, not a memory of this tab.
  const readsBefore = (await inviteCalls()).filter((one) => one.method === 'details' && one.messageId === OPEN).length
  await openMessage(page, SERIES)
  await openMessage(page, OPEN)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You declined')
  await expect(page.getByTestId('mail-invite-decline')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('mail-invite-note')).toHaveCount(0)
  // A fresh card trusts the calendar; the tick belongs to an answer this card itself sent.
  await expect(page.getByTestId('mail-invite-status')).not.toHaveAttribute('data-confirmed', 'true')
  const readsAfter = (await inviteCalls()).filter((one) => one.method === 'details' && one.messageId === OPEN).length
  // At least one fresh read (the dev build's StrictMode mounts the card twice, so it may be two).
  expect(readsAfter).toBeGreaterThan(readsBefore)
})

test('a series is shown and not answered here; a cancellation says so; neither offers a button', async ({ page }) => {
  await openInbox(page)

  await openMessage(page, SERIES)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('Repeats · You have not answered yet')
  await expect(page.getByTestId('mail-invite-reason')).toHaveText('This invite is for a recurring series. Answer it in Outlook.')
  await expect(card(page).getByRole('button')).toHaveCount(0)
  console.log(`shot: ${await shoot(card(page), shotDir, 'series')}`)

  await openMessage(page, CANCELED)
  await expect(card(page)).toHaveAttribute('data-state', 'canceled')
  await expect(page.getByTestId('mail-invite-status')).toHaveText('This meeting was canceled.')
  await expect(card(page).getByRole('button')).toHaveCount(0)
  console.log(`shot: ${await shoot(card(page), shotDir, 'canceled')}`)

  expect(await answersFor(SERIES)).toEqual([])
  expect(await answersFor(CANCELED)).toEqual([])
})

test('a slow calendar read does not hold the click back', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, SLOW)
  // The read takes 3s in this fixture. The buttons are live while it is still checking.
  await expect(page.getByTestId('mail-invite-when')).toHaveText('Checking your calendar…')
  await expect(page.getByTestId('mail-invite-accept')).toBeEnabled()
  console.log(`shot: ${await shoot(card(page), shotDir, 'slow-checking')}`)
  await page.getByTestId('mail-invite-accept').click()
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You accepted', { timeout: 20_000 })
  await expect(page.getByTestId('mail-invite-when')).toHaveText(/, 1:00\sPM to 2:00\sPM$/, { timeout: 20_000 })
  expect(await answersFor(SLOW)).toEqual(['accept'])
})

test('a failed answer says so in the provider words and the card goes back to what the calendar holds', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, FAIL)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You said maybe')
  await page.getByTestId('mail-invite-accept').click()
  await expect(page.getByTestId('mail-invite-note')).toHaveText(
    'Your answer was not confirmed: Outlook did not answer in time.', { timeout: 20_000 },
  )
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You said maybe')
  await expect(page.getByTestId('mail-invite-status')).not.toHaveAttribute('data-confirmed', 'true')
  await expect(page.getByTestId('mail-invite-tentative')).toHaveAttribute('aria-pressed', 'true')
  // And the buttons are usable again: the failure is not a dead end.
  await expect(page.getByTestId('mail-invite-accept')).toBeEnabled()
  expect(await answersFor(FAIL)).toEqual(['accept'])
  console.log(`shot: ${await shoot(card(page), shotDir, 'failed')}`)
})

test('leaving mid-answer is safe, an ordinary mail has no card, and the card fits the reader at two widths', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, OPEN)
  await page.getByTestId('mail-invite-tentative').click()
  // Gone before the answer settles (the fixture takes 600ms): no error, and the answer still lands.
  const ordinary = page.locator(`.mail-row[data-account-id="${WRITER}"]`).filter({ hasText: ORDINARY_SUBJECT }).first()
  await ordinary.click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => answersFor(OPEN), { timeout: 10_000 }).toContain('tentative')
  // Back while it may still be sending: the card shows the answer in flight (never an invitation to
  // click again), then the calendar's answer once it settles.
  await openMessage(page, OPEN)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You said maybe', { timeout: 15_000 })
  await expect(page.getByTestId('mail-invite-tentative')).toHaveAttribute('aria-pressed', 'true')
  expect((await answersFor(OPEN)).filter((one) => one === 'tentative')).toHaveLength(1)

  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(card(page)).toBeVisible()
    const fits = await card(page).evaluate((element) => {
      const box = element.getBoundingClientRect()
      const column = element.closest('.mail-reader-head')!.getBoundingClientRect()
      const buttons = [...element.querySelectorAll('button')].map((one) => one.getBoundingClientRect())
      return {
        insideColumn: box.left >= column.left - 0.5 && box.right <= column.right + 0.5,
        noOverflow: element.scrollWidth <= element.clientWidth + 1,
        buttonsInside: buttons.every((one) => one.left >= box.left && one.right <= box.right + 0.5),
        buttons: buttons.length,
      }
    })
    expect(fits, `at ${width}px`).toEqual({ insideColumn: true, noOverflow: true, buttonsInside: true, buttons: 3 })
    console.log(`shot: ${await shoot(page.locator('.mail-reader-head'), shotDir, `fit-${width}`)}`)
  }
})

test('an answer past the budget: the card keeps working, sends once, and lands on the calendar answer', async ({ page }) => {
  await openInbox(page)
  await openMessage(page, SLOW_ANSWER)
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You have not answered yet')
  const accept = page.getByTestId('mail-invite-accept')
  // The fixture takes 18s, the route answers 202 at 15s. Past the 202 the card still says it is
  // working and still refuses a second answer.
  const sawPending = page.waitForResponse((response) =>
    response.url().endsWith('/invite') && response.request().method() === 'POST', { timeout: 30_000 })
  await accept.click()
  await expect(accept).toHaveText('Accepting…')
  expect((await sawPending).status()).toBe(202)
  await expect(accept).toHaveText('Accepting…')
  await expect(page.getByTestId('mail-invite-decline')).toBeDisabled()
  await expect(page.getByTestId('mail-invite-status')).toHaveText('You accepted', { timeout: 30_000 })
  await expect(page.getByTestId('mail-invite-status')).toHaveAttribute('data-confirmed', 'true')
  await expect(page.getByTestId('mail-invite-note')).toHaveCount(0)
  await expect(page.getByTestId('mail-invite-decline')).toBeEnabled()
  expect(await answersFor(SLOW_ANSWER)).toEqual(['accept'])
  console.log(`shot: ${await shoot(card(page), shotDir, 'slow-answer-landed')}`)
})
