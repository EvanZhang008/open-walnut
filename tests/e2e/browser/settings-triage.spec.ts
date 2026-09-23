/**
 * Settings → Inbox Triage.
 *
 * Three things only the real UI can prove: the card renders every field from what
 * the CONFIG says (not from an optimistic local value), merely OPENING it writes
 * nothing (the useAutoSave baseline trap — a baseline that differs from the
 * rendered default rewrites the config on every visit), and a save spreads the
 * sibling `triage.*` keys the card does not render instead of replacing the key
 * whole (updateConfig replaces `triage` wholesale).
 *
 * Engines: this file is Chromium, and the WebKit half is deliberately READ-ONLY
 * (settings-triage.webkit.spec.ts is NOT added for the same reason
 * settings-default-engine's WebKit half is read-only — both files would run in ONE
 * Playwright invocation against one fixture server, and two writers of the same
 * config key race). Settings IS a Mac-app (WebKit) surface, so the read-only
 * WebKit pass belongs with the next UI slice that touches this card; the fields
 * here are plain inputs with no WebKit-specific geometry.
 *
 * Never a page.goto for NAVIGATION (only for the first load): every step below is
 * a real click.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
// A cold SPA navigation under machine load has eaten 27s of the default budget.
test.setTimeout(90_000)

type TriageConfig = {
  enabled?: boolean
  every?: string
  every_messages?: number
  sources?: string[]
  mode?: string
  auto_mark_read?: boolean
  active_hours?: string
  [key: string]: unknown
}

/** The config as the server reports it — the only authority on what was saved. */
async function serverTriage(request: APIRequestContext): Promise<TriageConfig | undefined> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: { triage?: TriageConfig } }
  return body.config?.triage
}

/** Real SPA navigation: sidebar → Settings → the Inbox Triage nav item. */
async function openTriageSection(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
  }
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  // The registry row's id is what mints this testid (SettingsNav).
  await page.getByTestId('settings-nav-triage').click()
  const section = page.locator('#triage')
  await expect(section).toBeVisible()
  return section
}

async function reopenTriageSection(page: Page) {
  await page.locator('.sidebar-nav a[href="/"]').click()
  await expect(page.locator('#triage')).toHaveCount(0)
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-triage').click()
  const section = page.locator('#triage')
  await expect(section).toBeVisible()
  return section
}

test.describe('Settings → Inbox Triage', () => {
  test('renders every field on its defaults and writes NOTHING on open', async ({ page, request }) => {
    const before = await serverTriage(request)

    // Watch the config writes for the whole visit: the count must not move.
    let writes = 0
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'GET') writes += 1
      await route.fallback()
    })

    const section = await openTriageSection(page)

    // Off by default, and every default matches src/core/triage/config.ts.
    await expect(section.locator('#inbox-triage-enabled')).toHaveAttribute('aria-checked', String(before?.enabled ?? false))
    await expect(section.locator('#inbox-triage-every')).toHaveValue(before?.every ?? '30m')
    await expect(section.locator('#inbox-triage-every-messages')).toHaveValue(String(before?.every_messages ?? 20))
    await expect(section.getByTestId('inbox-triage-source-mail')).toBeChecked()
    await expect(section.getByTestId('inbox-triage-source-slack')).toBeChecked()
    await expect(section.getByTestId(`inbox-triage-mode-${before?.mode ?? 'ask'}`)).toHaveAttribute('aria-checked', 'true')
    await expect(section.locator('#inbox-triage-hours')).toHaveValue(before?.active_hours ?? '08:00-22:00')
    await expect(section.locator('#inbox-triage-auto-mark-read')).toHaveAttribute('aria-checked', String(before?.auto_mark_read ?? false))

    // Give the auto-save debounce a chance to misbehave before judging it.
    await page.waitForTimeout(2_000)
    expect(writes).toBe(0)
    expect(await serverTriage(request)).toEqual(before)
  })

  test('a change round-trips through the server and survives leaving the page', async ({ page, request }) => {
    const section = await openTriageSection(page)

    // Switches and segments save on the click; text fields on blur or Enter.
    await section.locator('#inbox-triage-enabled').click()
    await expect(section.locator('#inbox-triage-every')).toBeEnabled()
    await section.locator('#inbox-triage-every').fill('45m')
    await section.locator('#inbox-triage-every').press('Enter')
    await section.locator('#inbox-triage-every-messages').fill('8')
    await section.locator('#inbox-triage-every-messages').press('Enter')
    await section.getByTestId('inbox-triage-source-mail').uncheck()
    await section.getByTestId('inbox-triage-mode-assist').click()
    await section.locator('#inbox-triage-hours').fill('09:00-18:00')
    await section.locator('#inbox-triage-hours').blur()
    await section.locator('#inbox-triage-auto-mark-read').click()

    await expect.poll(async () => await serverTriage(request), { timeout: 20_000 })
      .toMatchObject({
        enabled: true,
        every: '45m',
        every_messages: 8,
        sources: ['slack'],
        mode: 'assist',
        active_hours: '09:00-18:00',
        auto_mark_read: true,
      })

    // The card renders from the config, so a real navigation away and back is
    // what proves the values were persisted rather than merely displayed.
    const reopened = await reopenTriageSection(page)
    await expect(reopened.locator('#inbox-triage-every')).toHaveValue('45m')
    await expect(reopened.locator('#inbox-triage-every-messages')).toHaveValue('8')
    await expect(reopened.getByTestId('inbox-triage-source-mail')).not.toBeChecked()
    await expect(reopened.getByTestId('inbox-triage-source-slack')).toBeChecked()
    await expect(reopened.getByTestId('inbox-triage-mode-assist')).toHaveAttribute('aria-checked', 'true')
    await expect(reopened.locator('#inbox-triage-enabled')).toHaveAttribute('aria-checked', 'true')
  })

  test('a save keeps a sibling triage key the card does not render', async ({ page, request }) => {
    // Seed a key no field renders. updateConfig replaces `triage` whole, so this
    // is exactly what a save without the `...config.triage` spread would eat.
    const current = await serverTriage(request)
    const put = await request.put('/api/config', {
      data: { triage: { ...current, future_knob: 'keep-me' } },
    })
    expect(put.ok()).toBe(true)

    const section = await openTriageSection(page)
    // The previous test left triage on, so the field is live.
    await expect(section.locator('#inbox-triage-every')).toBeEnabled()
    await section.locator('#inbox-triage-every').fill('20m')
    await section.locator('#inbox-triage-every').press('Enter')

    await expect.poll(async () => await serverTriage(request), { timeout: 20_000 })
      .toMatchObject({ every: '20m', future_knob: 'keep-me' })
  })

  test('enabling it creates the routine, and disabling leaves it disabled', async ({ page, request }) => {
    const section = await openTriageSection(page)
    const toggle = section.locator('#inbox-triage-enabled')
    if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click()

    // The server reconciles config → ONE routine on config:changed (no restart).
    await expect.poll(async () => {
      const res = await request.get('/api/routines?includeDisabled=true')
      const body = await res.json() as { jobs?: Array<Record<string, any>> }
      const rows = (body.jobs ?? []).filter((j) => j?.initProcessor?.actionId === 'inbox-triage-batch')
      return { count: rows.length, enabled: rows[0]?.enabled }
    }, { timeout: 30_000 }).toEqual({ count: 1, enabled: true })

    await toggle.click()
    await expect.poll(async () => {
      const res = await request.get('/api/routines?includeDisabled=true')
      const body = await res.json() as { jobs?: Array<Record<string, any>> }
      const rows = (body.jobs ?? []).filter((j) => j?.initProcessor?.actionId === 'inbox-triage-batch')
      // Disabled, never deleted: its runs and notes are the cross-run memory.
      return { count: rows.length, enabled: rows[0]?.enabled }
    }, { timeout: 30_000 }).toEqual({ count: 1, enabled: false })
  })
})
