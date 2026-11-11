import { test, expect } from '@playwright/test'
import { openDraftOnCwd, draftPanel } from './draft-helpers'
import { fixtureHome, lockUserSettingsFile, openSessionsSection } from './engine-settings-helpers'
import { dropFakes } from './route-teardown'

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1200, height: 800 } })
let release: (() => Promise<void>) | undefined
let originalMode: unknown
test.beforeAll(async ({ request }) => {
  release = await lockUserSettingsFile(await fixtureHome(request))
  const view = await (await request.get('/api/engines/claude/settings')).json()
  const item = view.groups.flatMap((g: { items: Array<{ key: string; value: unknown; source: string }> }) => g.items).find((i: { key: string }) => i.key === 'permissions.defaultMode')
  originalMode = item.source === 'default' ? undefined : item.value
})
// The status poll keeps firing; a route handler still fetching when the page closes would fail the test.
test.afterEach(async ({ page }) => { await dropFakes(page) })
test.afterAll(async ({ request }) => {
  await request.patch('/api/engines/claude/settings', { data: originalMode === undefined ? { unset: ['permissions.defaultMode'] } : { set: { 'permissions.defaultMode': originalMode } } })
  await release?.()
})

// Real settings API/files on the isolated fixture, with its realistic dense settings.
test('Settings edits the engine default, preserves adjacent settings and can clear it', async ({ page, request }) => {
  const before = await (await request.get('/api/engines/claude/settings')).json()
  const find = (view: typeof before, key: string) => view.groups.flatMap((g: { items: Array<{ key: string; value: unknown }> }) => g.items).find((i: { key: string }) => i.key === key)
  await openSessionsSection(page)
  const picker = page.getByTestId('claude-default-mode')
  await expect(picker).toBeVisible()
  await expect(picker).toHaveValue('bypassPermissions')
  await picker.selectOption('auto')
  await expect(picker).toBeEnabled()
  await expect(picker).toHaveValue('auto')
  const saved = await (await request.get('/api/engines/claude/settings')).json()
  expect(find(saved, 'permissions.defaultMode').value).toBe('auto')
  expect(find(saved, 'outputStyle')).toEqual(find(before, 'outputStyle'))
  await page.reload()
  await expect(picker).toHaveValue('auto')
  await picker.selectOption('')
  await expect(picker).toBeEnabled()
  await expect(picker).toHaveValue('')
  await picker.selectOption('bypassPermissions')
  await expect(picker).toBeEnabled()
  await expect(picker).toHaveValue('bypassPermissions')
})

test('Auto denial remains after a failed switch, then one click switches to asking', async ({ page, request }) => {
  const sid = 'pw-mode-test-session'
  await page.route(`**/api/sessions/${sid}`, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const record = await response.json()
    await route.fulfill({ response, json: { ...record, session: { ...record.session, engine: 'claude', provider: 'cli', mode: 'auto', autoPermissionDenial: { tools: ['Bash', 'mcp__walnut__task_create'], at: new Date().toISOString() } } } })
  })
  // The status snapshot is authoritative for the mode.
  await page.route('**/api/sessions/status?**', async route => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.statuses?.[sid]) { body.statuses[sid].mode = 'auto'; body.statuses[sid].engine = 'claude'; body.statuses[sid].provider = 'cli'; }
    await route.fulfill({ response, json: body })
  })
  await page.goto(`/sessions?id=${sid}`)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`).last()
  await expect(panel.getByTestId('auto-permission-denial')).toBeVisible()
  let fail = true
  await page.route('**/api/engines/claude/recover-permission', async route => {
    if (route.request().method() === 'POST') {
      if (fail) return route.fulfill({ status: 409, json: { error: 'Engine refused mode change' } })
      const body = await (await request.get(`/api/sessions/${sid}`)).json()
      await route.fulfill({ status: 200, json: { session: { ...body.session, mode: 'default', statusRevision: (body.session.statusRevision ?? 0) + 100, statusUpdatedAt: new Date().toISOString() } } })
      return
    }
    const response = await route.fetch()
    const record = await response.json()
    await route.fulfill({ response, json: { ...record, session: { ...record.session, engine: 'claude', provider: 'cli', mode: 'auto', autoPermissionDenial: { tools: ['Bash'], at: new Date().toISOString() } } } })
  })
  await panel.getByRole('button', { name: 'Switch to asking' }).click()
  await expect(panel.getByRole('alert')).toContainText('Engine refused mode change')
  await expect(panel.getByTestId('auto-permission-denial')).toBeVisible()
  fail = false
  await panel.getByRole('button', { name: 'Switch to asking' }).click()
  await expect(panel.getByTestId('auto-permission-denial')).toBeHidden()
})

// Preview follows the draft's host/folder, without turning it into a mode choice.
test('a draft previews the saved engine mode and still allows a session choice', async ({ page, request }) => {
  await request.patch('/api/engines/claude/settings', { data: { set: { 'permissions.defaultMode': 'plan' } } })
  test.setTimeout(60000)
  try {
    await page.goto('/')
    await openDraftOnCwd(page, '/tmp')
    const pill = draftPanel(page).locator('.draft-mode-pill')
    await expect(pill).toHaveAttribute('data-mode', 'plan')
    await pill.click()
    await expect(pill).toHaveAttribute('data-mode', 'auto')
    await draftPanel(page).locator('.chat-input-textarea').focus()
    await page.keyboard.press('Shift+Tab')
    await expect(pill).toHaveAttribute('data-mode', 'bypass')
  } finally {
    await request.patch('/api/engines/claude/settings', { data: originalMode === undefined ? { unset: ['permissions.defaultMode'] } : { set: { 'permissions.defaultMode': originalMode } } })
  }
})
