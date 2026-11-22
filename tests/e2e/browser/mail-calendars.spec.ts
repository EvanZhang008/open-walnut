import { expect, test, type Page } from '@playwright/test'
import { appsHome, openAppsPage, useAppsFixture } from './apps-page-fixture'

/**
 * A mail account set up once brings its calendar too (the `mail_calendars` experiment).
 * The user: "is it possible for the imap etc, we not only cover mail also cover cleander?"
 *
 * Against its own server (mail-calendar-server.ts): two IMAP accounts saved as the setup form
 * saves them, and a CalDAV server holding one event today. Real clicks, nothing routed:
 *
 *   1. Apps > Calendar's page lists the mail accounts; each without a calendar here offers
 *      "Add its calendar".
 *   2. Adding the account whose server has CalDAV finds its calendar with the saved password: the
 *      row says it comes from its mail server, its calendar shows as an account group, and its
 *      event is in the Agenda side bar.
 *   3. A Gmail account says plainly that it needs a Google sign-in, with no Add that cannot work.
 *   4. "Remove its calendar" takes the event out of the Agenda again, and the row offers Add.
 *   5. An account whose calendar server sends Walnut to another host says where, and its
 *      password goes there only after "Use <host>"; then the calendar is read.
 */

const fixture = useAppsFixture({ script: 'tests/e2e/browser/mail-calendar-server.ts', readyMark: 'MAIL_CALENDAR_READY', portEnv: 'PW_MAIL_CALENDAR_PORT' })

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })

const SHOTS = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : '/tmp/mail-calendars'

async function openCalendarPage(page: Page): Promise<void> {
  await appsHome(page, fixture.port)
  await openAppsPage(page)
  await page.getByTestId('apps-builtin-calendar-details').click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', 'calendar', { timeout: 30_000 })
  await expect(page.getByTestId('calendar-mail-accounts')).toBeVisible({ timeout: 30_000 })
}

async function agendaShows(page: Page, title: string, shown: boolean): Promise<void> {
  const toggle = page.getByTestId('sidebar-toggle-calendar')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  const panel = page.getByTestId('cal-side-panel')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  if (shown) await expect(panel.getByText(title)).toBeVisible({ timeout: 30_000 })
  else await expect(panel.getByText(title)).toHaveCount(0, { timeout: 30_000 })
}

test('Add its calendar brings the mail account calendar into the accounts and the Agenda', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { account } = fixture.info as unknown as { account: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${account}`)
  await expect(row).toContainText('Pat (pat@example.com)')
  await expect(row).toContainText('Add its calendar to read it straight from its mail server')
  await page.screenshot({ path: `${SHOTS}/mail-calendars-1-before.png` })
  await page.getByTestId(`calendar-mail-add-${account}`).click()
  await expect(row).toHaveAttribute('data-match', 'server', { timeout: 60_000 })
  await expect(row).toContainText('Calendar here')
  await expect(row).toContainText('Its calendar comes from its mail server: one calendar')
  await expect(page.getByTestId(`calendar-mail-remove-${account}`)).toBeVisible()
  // Its calendar is an account group of its own, under the address.
  const group = page.getByTestId('calendar-account-group').filter({ hasText: 'pat@example.com' })
  await expect(group).toContainText('Mail calendar')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-2-added.png` })
  await agendaShows(page, 'Dentist from mail', true)
  await page.screenshot({ path: `${SHOTS}/mail-calendars-3-agenda.png` })
  expect(errors).toEqual([])
})

test('a Gmail account says it needs a Google sign-in, and offers no add that cannot work', async ({ page }) => {
  const { gmailAccount } = fixture.info as unknown as { gmailAccount: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${gmailAccount}`)
  await expect(row).toContainText('Gmail calendars need a Google sign-in', { timeout: 30_000 })
  await expect(row).toHaveAttribute('data-state', 'warning')
  await expect(page.getByTestId(`calendar-mail-add-${gmailAccount}`)).toHaveCount(0)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-4-gmail.png` })
})

test('Remove its calendar takes its events out of the Agenda again', async ({ page }) => {
  const { account } = fixture.info as unknown as { account: string }
  await openCalendarPage(page)
  await agendaShows(page, 'Dentist from mail', true)
  await page.getByTestId(`calendar-mail-remove-${account}`).click()
  await expect(page.getByTestId(`calendar-mail-add-${account}`)).toBeVisible({ timeout: 30_000 })
  await agendaShows(page, 'Dentist from mail', false)
  await page.screenshot({ path: `${SHOTS}/mail-calendars-5-removed.png` })
})

test('a calendar server on another host is used only once the person picks it', async ({ page }) => {
  const { leeAccount, leeServerHost } = fixture.info as unknown as { leeAccount: string; leeServerHost: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${leeAccount}`)
  await page.getByTestId(`calendar-mail-add-${leeAccount}`).click()
  await expect(row).toContainText(`The calendar server is at ${leeServerHost}`, { timeout: 60_000 })
  await expect(row).toHaveAttribute('data-state', 'warning')
  const use = page.getByTestId(`calendar-mail-use-server-${leeAccount}`)
  await expect(use).toHaveText(`Use ${leeServerHost}`)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-6-found-server.png` })
  await use.click()
  await expect(row).toHaveAttribute('data-match', 'server', { timeout: 60_000 })
  await expect(page.getByTestId(`calendar-mail-remove-${leeAccount}`)).toBeVisible()
  await expect(page.getByTestId('calendar-account-group').filter({ hasText: 'lee@example.org' })).toContainText('Lee calendar')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-7-server-used.png` })
})
