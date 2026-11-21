import { expect, test, type Page } from '@playwright/test'
import { appsHome, openAppsPage, serverHoldsAppPreferences, useAppsFixture } from './apps-page-fixture'
import { backToApps, openBuiltinDetail } from './apps-store-helpers'

/**
 * One card per app, each with its parts (Evan, 2026-11-21: "they are just one plugin, the
 * agentda is jsut a side abr of calender", "one app can have maultiple part each part can add
 * to the side bar or not", "why the cal app can not have a open there"). What it pins, through
 * real clicks:
 *
 *   1. A search for "cal" finds ONE Calendar card: no plugin card of its own, no Agenda card.
 *   2. Calendar's card lists its parts (the page and the Agenda side bar), each with its own
 *      switch, and has Open. The Agenda switch takes the rail's Agenda toggle away and back.
 *   3. Notes holds the Scratchpad side bar the same way.
 *   4. A person who took Agenda off the rail before keeps that choice: the stored key is the
 *      rail's own (`rail:home-agenda`), read the same by the new card.
 *   5. The card opens the plugin's page, which holds the parts, the plugin's switch, Open and
 *      the calendar accounts, with a line for each mail account saying whether its calendar
 *      comes in through the Mac.
 *   6. A plugin App's card (walnut-time) has its sidebar switch on the card as well.
 */

const fixture = useAppsFixture()

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })

const PREFS = 'open-walnut-app-preferences-v1'

async function goApps(page: Page): Promise<void> {
  await appsHome(page, fixture.port)
  await openAppsPage(page)
}

test('a search for "cal" finds one Calendar card with its two parts, and Open opens it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await goApps(page)
  await page.getByTestId('apps-search').fill('cal')
  const calendar = page.getByTestId('apps-builtin-calendar')
  await expect(calendar).toBeVisible()
  await expect(page.locator('[data-testid="plugin-card-calendar"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="apps-builtin-home-agenda"]')).toHaveCount(0)
  await expect(calendar.locator('.apps-card-part')).toHaveCount(2)
  await expect(page.getByTestId('apps-builtin-calendar-part-calendar')).toContainText('Calendar')
  await expect(page.getByTestId('apps-builtin-calendar-part-home-agenda')).toContainText('Agenda')
  await expect(page.getByTestId('apps-builtin-card-toggle-calendar')).toHaveAttribute('aria-label', 'Show Calendar on the sidebar')
  await expect(page.getByTestId('apps-builtin-card-toggle-home-agenda')).toHaveAttribute('aria-label', 'Show Agenda on the sidebar')
  // "agenda" finds the same card by its part.
  await page.getByTestId('apps-search').fill('agenda')
  await expect(page.getByTestId('apps-builtin-grid').locator('.apps-card')).toHaveCount(1)
  await expect(calendar).toBeVisible()
  await page.getByTestId('apps-search').fill('')
  // Its plugin's category chip still finds it, alone among the built-ins.
  await page.getByTestId('apps-chip-time').click()
  await expect(page.getByTestId('apps-builtin-grid').locator('.apps-card')).toHaveCount(1)
  await expect(calendar).toBeVisible()
  await page.getByTestId('apps-chip-all').click()
  await page.getByTestId('apps-builtin-card-open-calendar').click()
  await expect(page).toHaveURL(/\/calendar(?:[?#].*)?$/)
  await expect(page.getByTestId('apps-page')).toHaveCount(0)
  expect(errors).toEqual([])
})

test("Agenda and Scratchpad are parts: each switch takes the rail's toggle away and back, twice", async ({ page }) => {
  await goApps(page)
  for (const [card, part, rail] of [['calendar', 'home-agenda', 'sidebar-toggle-calendar'], ['notes', 'home-scratchpad', 'sidebar-toggle-scratchpad']] as const) {
    const toggle = page.getByTestId(`apps-builtin-card-toggle-${part}`)
    const row = page.getByTestId(`apps-builtin-${card}-part-${part}`)
    await expect(page.getByTestId(rail), part).toBeVisible()
    for (let round = 0; round < 2; round += 1) {
      await toggle.click()
      await expect(toggle, part).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId(rail), part).toHaveCount(0)
      await expect(row, part).toHaveAttribute('data-shown', 'false')
      // The page part stays on: the card is still on the sidebar, one of two.
      await expect(page.getByTestId(`apps-builtin-${card}-status`), part).toHaveText('1 of 2 on the sidebar')
      // A switch click never opens the detail page.
      await expect(page.getByTestId('plugin-detail')).toHaveCount(0)
      await expect(page.getByTestId('builtin-detail')).toHaveCount(0)
      await toggle.click()
      await expect(toggle, part).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId(rail), part).toBeVisible({ timeout: 15_000 })
    }
  }
  // The Notes page holds the same switch for its Scratchpad, and its Open.
  await openBuiltinDetail(page, 'notes')
  await expect(page.getByTestId('apps-part-home-scratchpad')).toContainText('Side bar')
  await expect(page.getByTestId('apps-builtin-toggle-home-scratchpad')).toHaveAttribute('aria-checked', 'true')
  // The page opens from the header; the side bar's own Open shows it beside this page.
  await expect(page.getByTestId('apps-builtin-open-notes')).toBeVisible()
  await expect(page.getByTestId('apps-part-open-notes')).toHaveCount(0)
  await expect(page.getByTestId('apps-part-home-scratchpad')).toContainText('A quick note pad')
  await page.getByTestId('apps-part-open-home-scratchpad').click()
  await expect(page.getByTestId('page-side-bar-scratchpad')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('sidebar-toggle-scratchpad')).toHaveAttribute('aria-pressed', 'true')
  // The rail's toggle closes it (the editor stays mounted, hidden, so its words are kept).
  await page.getByTestId('sidebar-toggle-scratchpad').click()
  await expect(page.getByTestId('sidebar-toggle-scratchpad')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('page-side-bar-scratchpad')).toBeHidden()
  await backToApps(page)
  await serverHoldsAppPreferences(page, fixture.port)
})

test('an Agenda taken off the rail before keeps its choice under the same key', async ({ page }) => {
  await goApps(page)
  // What an older build wrote when the person switched Agenda off on its own old card.
  await page.evaluate((key) => {
    const prefs = JSON.parse(localStorage.getItem(key) ?? '{}') as { unpinned?: string[] }
    prefs.unpinned = [...new Set([...(prefs.unpinned ?? []), 'rail:home-agenda'])]
    localStorage.setItem(key, JSON.stringify(prefs))
  }, PREFS)
  await page.reload()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('apps-builtin-card-toggle-home-agenda')).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 })
  await expect(page.getByTestId('sidebar-toggle-calendar')).toHaveCount(0)
  await page.getByTestId('apps-builtin-card-toggle-home-agenda').click()
  await expect(page.getByTestId('sidebar-toggle-calendar')).toBeVisible({ timeout: 15_000 })
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}') as { unpinned?: string[] }, PREFS)
  expect(stored.unpinned ?? []).not.toContain('rail:home-agenda')
  await serverHoldsAppPreferences(page, fixture.port)
})

test("Calendar's card opens one page: its parts, the plugin's switch, Open and the accounts with each mail account's calendar", async ({ page }) => {
  // The Mac's calendars and two mail accounts (this host has no EventKit): one whose calendar
  // macOS has, one it has none of.
  let enabled = true
  await page.route('**/api/calendar/sources/eventkit', async (route) => {
    const body = route.request().postDataJSON() as { enabled?: boolean } | null
    if (typeof body?.enabled === 'boolean') enabled = body.enabled
    await route.fulfill({ json: { sources: [{ id: 'eventkit', available: true, enabled }] } })
  })
  await page.route('**/api/calendar/sources', (route) => route.fulfill({ json: {
    sources: [{ id: 'eventkit', available: true, enabled, lastRefresh: new Date().toISOString(), eventCount: 12 }],
    calendars: [
      { id: 'c1', title: 'Work', account: 'pat@corp.example', color: '#1d6ff2', readonly: false, hidden: false },
      { id: 'c2', title: 'Family', account: 'Google', color: '#34c759', readonly: false, hidden: false },
      { id: 'c3', title: 'Holidays', account: 'iCloud', color: '#ff9500', readonly: true, hidden: true },
    ],
  } }))
  await page.route('**/api/plugins/mail/accounts', (route) => route.fulfill({ json: { accounts: [
    { accountId: 'mail-a', providerId: 'outlook', displayName: 'Pat', address: 'pat@corp.example', state: 'active', unread: 0 },
    { accountId: 'mail-b', providerId: 'imap', displayName: 'Pat', address: 'pat@fastmail.example', state: 'active', unread: 0 },
  ] } }))
  await goApps(page)
  const card = page.getByTestId('apps-builtin-calendar')
  await expect(card).toHaveAttribute('data-plugin', 'calendar')
  await page.getByTestId('apps-builtin-calendar-details').click()
  const detail = page.getByTestId('plugin-detail')
  await expect(detail).toHaveAttribute('data-plugin-id', 'calendar', { timeout: 30_000 })
  await expect(page.getByTestId('apps-parts-calendar')).toBeVisible()
  await expect(page.getByTestId('apps-part-calendar')).toContainText('Page')
  await expect(page.getByTestId('apps-part-home-agenda')).toContainText('Side bar')
  await expect(page.locator('#plugin-toggle-calendar')).toBeVisible()
  // The accounts are groups of this page; each mail account says where its calendar is.
  const accounts = page.getByTestId('plugin-core-sections-calendar')
  await expect(accounts.getByTestId('calendar-account-group')).toHaveCount(3, { timeout: 30_000 })
  await expect(page.getByTestId('calendar-mail-account-mail-a')).toHaveAttribute('data-match', 'here')
  await expect(page.getByTestId('calendar-mail-account-mail-a')).toContainText('Its calendar is here, under pat@corp.example')
  await expect(page.getByTestId('calendar-mail-account-mail-a')).toContainText('Calendar here')
  await expect(page.getByTestId('calendar-mail-account-mail-b')).toHaveAttribute('data-match', 'missing')
  await expect(page.getByTestId('calendar-mail-account-mail-b')).toContainText('No match found')
  await expect(page.getByTestId('calendar-mail-account-mail-b')).toContainText('Internet Accounts')
  // Calendar Accounts' switch off: nothing reads the calendars, so no account is called missing.
  await page.getByTestId('calendar-enabled-switch').click()
  await expect(page.getByTestId('calendar-mail-accounts')).toHaveCount(0)
  // On again: the group comes back only with the list the server read, and matches again.
  await page.getByTestId('calendar-enabled-switch').click()
  await expect(page.getByTestId('calendar-mail-account-mail-a')).toHaveAttribute('data-match', 'here', { timeout: 15_000 })
  // The part switch on this page and on the card are one answer.
  await page.getByTestId('apps-builtin-toggle-home-agenda').click()
  await expect(page.getByTestId('sidebar-toggle-calendar')).toHaveCount(0)
  await page.getByTestId('apps-builtin-toggle-home-agenda').click()
  await expect(page.getByTestId('sidebar-toggle-calendar')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('apps-builtin-open-calendar').click()
  await expect(page).toHaveURL(/\/calendar(?:[?#].*)?$/)
  await serverHoldsAppPreferences(page, fixture.port)
})

test("a plugin App's card has its sidebar switch too, and it moves the App's rail row", async ({ page }) => {
  await goApps(page)
  const toggle = page.getByTestId('plugin-card-toggle-walnut-time:main')
  await expect(toggle).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('plugin-card-open-walnut-time')).toBeVisible()
  const before = await toggle.getAttribute('aria-checked')
  const row = page.locator('.sidebar-nav [data-testid="sidebar-app-walnut-time:main"]')
  for (let round = 0; round < 2; round += 1) {
    await toggle.click()
    await expect(toggle).not.toHaveAttribute('aria-checked', before ?? '')
    await expect(row).toHaveCount(before === 'true' ? 0 : 1, { timeout: 15_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', before ?? '')
    await expect(row).toHaveCount(before === 'true' ? 1 : 0, { timeout: 15_000 })
  }
  await expect(page.getByTestId('plugin-detail')).toHaveCount(0)
  await serverHoldsAppPreferences(page, fixture.port)
})
