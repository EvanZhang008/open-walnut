/**
 * Settings → Engines: edit Claude Code's and Codex's OWN settings from Walnut.
 *
 * Every assertion about "what changed" is made against the file on disk under
 * the fixture HOME, not against the UI's optimistic state: the point of the
 * feature is that the engine's file changes by exactly the addressed key while
 * hooks, allowlists, comments and tables stay byte-for-byte.
 */
import { test, expect } from '@playwright/test'
import {
  control,
  fixtureHome,
  openEnginesSection,
  readClaudeSettings,
  readCodexConfig,
  row,
  waitForEngineRows,
} from './engine-settings-helpers'

test.describe.configure({ mode: 'serial' })
// A cold SPA navigation under machine load has eaten 27s of the default 30s
// budget when another browser loaded the dev bundle at the same time.
test.setTimeout(90_000)

test.describe('Settings → Engines', () => {
  test('claude: toggles, selects, text and reset change only their key; hooks and allowlists survive', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const before = await readClaudeSettings(home)
    expect(before.alwaysThinkingEnabled).toBe(true)

    const section = await openEnginesSection(page)
    await waitForEngineRows(section, 'claude')

    // Seeded values are attributed to the file; an unseeded one to the default.
    await expect(row(section, 'alwaysThinkingEnabled')).toHaveAttribute('data-source', 'file')
    await expect(row(section, 'outputStyle')).toHaveAttribute('data-source', 'file')
    await expect(row(section, 'autoCompactEnabled')).toHaveAttribute('data-source', 'default')
    // The permission-mode row tells the truth about Walnut sessions.
    await expect(row(section, 'permissions.defaultMode')).toContainText('--permission-mode')

    // Boolean: Thinking mode off.
    const thinking = control(section, 'claude', 'alwaysThinkingEnabled')
    await expect(thinking).toHaveAttribute('aria-checked', 'true')
    await thinking.click()
    await expect(thinking).toHaveAttribute('aria-checked', 'false')
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(false)

    // Select: permission mode → plan; the allow/deny lists next to it are untouched.
    await control(section, 'claude', 'permissions.defaultMode').selectOption('plan')
    await expect.poll(async () => ((await readClaudeSettings(home)).permissions as Record<string, unknown>).defaultMode).toBe('plan')
    const afterSelect = await readClaudeSettings(home)
    expect((afterSelect.permissions as Record<string, unknown>).allow).toEqual(['Bash(git *)', 'Read'])
    expect((afterSelect.permissions as Record<string, unknown>).deny).toEqual(['WebFetch'])

    // Text: language, committed on Enter.
    const language = control(section, 'claude', 'language')
    await expect(language).toHaveValue('Chinese')
    await language.fill('Japanese')
    await language.press('Enter')
    await expect.poll(async () => (await readClaudeSettings(home)).language).toBe('Japanese')

    // Reset removes the key and the row falls back to the default.
    await expect(row(section, 'outputStyle')).toHaveAttribute('data-source', 'file')
    await section.getByTestId('engine-setting-reset-outputStyle').click()
    await expect(row(section, 'outputStyle')).toHaveAttribute('data-source', 'default')
    await expect.poll(async () => 'outputStyle' in (await readClaudeSettings(home))).toBe(false)

    // Everything Walnut never declared is byte-identical to the seed.
    const after = await readClaudeSettings(home)
    for (const key of ['cleanupPeriodDays', 'includeCoAuthoredBy', 'hooks', 'statusLine', 'enabledPlugins', 'autoUpdatesChannel', 'verbose']) {
      expect(after[key], key).toEqual(before[key])
    }
    // Key order of the untouched prefix is preserved (one-line diffs for a reviewer).
    expect(Object.keys(after).slice(0, 3)).toEqual(Object.keys(before).slice(0, 3))
  })

  test('claude: a reload shows the values on disk, and the terminal group is collapsed until opened', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const section = await openEnginesSection(page)
    await waitForEngineRows(section, 'claude')

    await expect(control(section, 'claude', 'alwaysThinkingEnabled')).toHaveAttribute('aria-checked', 'false')
    await expect(control(section, 'claude', 'permissions.defaultMode')).toHaveValue('plan')
    await expect(control(section, 'claude', 'language')).toHaveValue('Japanese')

    // Terminal-only rows are behind a collapsed group: not visible until opened.
    const theme = row(section, 'theme')
    await expect(theme).toBeHidden()
    await section.locator('summary', { hasText: 'Terminal only' }).click()
    await expect(theme).toBeVisible()
    await expect(theme).toHaveAttribute('data-source', 'default')

    // A select whose value is not stored shows the declared default.
    await expect(control(section, 'claude', 'theme')).toHaveValue('dark')
    await control(section, 'claude', 'theme').selectOption('light')
    await expect.poll(async () => (await readClaudeSettings(home)).theme).toBe('light')

    // A boolean the engine decides by default is a three-way select, never a toggle
    // pretending to know: Default → On writes true, back to Default removes the key.
    const workflows = control(section, 'claude', 'enableWorkflows')
    await expect(workflows).toHaveValue('')
    await workflows.selectOption('true')
    await expect.poll(async () => (await readClaudeSettings(home)).enableWorkflows).toBe(true)
    await expect(row(section, 'enableWorkflows')).toHaveAttribute('data-source', 'file')
    await workflows.selectOption('')
    await expect.poll(async () => 'enableWorkflows' in (await readClaudeSettings(home))).toBe(false)
    await expect(row(section, 'enableWorkflows')).toHaveAttribute('data-source', 'default')
    // The files footer names where things went; on this machine the environment
    // WAS checked, so no "not checked" caveat is shown.
    await expect(section).toContainText('.claude/settings.json')
    await expect(section.getByTestId('engine-settings-env-unchecked')).toHaveCount(0)
  })

  test('codex: a TOML edit replaces one line, keeps its comment, and leaves arrays and tables alone', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const before = await readCodexConfig(home)
    const section = await openEnginesSection(page)
    await waitForEngineRows(section, 'codex')

    await expect(row(section, 'model_reasoning_effort')).toHaveAttribute('data-source', 'file')
    await expect(control(section, 'codex', 'model_reasoning_effort')).toHaveValue('max')
    await control(section, 'codex', 'model_reasoning_effort').selectOption('high')

    await expect.poll(async () => (await readCodexConfig(home)).includes('model_reasoning_effort = "high" # keep this comment')).toBe(true)
    const after = await readCodexConfig(home)
    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    expect(afterLines.length).toBe(beforeLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].startsWith('model_reasoning_effort')) continue
      // The WebKit spec shares this fixture file and may flip this key at any moment.
      if (beforeLines[i].startsWith('check_for_update_on_startup')) continue
      expect(afterLines[i], `line ${i + 1}`).toBe(beforeLines[i])
    }

    // A key absent from the file lands at the end of the top-level block, before the table.
    await expect(row(section, 'model_provider')).toHaveAttribute('data-source', 'default')
    const provider = control(section, 'codex', 'model_provider')
    await provider.fill('acme-bedrock')
    await provider.press('Enter')
    await expect.poll(async () => (await readCodexConfig(home)).includes('model_provider = "acme-bedrock"\n\n[projects."/Users/example"]')).toBe(true)
  })

  test('a refused save reverts the control; a save the server cannot vouch for reloads the truth instead', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const section = await openEnginesSection(page)
    await waitForEngineRows(section, 'claude')

    const verbose = control(section, 'claude', 'verbose')
    await expect(verbose).toHaveAttribute('aria-checked', 'false')
    let reloads = 0
    let failure: { status: number; body: Record<string, unknown> } = {
      status: 409, body: { error: 'refusing to write ~/.claude/settings.json: not valid JSON', outcome: 'not-written' },
    }
    await page.route('**/api/engines/claude/settings?*', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify(failure.body) })
        return
      }
      reloads++
      await route.fallback()
    })
    // Refused before any byte moved: the toggle goes back, nothing is re-read.
    await verbose.click()
    const banner = section.getByTestId('engine-settings-banner')
    await expect(banner).toContainText('not valid JSON')
    await expect(verbose).toHaveAttribute('aria-checked', 'false')
    expect(reloads).toBe(0)

    // The daemon may have written before the tunnel died: reverting would show
    // the opposite of the disk, so the section reads the file again and keeps
    // the banner up while it does.
    failure = { status: 502, body: { error: 'could not write ~/.claude/settings.json: socket closed', outcome: 'unknown' } }
    await verbose.click()
    await expect(banner).toContainText('socket closed')
    await expect.poll(() => reloads).toBe(1)
    await expect(verbose).toHaveAttribute('aria-checked', 'false')
    await expect(banner).toContainText('socket closed')
    expect((await readClaudeSettings(home)).verbose).toBe(false)
    await page.unroute('**/api/engines/claude/settings?*')
  })

  test('an unknown host is refused with a 400, an engine without settings with a 404', async ({ request }) => {
    const badHost = await request.get('/api/engines/claude/settings?host=no-such-host')
    expect(badHost.status()).toBe(400)
    expect((await badHost.json()).error).toContain('no-such-host')
    const noSurface = await request.get('/api/engines/gemini/settings')
    expect(noSurface.status()).toBe(404)
    const badValue = await request.patch('/api/engines/claude/settings', { data: { set: { 'permissions.defaultMode': 'yolo' } } })
    expect(badValue.status()).toBe(400)
    expect((await badValue.json()).error).toMatch(/must be one of/)
  })
})
