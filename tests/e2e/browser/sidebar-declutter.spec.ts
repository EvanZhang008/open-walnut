import { test, expect, type Page } from '@playwright/test'

/**
 * The APP sidebar carries ONLY daily surfaces. Management pages (Agents, Skills,
 * Commands, Memory, Hooks) moved into the SETTINGS sidebar's "Manage"
 * group, audio recording moved into Settings → Audio Capture, and the collapsible
 * "Other" group is gone.
 *
 * The Tasks table is deliberately NOT in that group: it briefly lived behind Settings
 * during the declutter and came back out, because it is a surface a user visits daily,
 * not configuration.
 *
 * This pins the shape so the icon wall can't grow back: the app sidebar was a
 * 13-item column of unlabelled glyphs when collapsed (the default), which is
 * exactly the state a user reported as unreadable.
 *
 * Plugin apps are the one sanctioned dynamic group. The list Walnut SHIPS is
 * still exactly the 9 core entries, and installed apps may only appear as a
 * contiguous group between Routines and Settings — so the assertion below pins
 * the core prefix, the Settings suffix, and the fact that anything extra is a
 * plugin app link (`/apps/…`), never another core page sneaking back in.
 */

/** Expand the sidebar so the labels (not just glyphs) are assertable. */
async function expandSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('.sidebar')
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

test('app sidebar shows only the daily surfaces — no management pages, no Other group', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expandSidebar(page)

  const CORE_PREFIX = ['Chat', 'Todo', 'Agenda', 'Home', 'Tasks', 'Notes', 'Calendar', 'Routines']
  const labels = (await page.locator('.sidebar-nav .sidebar-link').allTextContents()).map((t) => t.trim())

  // The core 8 come first, in this exact order, and Settings is always last.
  expect(labels.slice(0, CORE_PREFIX.length)).toEqual(CORE_PREFIX)
  expect(labels[labels.length - 1]).toBe('Settings')

  // Anything between Routines and Settings must be a plugin app entry — i.e. a
  // link into /apps/… carrying a sidebar-app-<id> test id. This is what keeps a
  // new core page from being smuggled into the column via this allowance.
  const middle = labels.slice(CORE_PREFIX.length, labels.length - 1)
  const appLinks = page.locator('.sidebar-nav a[href^="/apps/"]')
  const appLabels = (await appLinks.allTextContents()).map((t) => t.trim())
  expect(appLabels).toEqual(middle)
  for (let i = 0; i < middle.length; i++) {
    await expect(appLinks.nth(i)).toHaveAttribute('data-testid', /^sidebar-app-/)
  }

  // The removed group and the removed recording entry.
  await expect(page.getByRole('button', { name: /^Other$/ })).toHaveCount(0)
  await expect(page.locator('.sidebar-recording-btn')).toHaveCount(0)

  // No sidebar route into the management pages any more.
  for (const href of ['/agents', '/skills', '/commands', '/memory', '/repos', '/hooks']) {
    await expect(page.locator(`.sidebar a[href="${href}"]`)).toHaveCount(0)
  }

  // Tasks, by contrast, IS top level — the one that came back out of Settings.
  await expect(page.locator('.sidebar a[href="/tasks"]')).toHaveCount(1)
})

test('the Settings SIDEBAR carries every management entry, no Tasks table', async ({ page }) => {
  await page.goto('/settings')
  const nav = page.locator('.settings-nav')
  await expect(nav).toBeVisible({ timeout: 30_000 })

  // They live IN the settings sidebar (not as cards in the content area), above
  // the section list, under a "Manage" caption.
  await expect(nav.locator('.settings-nav-group-label', { hasText: 'Manage' })).toBeVisible()
  await expect(nav.locator('.settings-nav-group-label', { hasText: 'Configure' })).toBeVisible()

  // Full pages: real anchors, so they route away rather than scrolling.
  for (const id of ['agents', 'skills', 'commands', 'memory']) {
    const link = nav.getByTestId(`settings-nav-${id}`)
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /./)
  }
  // Hooks joined the group as a page SECTION (a button, not a link) — it is a
  // browse-and-edit list, not a knob. (Repositories is hidden until it is ready.)
  for (const id of ['hooks']) {
    const btn = nav.getByTestId(`settings-nav-${id}`)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveJSProperty('tagName', 'BUTTON')
  }
  // The Tasks table went back to the app sidebar and must not reappear here as a
  // page LINK. (Configure → Tasks is a settings section, a button, and is fine.)
  await expect(nav.locator('a[data-testid="settings-nav-tasks"]')).toHaveCount(0)
  await expect(nav.getByTestId('settings-nav-repositories')).toHaveCount(0)

  // A page link actually navigates (real click, no page.goto).
  await nav.getByTestId('settings-nav-skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.locator('.skills-page')).toBeVisible({ timeout: 30_000 })

  // And a Manage SECTION scrolls to its section on the settings page itself.
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.getByTestId('settings-nav-hooks').click()
  await expect(page).toHaveURL(/\/settings#hooks$/)
  await expect(page.locator('#hooks')).toBeVisible()
})

test('recording starts from Settings → Audio Capture, not the sidebar', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.locator('#audio-capture')).toBeAttached({ timeout: 30_000 })
  await page.locator('.settings-nav-item', { hasText: 'Audio Capture' }).click()

  const section = page.locator('#audio-capture')
  await expect(section).toBeVisible()
  // Either the toggle (capture available) or the unavailable note — never nothing.
  const toggle = page.getByTestId('settings-recording-toggle')
  const unavailable = section.getByText('System audio capture is not available on this machine.')
  await expect
    .poll(async () => (await toggle.count()) + (await unavailable.count()), { timeout: 20_000 })
    .toBeGreaterThan(0)
  if ((await toggle.count()) > 0) {
    await expect(toggle).toHaveText(/Start recording|Stop recording|Starting/)
  }
})
