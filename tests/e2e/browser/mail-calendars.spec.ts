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
 *   3. A Gmail account signs in with Google (the Google client Drive backups use): the provider's
 *      page opens, sends the browser back to Walnut, and its event is in the Agenda; Remove takes
 *      it out and the row offers the sign-in again.
 *   3b. A Workspace account's sign-in picks another Google account: the row asks "Use <that
 *      account>'s calendar for this account?" and keeps nothing until "Use this calendar".
 *   4. "Remove its calendar" takes the event out of the Agenda again, and the row offers Add.
 *   5. An account whose calendar server sends Walnut to another host says where, and its
 *      password goes there only after "Use <host>"; then the calendar is read.
 *   6. An Outlook account has no Microsoft client yet: its row walks through making one (a wrong
 *      id is refused by Microsoft, a right one kept), then signs in with the address the browser
 *      ended on pasted in (the browser on another device), and its event is in the Agenda.
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

test('a Gmail account signs in with Google, its event shows in the Agenda, and Remove takes it out', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { gmailAccount, workspaceAccount } = fixture.info as unknown as { gmailAccount: string; workspaceAccount: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${gmailAccount}`)
  await expect(row).toContainText('Gmail calendars need a Google sign-in', { timeout: 30_000 })
  await expect(row).toContainText('with the Google client your Drive backups use')
  await expect(page.getByTestId(`calendar-mail-add-${gmailAccount}`)).toHaveCount(0)
  // A Google Workspace account on its own domain is known by its mail server: it signs in too.
  await expect(page.getByTestId(`calendar-mail-account-${workspaceAccount}`)).toContainText('Gmail calendars need a Google sign-in')
  await expect(page.getByTestId(`calendar-mail-sign-in-${workspaceAccount}`)).toBeVisible()
  await expect(page.getByTestId(`calendar-mail-add-${workspaceAccount}`)).toHaveCount(0)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-4-gmail.png` })
  // The Google page opens in a new tab and sends the browser straight back to Walnut on this computer.
  const googlePage = context.waitForEvent('page', { timeout: 30_000 })
  await page.getByTestId(`calendar-mail-sign-in-${gmailAccount}`).click()
  const tab = await googlePage
  await expect.poll(async () => (tab.isClosed() ? 'closed' : await tab.content()), { timeout: 30_000 }).toMatch(/closed|Walnut is connected to your Google calendar/)
  await expect(row).toHaveAttribute('data-match', 'server', { timeout: 60_000 })
  await expect(row).toContainText('Calendar here')
  await expect(row).toContainText('Its calendar comes from Google: one calendar')
  await expect(page.getByTestId('calendar-account-group').filter({ hasText: 'sam@gmail.com' })).toContainText('Sam (Google)')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-4b-gmail-signed-in.png` })
  await agendaShows(page, 'Dinner from Google', true)
  await page.screenshot({ path: `${SHOTS}/mail-calendars-4c-gmail-agenda.png` })
  await page.getByTestId(`calendar-mail-remove-${gmailAccount}`).click()
  await expect(page.getByTestId(`calendar-mail-sign-in-${gmailAccount}`)).toBeVisible({ timeout: 30_000 })
  await expect(row).toHaveAttribute('data-match', 'sign-in')
  await agendaShows(page, 'Dinner from Google', false)
  expect(errors).toEqual([])
})

test('a sign-in as another Google account asks first, and "Use this calendar" reads that account\'s calendar', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { workspaceAccount, workspacePicked } = fixture.info as unknown as { workspaceAccount: string; workspacePicked: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${workspaceAccount}`)
  await expect(row).toContainText('Gmail calendars need a Google sign-in', { timeout: 30_000 })
  // On the Google page the person picks another account than kim@acme.example.
  const googlePage = context.waitForEvent('page', { timeout: 30_000 })
  await page.getByTestId(`calendar-mail-sign-in-${workspaceAccount}`).click()
  const tab = await googlePage
  await expect.poll(async () => (tab.isClosed() ? 'closed' : await tab.content()), { timeout: 30_000 }).toMatch(/closed|Walnut is connected to your Google calendar/)
  await expect(row).toHaveAttribute('data-match', 'sign-in-held', { timeout: 30_000 })
  await expect(row).toContainText(`Signed in as ${workspacePicked}. Use ${workspacePicked}'s calendar for this account?`)
  await expect(page.getByTestId(`calendar-mail-sign-in-discard-${workspaceAccount}`)).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-5-held.png` })
  await page.getByTestId(`calendar-mail-sign-in-use-${workspaceAccount}`).click()
  await expect(row).toHaveAttribute('data-match', 'server', { timeout: 60_000 })
  await expect(row).toContainText('Its calendar comes from Google: one calendar')
  // Drive backups' client: Remove leaves the grant, and the row says so.
  await expect(row).toContainText("Walnut stays in your Google account's app list until you remove it there")
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-5b-held-used.png` })
  await agendaShows(page, 'Dinner from Google', true)
  await page.getByTestId(`calendar-mail-remove-${workspaceAccount}`).click()
  await expect(page.getByTestId(`calendar-mail-sign-in-${workspaceAccount}`)).toBeVisible({ timeout: 30_000 })
  await agendaShows(page, 'Dinner from Google', false)
  expect(errors).toEqual([])
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

test('an Outlook account walks through its Microsoft client, then signs in with the pasted address', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { outlookAccount, microsoftClientId } = fixture.info as unknown as { outlookAccount: string; microsoftClientId: string }
  await openCalendarPage(page)
  const row = page.getByTestId(`calendar-mail-account-${outlookAccount}`)
  await expect(row).toContainText('First set up a Microsoft client below', { timeout: 30_000 })
  const signIn = page.getByTestId(`calendar-mail-sign-in-${outlookAccount}`)
  await expect(signIn).toBeDisabled()
  await expect(page.getByTestId('calendar-sign-in-steps-microsoft')).toBeVisible()
  await expect(page.getByTestId('calendar-sign-in-steps-microsoft')).toContainText('http://127.0.0.1')
  await page.getByTestId('calendar-sign-in-steps-microsoft').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-8-outlook-steps.png` })
  // A client Microsoft does not know is refused and not kept.
  await page.getByTestId(`calendar-client-id-${outlookAccount}`).fill('not-a-registered-client')
  await page.getByTestId(`calendar-client-save-${outlookAccount}`).click()
  await expect(page.getByText('Microsoft does not accept this client')).toBeVisible({ timeout: 30_000 })
  await expect(signIn).toBeDisabled()
  await page.getByTestId(`calendar-client-id-${outlookAccount}`).fill(microsoftClientId)
  await page.getByTestId(`calendar-client-save-${outlookAccount}`).click()
  await expect(row).toContainText('Sign in with Microsoft to read it here', { timeout: 30_000 })
  await expect(signIn).toBeEnabled()
  // The browser is "on another device": read where Microsoft's Allow would send it, close that tab, paste it here.
  const msPage = context.waitForEvent('page', { timeout: 30_000 })
  await signIn.click()
  const tab = await msPage
  await expect(tab.locator('#allow')).toBeVisible({ timeout: 30_000 })
  const landing = await tab.locator('#allow').getAttribute('href')
  await tab.close()
  await expect(row).toContainText('Finish signing in on the Microsoft page that opened')
  await page.getByTestId(`calendar-mail-sign-in-paste-help-${outlookAccount}`).click()
  await page.getByTestId(`calendar-mail-sign-in-paste-${outlookAccount}`).fill(landing!)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-9-outlook-paste.png` })
  await page.getByTestId(`calendar-mail-sign-in-finish-${outlookAccount}`).click()
  await expect(row).toHaveAttribute('data-match', 'server', { timeout: 60_000 })
  await expect(row).toContainText('Its calendar comes from Microsoft: one calendar')
  await expect(page.getByTestId('calendar-account-group').filter({ hasText: 'sam@outlook.com' })).toContainText('Calendar')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/mail-calendars-10-outlook-signed-in.png` })
  await agendaShows(page, 'Review from Outlook', true)
  await page.screenshot({ path: `${SHOTS}/mail-calendars-11-outlook-agenda.png` })
  await page.getByTestId(`calendar-mail-remove-${outlookAccount}`).click()
  await expect(row).toHaveAttribute('data-match', 'sign-in', { timeout: 30_000 })
  await agendaShows(page, 'Review from Outlook', false)
  expect(errors).toEqual([])
})
