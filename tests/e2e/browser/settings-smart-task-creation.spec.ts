/**
 * Settings → Tasks → Smart task creation, and the one-engine layout around it.
 *
 * Contract pinned against the server's saved config (the only authority):
 *   - the nav has no "AI Provider" and no "Jev Decisions" entry; Jev is a
 *     runner choice inside Tasks, and the API alternative sits collapsed under
 *     Advanced
 *   - the two switches write agent.quick_parse / agent.session_organize, and
 *     two quick clicks both land (updateConfig replaces the whole `agent` key,
 *     so a second write spreading a stale agent would undo the first)
 *   - the runner radio writes jev.decisions, shows Jev's fields only for Jev,
 *     and a round trip keeps the endpoint the user typed
 *   - the provider card opens on its `#providers` deep link
 *   - a page left open never undoes a change made elsewhere: 2026-09-22, a
 *     Settings window open since before `agent.main_provider` was switched to
 *     Claude Code saved an unrelated field and wrote the old `agent` back
 *
 * Every test here writes `agent`, so they share this one serial file: two
 * files running in parallel against the shared fixture would race each other.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

type Cfg = { agent?: Record<string, unknown>; jev?: Record<string, unknown>; tools?: Record<string, unknown>; providers?: Record<string, unknown> }

async function serverConfig(request: APIRequestContext): Promise<Cfg> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { config: Cfg }).config
}

/** Initial load only; everything after is real clicks. */
async function openTasks(page: Page) {
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav-tasks')
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  const card = page.getByTestId('smart-task-creation')
  await expect(card).toBeVisible({ timeout: 15_000 })
  return card
}

let original: Cfg

test.beforeAll(async ({ request }) => {
  original = await serverConfig(request)
})

test.afterAll(async ({ request }) => {
  // The fixture server is shared by every spec: put back exactly what was there.
  await request.put('/api/config', { data: { agent: original.agent ?? {} } })
  await request.put('/api/config', { data: { jev: original.jev ?? null } })
  await request.put('/api/config', { data: { tools: original.tools ?? {} } })
})

test('the nav has one engine choice: no AI Provider, no Jev Decisions', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav-tasks')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-providers')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-jev')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-engines')).toBeVisible()
})

test('both switches save, together, and survive a reload', async ({ page, request }) => {
  const card = await openTasks(page)
  const fill = card.locator('#smart-fill-details')
  const file = card.locator('#smart-file-sessions')

  // Two clicks back to back: the second must not undo the first.
  const beforeFill = (await serverConfig(request)).agent?.quick_parse === true
  const beforeFile = (await serverConfig(request)).agent?.session_organize !== false
  await fill.click()
  await file.click()
  await expect.poll(async () => {
    const a = (await serverConfig(request)).agent ?? {}
    return [a.quick_parse === true, a.session_organize !== false]
  }, { timeout: 10_000 }).toEqual([!beforeFill, !beforeFile])

  // Sibling agent keys ride along (the write spreads the whole `agent` object).
  const agentAfter = (await serverConfig(request)).agent ?? {}
  for (const key of Object.keys(original.agent ?? {})) {
    if (key === 'quick_parse' || key === 'session_organize') continue
    expect(agentAfter[key]).toEqual((original.agent ?? {})[key])
  }

  await page.reload()
  const again = await openTasks(page)
  await expect(again.locator('#smart-fill-details')).toHaveAttribute('aria-checked', String(!beforeFill))
  await expect(again.locator('#smart-file-sessions')).toHaveAttribute('aria-checked', String(!beforeFile))
})

test('a switch never writes back a change another window made meanwhile', async ({ page, request }) => {
  const card = await openTasks(page)
  // Another window (the composer's + menu, a second tab) writes `agent` while
  // this page still holds its first read.
  const agent = (await serverConfig(request)).agent ?? {}
  await request.put('/api/config', { data: { agent: { ...agent, quick_parse: !(agent.quick_parse === true) } } })
  const wantFill = !(agent.quick_parse === true)
  const beforeFile = agent.session_organize !== false

  await card.locator('#smart-file-sessions').click()
  await expect.poll(async () => {
    const a = (await serverConfig(request)).agent ?? {}
    return [a.quick_parse === true, a.session_organize !== false]
  }, { timeout: 10_000 }).toEqual([wantFill, !beforeFile])
})

test('a failed save puts the switch back to what the server holds', async ({ page, request }) => {
  const card = await openTasks(page)
  const fill = card.locator('#smart-fill-details')
  const before = (await serverConfig(request)).agent?.quick_parse === true
  await page.route('**/api/config', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { error: 'disk full' } })
      : route.fallback())
  await fill.click()
  await expect(fill).toHaveAttribute('aria-checked', String(before), { timeout: 10_000 })
  expect((await serverConfig(request)).agent?.quick_parse === true).toBe(before)
  await page.unrouteAll({ behavior: 'ignoreErrors' })

  // And the next real click still saves.
  await fill.click()
  await expect.poll(async () => (await serverConfig(request)).agent?.quick_parse === true, { timeout: 10_000 })
    .toBe(!before)
  await expect(fill).toHaveAttribute('aria-checked', String(!before))
})

test('the runner radio shows Jev settings only for Jev and keeps what was typed', async ({ page, request }) => {
  const card = await openTasks(page)
  await expect(card.getByTestId('smart-runner-default')).toBeChecked()
  await expect(card.getByTestId('jev-settings')).toHaveCount(0)

  await card.getByTestId('smart-runner-jev').check()
  await expect(card.getByTestId('jev-settings')).toBeVisible()
  // No key in the fixture: the card says who answers meanwhile.
  await expect(card.getByTestId('jev-no-key')).toBeVisible()
  await expect.poll(async () => (await serverConfig(request)).jev?.decisions, { timeout: 10_000 })
    .toEqual({ quick_parse: true, session_organize: true })

  const endpoint = 'https://openrouter.ai/api/alpha/decisions'
  await card.locator('#jev-endpoint').fill(endpoint)
  await card.locator('#jev-endpoint').press('Enter') // text fields commit on blur or Enter
  await expect.poll(async () => (await serverConfig(request)).jev?.endpoint, { timeout: 10_000 }).toBe(endpoint)

  await card.getByTestId('smart-runner-default').check()
  await expect(card.getByTestId('jev-settings')).toHaveCount(0)
  await expect.poll(async () => (await serverConfig(request)).jev?.decisions, { timeout: 10_000 })
    .toEqual({ quick_parse: false, session_organize: false })
  expect((await serverConfig(request)).jev?.endpoint).toBe(endpoint)

  await card.getByTestId('smart-runner-jev').check()
  await expect(card.locator('#jev-endpoint')).toHaveValue(endpoint)
  await expect.poll(async () => (await serverConfig(request)).jev?.decisions, { timeout: 10_000 })
    .toEqual({ quick_parse: true, session_organize: true })

  await card.screenshot({ path: '/tmp/settings-redesign/smart-task-creation-jev.png' })

  // Jev then Default back to back: the last pick is what sticks, on screen and on disk.
  await card.getByTestId('smart-runner-default').check()
  await card.getByTestId('smart-runner-jev').check()
  await card.getByTestId('smart-runner-default').check()
  await expect.poll(async () => (await serverConfig(request)).jev?.decisions, { timeout: 10_000 })
    .toEqual({ quick_parse: false, session_organize: false })
  await page.waitForTimeout(1_000)
  await expect(card.getByTestId('smart-runner-default')).toBeChecked()
  await expect(card.getByTestId('jev-settings')).toHaveCount(0)
  expect((await serverConfig(request)).jev?.endpoint).toBe(endpoint)
})

test('a named provider entry that runs on the Claude CLI reads as Claude Code (N01)', async ({ page, request }) => {
  // The fixture's main provider is a user-named entry whose api is claude-cli
  // (its fake CLI adapter). It runs on Claude Code, so the API card stays Off
  // and nothing calls it an unknown provider.
  const cfg = await serverConfig(request)
  const provider = String(cfg.agent?.main_provider ?? '')
  expect(provider).not.toBe('')
  expect(provider).not.toBe('claude_cli')
  expect((cfg.providers as Record<string, { api?: string }> | undefined)?.[provider]?.api).toBe('claude-cli')
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav-advanced')
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  const card = page.locator('#providers')
  await expect(card.locator('.settings-section-title')).toHaveText('Use an API instead of Claude Code')
  await expect(card.getByTestId('providers-summary')).toHaveText('Off')
  await expect(card).not.toContainText('Unknown provider')
})

test('on Claude Code the card is folded to one line and opens on its deep link', async ({ page }) => {
  // Present the Claude Code case to the page only: rewriting the shared
  // fixture's provider would change it under every other spec in the run.
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as { config: { agent?: Record<string, unknown> } }
    body.config.agent = { ...body.config.agent, main_provider: 'claude_cli' }
    await route.fulfill({ response: res, json: body })
  })
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav-advanced')
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  const card = page.locator('#providers')
  await expect(card.getByTestId('providers-summary')).toHaveText('Off')
  // Folded rows stay mounted (hidden) so a pane switch keeps their state.
  await expect(card.getByTestId('provider-modes')).toBeHidden()
  await card.screenshot({ path: '/tmp/settings-redesign/providers-collapsed.png' })

  await card.getByTestId('providers-expand').click()
  await expect(card.getByTestId('provider-modes')).toBeVisible({ timeout: 15_000 })

  // The setup banner links straight here: that link must land on an open card.
  await page.goto('/settings#providers')
  await expect(page.locator('#providers').getByTestId('provider-modes')).toBeVisible({ timeout: 30_000 })
  // The app keeps polling /api/config; one intercepted read can still be in
  // flight when the page closes.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('an autosave on a page opened earlier keeps what another window changed', async ({ page, request }) => {
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav-advanced')
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  await page.getByTestId('advanced-disclosure-exec').click()
  const timeout = page.locator('#exec-timeout')
  await expect(timeout).toBeVisible({ timeout: 15_000 })

  // Another writer, after this page loaded.
  const agent = (await serverConfig(request)).agent ?? {}
  await request.put('/api/config', { data: { agent: { ...agent, session_organize: false, language: 'stale-page-marker' } } })

  // The field is in seconds (N3-24); config keeps milliseconds.
  await timeout.fill('43')
  await expect.poll(async () => {
    const tools = (await serverConfig(request)).tools as { exec?: { timeout?: number } } | undefined
    return tools?.exec?.timeout
  }, { timeout: 15_000 }).toBe(43000)

  const after = (await serverConfig(request)).agent ?? {}
  expect(after.session_organize).toBe(false)
  expect(after.language).toBe('stale-page-marker')
  expect(after.main_provider).toBe(agent.main_provider)
})

test('the page shows another window\'s change without a reload', async ({ page, request }) => {
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav-tasks')
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  const fill = page.locator('#smart-fill-details')
  await expect(fill).toBeVisible({ timeout: 15_000 })
  const before = (await fill.getAttribute('aria-checked')) === 'true'

  const agent = (await serverConfig(request)).agent ?? {}
  await request.put('/api/config', { data: { agent: { ...agent, quick_parse: !before } } })
  await expect(fill).toHaveAttribute('aria-checked', String(!before), { timeout: 10_000 })
})
