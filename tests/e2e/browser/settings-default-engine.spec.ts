/**
 * Settings → Sessions: "Default engine", the first row of the pane (it headed
 * the Engines pane until that pane was retired on 2026-10-27).
 *
 * One control, three things a unit test cannot see: it shows what the config
 * actually says (not an optimistic local value), merely OPENING the page writes
 * nothing, and a pick survives a real navigation away and back while the sibling
 * `defaults` keys live — the default task priority and the default project sit
 * under the same config key this writes, and `updateConfig` replaces that key
 * whole.
 *
 * Deliberately NOT asserted here: which engine a launch then runs on. That is
 * pinned server-side (tests/web/routes/quick-start-default-engine.test.ts) where
 * SESSION_START can be read directly; a browser spec would have to spawn a real
 * ACP adapter to say anything about it.
 *
 * The WebKit half (settings-default-engine.webkit.spec.ts) is read-only on
 * purpose: both files run in ONE Playwright invocation against one fixture
 * server, and two files writing the same config key would race.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { openSessionsSection } from './engine-settings-helpers'

const ROW_SHOT_DIR = '/tmp/settings-redesign'

test.describe.configure({ mode: 'serial' })
// A cold SPA navigation under machine load has eaten 27s of the default budget.
test.setTimeout(90_000)

/** The config as the server reports it — the only authority on what was saved. */
async function serverDefaults(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: { defaults?: Record<string, unknown> } }
  return body.config?.defaults ?? {}
}

/** Real SPA navigation back to Settings → Sessions (never a page.goto for nav). */
async function reopenSessionsSection(page: Page) {
  await page.locator('.sidebar-nav a[href="/"]').click()
  await expect(page.locator('#sessions')).toHaveCount(0)
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-sessions').click()
  const section = page.locator('#sessions')
  await expect(section).toBeVisible()
  return section
}

/** The config's `session` block as the server reports it. */
async function serverSession(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: { session?: Record<string, unknown> } }
  return body.config?.session ?? {}
}

/**
 * The picker is a segmented control while there are five engines or fewer and
 * a select beyond that; both carry testid `default-engine-select`.
 */
const picker = (section: ReturnType<Page['locator']>) => section.getByTestId('default-engine-select')
const isSelect = async (section: ReturnType<Page['locator']>) =>
  (await picker(section).evaluate((el) => el.tagName)) === 'SELECT'

async function expectDefault(section: ReturnType<Page['locator']>, id: string) {
  if (await isSelect(section)) {
    await expect(picker(section)).toHaveValue(id)
    return
  }
  await expect(picker(section)).toHaveAttribute('data-value', id)
  await expect(section.getByTestId(`default-engine-option-${id}`)).toHaveAttribute('aria-checked', 'true')
}

async function pick(section: ReturnType<Page['locator']>, id: string) {
  if (await isSelect(section)) await picker(section).selectOption(id)
  else await section.getByTestId(`default-engine-option-${id}`).click()
}

async function optionList(section: ReturnType<Page['locator']>): Promise<Array<{ value: string; label: string }>> {
  if (await isSelect(section)) {
    return picker(section).locator('option').evaluateAll((nodes) => nodes.map((n) => ({
      value: (n as HTMLOptionElement).value, label: n.textContent ?? '',
    })))
  }
  return picker(section).locator('[role="radio"]').evaluateAll((nodes) => nodes.map((n) => ({
    value: (n.getAttribute('data-testid') ?? '').replace('default-engine-option-', ''), label: n.textContent ?? '',
  })))
}

test.describe('Settings → Sessions → default engine', () => {
  test('shows the configured engine, says what it is for, and writes nothing on open', async ({ page, request }) => {
    const before = await serverDefaults(request)
    const section = await openSessionsSection(page)
    await expect(picker(section)).toBeVisible()
    // No key in the config = Claude (the default lives at the reader).
    await expectDefault(section, (before.engine as string | undefined) ?? 'claude')
    // Opening a section must never rewrite the config: the control saves only on a pick.
    expect(await serverDefaults(request)).toEqual(before)

    await expect(section).toContainText('Default engine')
    // One engine for everything Walnut starts: coding sessions AND its chats.
    await expect(section.getByTestId('default-engine-used-for'))
      .toHaveText('Everything Walnut starts uses it; a session can still pick its own.')
    await expect(section.getByTestId('default-engine-row').locator('xpath=ancestor::*[contains(@class,"form-group")]')).toHaveCount(0)
    // It is the first row of the Sessions pane, above Idle timeout.
    expect(await section.evaluate((el) => {
      const rows = Array.from(el.querySelectorAll('[data-testid="default-engine-row"], #idle-timeout'))
      return rows.map((r) => r.getAttribute('data-testid') ?? r.id)
    })).toEqual(['default-engine-row', 'idle-timeout'])
    await section.getByTestId('default-engine-row').screenshot({ path: `${ROW_SHOT_DIR}/sessions-default-engine.png` })

    // Every option is a distinct engine the catalog reported, Claude included,
    // and nothing is offered that the row itself marks as missing.
    const options = await optionList(section)
    expect(options.map((o) => o.value)).toContain('claude')
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length)
    expect(options.filter((o) => o.label.includes('not installed'))).toEqual([])
  })

  test('a pick is saved, keeps the sibling defaults, and survives leaving the page', async ({ page, request }) => {
    const section = await openSessionsSection(page)
    // A second engine has to exist for this to mean anything; the fixture ships
    // codex in its catalog.
    // The list fills in once the engine catalog answers.
    await expect.poll(async () => (await optionList(section)).map((o) => o.value), { timeout: 15_000 }).toContain('codex')
    const before = await serverDefaults(request)

    await pick(section, 'codex')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('codex')
    // Off Claude Code, the row says where small background jobs run.
    const smallJobs = section.getByTestId('default-engine-small-jobs')
    await expect(smallJobs).toHaveText(/^Small background jobs (stay on Claude Code\.|use an API instead \(Advanced\)\.)$/)
    // The siblings under `defaults` are what a whole-key replace would have eaten.
    const after = await serverDefaults(request)
    for (const key of Object.keys(before)) {
      if (key === 'engine') continue
      expect(after[key], key).toEqual(before[key])
    }

    // Leave and come back through real clicks: the row renders from the config,
    // so this is the assertion that the value was persisted, not just displayed.
    const reopened = await reopenSessionsSection(page)
    await expectDefault(reopened, 'codex')

    // Back to Claude, so every later spec in this fixture launches on what it expects.
    await pick(reopened, 'claude')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('claude')
    // Back on Claude Code, only an API main provider leaves a note.
    const note = reopened.getByTestId('default-engine-small-jobs')
    if (await note.count()) await expect(note).toHaveText('Small background jobs use an API instead (Advanced).')
  })

  test('a pick and the Sessions rows under it both save (one pane, two config keys)', async ({ page, request }) => {
    const section = await openSessionsSection(page)
    const sessionBefore = await serverSession(request)
    await expect.poll(async () => (await optionList(section)).map((o) => o.value), { timeout: 15_000 }).toContain('codex')
    await pick(section, 'codex')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('codex')
    // Idle timeout writes `session`, the picker wrote `defaults`: neither save
    // may undo the other (both go through the pane's one serial save).
    const idle = section.locator('#idle-timeout')
    await idle.fill('47')
    await idle.press('Enter')
    await expect.poll(async () => (await serverSession(request)).idle_timeout_minutes).toBe(47)
    expect((await serverDefaults(request)).engine).toBe('codex')
    await expectDefault(section, 'codex')
    // Put both back, so every later spec in this fixture starts from the seed.
    const original = sessionBefore.idle_timeout_minutes as number | undefined
    await idle.fill(original === undefined ? '' : String(original))
    await idle.press('Enter')
    await expect.poll(async () => (await serverSession(request)).idle_timeout_minutes).toBe(original)
    await pick(section, 'claude')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('claude')
    expect((await serverSession(request)).idle_timeout_minutes).toBe(original)
  })

  test('an old #engines link lands on the Sessions pane, at the default engine', async ({ page }) => {
    // A bookmark, typed into the address bar: the one place a direct load is the user's path.
    await page.goto('/settings#engines')
    const section = page.locator('#sessions')
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(section.getByTestId('default-engine-row')).toBeVisible()
    await expect(page.locator('#engines')).toHaveCount(0)
    await expect(page.getByTestId('settings-nav-engines')).toHaveCount(0)
  })
})
