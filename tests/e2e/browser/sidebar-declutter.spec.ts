import { test, expect, type Page } from '@playwright/test'

/**
 * The APP sidebar carries ONLY daily surfaces. Management pages (Agents, Skills,
 * Commands, Memory, Repositories, Hooks) moved into the SETTINGS sidebar's "Manage"
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

  const labels = (await page.locator('.sidebar-nav .sidebar-link').allTextContents()).map((t) => t.trim())
  expect(labels).toEqual([
    'Chat', 'Todo', 'Agenda', 'Home', 'Tasks', 'Notes', 'Calendar', 'Routines', 'Settings',
  ])

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
  // Repositories and Hooks joined the group as page SECTIONS (buttons, not links) —
  // they are browse-and-edit lists, not knobs.
  for (const id of ['repositories', 'hooks']) {
    const btn = nav.getByTestId(`settings-nav-${id}`)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveJSProperty('tagName', 'BUTTON')
  }
  // The Tasks table went back to the app sidebar and must not reappear here.
  await expect(nav.getByTestId('settings-nav-tasks')).toHaveCount(0)

  // A page link actually navigates (real click, no page.goto).
  await nav.getByTestId('settings-nav-skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.locator('.skills-page')).toBeVisible({ timeout: 30_000 })

  // And a Manage SECTION scrolls to its section on the settings page itself.
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.getByTestId('settings-nav-repositories').click()
  await expect(page).toHaveURL(/\/settings#repositories$/)
  await expect(page.locator('#repositories')).toBeVisible()
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
