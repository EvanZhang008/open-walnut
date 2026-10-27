/**
 * /settings Configure panes after the redesign (General, Tasks, Sessions,
 * Hooks, Advanced + API provider, Triage, Search, Voice): rows, save
 * feedback, failures, sizes and copy. Engines, Integrations and Heartbeat
 * were removed on 2026-10-27; the default engine row now heads Sessions.
 *
 * Runs in both engines against one fixture: Chromium by default, WebKit (the
 * Mac app is a WKWebView) with `PW_WEBKIT=1 ... --project=webkit`. Every pane
 * switch is a real nav click; page.goto is only the first load.
 *
 * Most tests route /api/config through an in-memory copy (fakeConfig): GET
 * answers the copy, PUT merges top-level keys into it (like the server) or
 * fails on demand. So nothing here changes the fixture config other specs
 * read, except C77, which needs a real cross-context round trip and restores
 * what it changed.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

type Json = Record<string, any>
const SECTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../web/src/components/settings/sections')
const src = (file: string) => readFileSync(join(SECTIONS_DIR, file), 'utf8')

interface FakeConfig {
  state: () => Json
  puts: Json[]
  /** Next PUTs answer 500 while true. */
  failPuts: (on: boolean) => void
  /** Hold every PUT this long before answering (a slow disk). */
  delayPuts: (ms: number) => void
  /** Every GET and PUT, with the PUT's top-level keys (a debug aid). */
  gets: () => unknown[]
}

/**
 * Serve /api/config from memory. `seed` edits the fixture's real config once;
 * a PUT merges its top-level keys (updateConfig semantics) unless failing.
 */
async function fakeConfig(page: Page, seed: (c: Json) => void = () => {}): Promise<FakeConfig> {
  let state: Json | null = null
  let failing = false
  let delay = 0
  const puts: Json[] = []
  const gets: unknown[] = []
  // no-store like the real server: WebKit's HTTP cache otherwise answers a
  // repeat GET from memory and the page reads a config from before its save.
  const headers = { 'cache-control': 'no-store' }
  await page.route('**/api/config', async (route: Route) => {
    try {
      const req = route.request()
      if (state === null) {
        const res = await route.fetch({ method: 'GET' })
        const body = await res.json() as Json
        state = body
        seed(state.config)
      }
      if (req.method() === 'GET') {
        gets.push(`${Date.now() % 100000} GET`)
        return await route.fulfill({ json: state, headers })
      }
      if (req.method() === 'PUT') {
        const patch = req.postDataJSON() as Json
        puts.push(patch)
        gets.push(`${Date.now() % 100000} PUT ${Object.keys(patch).join(',')}`)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        if (failing) return await route.fulfill({ status: 500, json: { error: 'disk full' }, headers })
        state = { ...state, config: { ...state!.config, ...patch } }
        return await route.fulfill({ json: { ok: true }, headers })
      }
      return await route.fallback()
    } catch {
      // The page closed with a read in flight (the app polls /api/config).
    }
  })
  return { state: () => state?.config ?? {}, puts, failPuts: (on) => { failing = on }, delayPuts: (ms) => { delay = ms }, gets: () => gets }
}

async function openSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string, sectionId = id) {
  const item = page.getByTestId(`settings-nav-${id}`)
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator(`[id="${sectionId}"].settings-section`)).toBeVisible({ timeout: 20_000 })
  return page.locator(`[id="${sectionId}"].settings-section`)
}

/** The row (article) whose label is exactly `label`, inside `scope`. */
function row(scope: ReturnType<Page['locator']>, label: string) {
  return scope.locator('.settings-row').filter({
    has: scope.page().locator('.settings-row-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).first()
}

/** Watch the Saved indicator for the rest of the page's life. */
async function recordSaved(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __saved: string[] }
    w.__saved = []
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="settings-saved-indicator"]')
      const t = el?.textContent?.trim()
      if (t && w.__saved[w.__saved.length - 1] !== t) w.__saved.push(t)
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { __saved: string[] }).__saved)
}

const indicator = (page: Page) => page.getByTestId('settings-saved-indicator')

// Drop the fakes before the page closes: the app keeps polling /api/config.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

test('runs in the engine it was asked for', async ({ browserName }) => {
  expect(browserName).toBe(process.env.PW_WEBKIT ? 'webkit' : 'chromium')
})

test('C12: a config switch shows Saved for about 2s; a window-only switch never writes', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => { c.ui = { ...c.ui, show_priority: false } })
  await openSettings(page)
  const general = await clickNav(page, 'general')
  const focus = row(general, 'Focus bar')
  // F13 N16: the pref is synced by ui-prefs and read on load, so the help says other
  // windows follow when they next open, never "this window only".
  await expect(focus.locator('.settings-row-help')).toContainText('other windows follow when they next open')
  const putsBefore = cfg.puts.length
  await focus.getByRole('switch').click()
  await page.waitForTimeout(1_500)
  expect(cfg.puts.length).toBe(putsBefore)
  await expect(indicator(page)).toHaveCount(0)
  await focus.getByRole('switch').click() // restore this window's dock

  const tasks = await clickNav(page, 'tasks')
  const putDone = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'PUT')
  await tasks.locator('#settings-show-priority').click()
  await putDone
  const shownAt = Date.now()
  await expect(indicator(page)).toHaveText(/Saved/, { timeout: 1_000 })
  await page.waitForTimeout(Math.max(0, 1_900 - (Date.now() - shownAt)))
  await expect(indicator(page)).toHaveCount(1)
  await expect(indicator(page)).toHaveCount(0, { timeout: 1_300 })
  expect(Date.now() - shownAt).toBeLessThan(3_300)
  expect(cfg.state().ui.show_priority).toBe(true)
})

test('C13 + C68: a failed switch reverts, says why under the row, and the row stays put', async ({ page }) => {
  const cfg = await fakeConfig(page)
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  const saved = await recordSaved(page)
  const target = row(sessions, 'Intercept permission prompts')
  const sw = target.getByRole('switch')
  const before = await sw.getAttribute('aria-checked')
  cfg.failPuts(true)
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', before!, { timeout: 10_000 })
  const alert = sessions.locator('.settings-row-error[role="alert"]')
  await expect(alert).toContainText("Couldn't save")
  await expect(indicator(page)).toHaveText(/Not saved/)
  expect(await saved()).not.toContain('Saved')

  // C68: the error is never timed, so the rows under it never move.
  const next = row(sessions, 'Auto approve in bypass mode')
  const box1 = await next.boundingBox()
  await page.waitForTimeout(7_000)
  await expect(alert).toBeVisible()
  const box2 = await next.boundingBox()
  expect(box2!.y).toBeCloseTo(box1!.y, 0)
  cfg.failPuts(false)
  await sw.click()
  await expect(alert).toHaveCount(0, { timeout: 10_000 })
})

test('C57 (source half): General saves only through onSave, never updateConfig or uncontrolled inputs', async () => {
  // The Chat notifications rows this test drove were removed (2026-10-27); the
  // rule they proved still holds for every row General keeps.
  const code = src('GeneralSection.tsx')
  expect(code).not.toContain('updateConfig(')
  expect(code).not.toContain('defaultChecked')
})

/** Open every disclosure row of the visible pane (Advanced has them). */
async function expandAll(page: Page) {
  for (let i = 0; i < 20; i++) {
    const closed = page.locator('.settings-pane button[aria-expanded="false"].settings-disclosure-row:visible')
    if (await closed.count() === 0) return
    await closed.first().click()
  }
}

const CONFIGURE_PANES = ['general', 'tasks', 'sessions', 'hooks', 'advanced', 'triage', 'search', 'stt']

test('C14 + C19 + C20: every boolean is a switch; no stray checkbox, form-group, details or emoji', async ({ page }) => {
  await fakeConfig(page)
  await openSettings(page)
  for (const pane of CONFIGURE_PANES) {
    await clickNav(page, pane)
    await page.waitForTimeout(400)
    await expandAll(page)
    const report = await page.evaluate(() => {
      const root = document.querySelector('.settings-pane') ?? document.body
      const stray = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((el) =>
        !el.closest('.settings-checklist') && el.getAttribute('aria-hidden') !== 'true' && !el.classList.contains('settings-visually-hidden'))
      const text = (root as HTMLElement).innerText
      return {
        stray: stray.map((el) => el.id || el.name || el.outerHTML.slice(0, 80)),
        formGroups: root.querySelectorAll('.form-group').length,
        details: root.querySelectorAll('details.settings-collapsible').length,
        emoji: (text.match(/\p{Extended_Pictographic}/gu) ?? []).join(''),
      }
    })
    expect(report, pane).toEqual({ stray: [], formGroups: 0, details: 0, emoji: '' })
  }
})

test('C15: every control sits right of its label at the group edge (14px inset)', async ({ page }) => {
  await fakeConfig(page, (c) => { c.ui = { ...c.ui, show_priority: true } })
  await openSettings(page)
  for (const pane of ['general', 'tasks', 'sessions', 'advanced']) {
    await clickNav(page, pane)
    await page.waitForTimeout(400)
    await expandAll(page)
    const bad = await page.evaluate(() => {
      const out: string[] = []
      for (const r of Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-group .settings-row'))) {
        if (r.offsetParent === null || r.classList.contains('settings-row-stacked') || r.classList.contains('settings-checkbox-row')) continue
        const actions = r.querySelector<HTMLElement>(':scope > .settings-row-actions')
        const label = r.querySelector<HTMLElement>(':scope > .settings-row-copy .settings-row-label')
        const group = r.closest<HTMLElement>('.settings-group')
        if (!actions || !label || !group || r.dataset.wide === 'true') continue
        const a = actions.getBoundingClientRect()
        const g = group.getBoundingClientRect()
        const l = label.getBoundingClientRect()
        if (Math.abs(a.right - (g.right - 1 - 14)) > 1.5) out.push(`${label.textContent}: right ${a.right} vs ${g.right - 15}`)
        if (a.left < l.right - 0.5) out.push(`${label.textContent}: control left of label`)
      }
      return out
    })
    expect(bad, pane).toEqual([])
  }
})

test('C30: input sizes and units', async ({ page }) => {
  await fakeConfig(page)
  await openSettings(page)
  const width = (sel: string) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().width)
  await clickNav(page, 'general')
  expect(Math.abs(await width('#settings-name') - 240)).toBeLessThanOrEqual(4)
  const sessions = await clickNav(page, 'sessions')
  expect(Math.abs(await width('#idle-timeout') - 120)).toBeLessThanOrEqual(4)
  await expect(row(sessions, 'Idle timeout').locator('.settings-input-unit')).toHaveText('minutes')
  const advanced = await clickNav(page, 'advanced')
  await advanced.getByTestId('advanced-disclosure-sdk').click()
  expect(Math.abs(await width('#sdk-port') - 120)).toBeLessThanOrEqual(4)
  await expect(page.locator('#sdk-port')).not.toHaveValue(/,/)
})

test('C31: hooks are roomy rows with a level chevron; the label discloses Fires on, Action and Order', async ({ page }) => {
  await openSettings(page)
  const hooks = await clickNav(page, 'hooks')
  await expect(hooks.locator('.hook-row').first()).toBeVisible({ timeout: 20_000 })
  const n = await hooks.locator('.hook-row').count()
  const height = await hooks.locator('.settings-card-body').evaluate((el) => el.getBoundingClientRect().height)
  const rowHeights = await hooks.locator('.hook-row').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  // N23: an empty "Your hooks" is a real 44px empty row in a group, like every pane's.
  const emptyRows = await hooks.locator('.settings-empty').count()
  expect(height, `rows ${rowHeights.join(',')}`).toBeLessThanOrEqual(140 + 60 * (n + emptyRows))
  const first = hooks.locator('.hook-row').first()
  // Not a wall: every row has air around its two lines, and the chevron sits
  // level with the switch beside it (both centered on the row), not on the
  // name line above it.
  for (const h of rowHeights) expect(h, `rows ${rowHeights.join(',')}`).toBeGreaterThanOrEqual(56)
  const level = await first.evaluate((row) => {
    const mid = (el: Element | null) => { const r = el!.getBoundingClientRect(); return r.top + r.height / 2 }
    const copy = row.querySelector('.settings-row-copy')!.getBoundingClientRect()
    const help = row.querySelector('.settings-row-help')!.getBoundingClientRect()
    const label = row.querySelector('.settings-row-label')!.getBoundingClientRect()
    return {
      chevronVsSwitch: Math.abs(mid(row.querySelector('.settings-disclosure-chevron')) - mid(row.querySelector('.settings-row-actions > *'))),
      topAir: label.top - row.getBoundingClientRect().top,
      bottomAir: row.getBoundingClientRect().bottom - help.bottom,
      copyH: copy.height,
    }
  })
  expect(level.chevronVsSwitch, JSON.stringify(level)).toBeLessThanOrEqual(2)
  expect(level.topAir, JSON.stringify(level)).toBeGreaterThanOrEqual(8)
  expect(level.bottomAir, JSON.stringify(level)).toBeGreaterThanOrEqual(8)
  await expect(first.locator('.settings-row-help')).toHaveCSS('white-space', 'nowrap')
  const disclose = first.locator('.hook-row-disclose')
  await expect(disclose).toHaveAttribute('aria-expanded', 'false')
  await disclose.click()
  await expect(disclose).toHaveAttribute('aria-expanded', 'true')
  const details = page.locator(`#${await disclose.getAttribute('aria-controls')}`)
  await expect(details.locator('.settings-row-label', { hasText: /^Order$/ })).toBeVisible()
  await expect(details.locator('.settings-row-label', { hasText: /^(Fires on|Action)$/ }).first()).toBeVisible()
  await disclose.click()
  await expect(disclose).toHaveAttribute('aria-expanded', 'false')
  if (await hooks.getByTestId('hooks-group-yours').locator('.hook-row').count() === 0) {
    await expect(hooks.getByTestId('hooks-group-yours')).toContainText('No hooks of your own yet.')
  }
})

test('C34: session modes are six styled checkboxes; the last one cannot be unticked', async ({ page }) => {
  await fakeConfig(page, (c) => { c.session = { ...c.session, enabled_modes: ['plan', 'auto'] } })
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  const modes = sessions.getByTestId('session-modes')
  await expect(modes.locator('.settings-checkbox-row')).toHaveCount(6)
  expect(await modes.innerText()).not.toMatch(/\p{Extended_Pictographic}/u)
  await modes.getByTestId('session-mode-auto').uncheck()
  const plan = modes.getByTestId('session-mode-plan')
  await expect(plan).toBeChecked()
  await expect(plan).toBeDisabled()
  await expect(modes.locator('.settings-checkbox-row', { has: page.getByTestId('session-mode-plan') })).toHaveAttribute('title', 'Keep at least one mode.')
  await expect(sessions.locator('#session-output-mode[role="radiogroup"] [role="radio"]')).toHaveCount(2)
})

test('C35: Advanced opens with four closed disclosures; an open one survives a pane switch', async ({ page }) => {
  await fakeConfig(page)
  // Keep awake is macOS only and hides itself when its route says unsupported
  // (this fixture may run on Linux): answer as a Mac would, so the count is fixed.
  const kaState = { supported: true, enabled: false, holding: false, reason: 'off', runningLocalSessions: 0, battery: null, online: true, needsSudo: false, setupDone: true, checkedAt: null }
  await page.route('**/api/keep-awake**', (route) => route.fulfill({ json: { state: kaState, sudoSetupCommand: '' } }))
  await openSettings(page)
  await page.evaluate(() => { for (const k of Object.keys(sessionStorage)) if (k.startsWith('walnut.settings.disclosure.')) sessionStorage.removeItem(k) })
  const advanced = await clickNav(page, 'advanced')
  const rows = advanced.getByTestId('advanced-group').locator(':scope > .settings-disclosure-row')
  // Git versioning, Keep awake, SDK session server, Raw config (Command safety
  // and Subagent defaults were removed on 2026-10-27).
  await expect(rows).toHaveCount(4)
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))))
    .toEqual(['advanced-disclosure-git', 'advanced-disclosure-keep-awake', 'advanced-disclosure-sdk', 'advanced-disclosure-raw'])
  for (let i = 0; i < 4; i++) await expect(rows.nth(i)).toHaveAttribute('aria-expanded', 'false')
  const git = advanced.getByTestId('advanced-disclosure-git')
  await git.click()
  await expect(git).toHaveAttribute('aria-expanded', 'true')
  const content = page.locator(`#${await git.getAttribute('aria-controls')}`)
  await expect(content.locator('.settings-row').first()).toBeVisible()
  expect(await content.locator('.settings-group').count()).toBe(0)
  const inset = await content.locator('.settings-row').first().evaluate((el) => getComputedStyle(el).paddingLeft)
  expect(parseFloat(inset)).toBeGreaterThanOrEqual(30)
  await clickNav(page, 'general')
  const again = await clickNav(page, 'advanced')
  await expect(again.getByTestId('advanced-disclosure-git')).toHaveAttribute('aria-expanded', 'true')
})

test('C56: flipping one switch in a folded form keeps every other field (FormData reads collapsed rows)', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => {
    c.git_versioning = { enabled: true, push_enabled: false, commit_debounce_ms: 45000, push_interval_ms: 700000 }
    c.keep_awake = { ...c.keep_awake, enabled: true, battery_floor_pct: 25 }
    c.session_server = { ...c.session_server, enabled: true, port: 7891 }
    c.tools = { ...c.tools, exec: { ...c.tools?.exec, timeout: 12345, max_output: 5000 } }
    c.agent = { ...c.agent, subagent: { ...c.agent?.subagent, max_concurrent: 7, max_tool_rounds: 9 } }
  })
  await page.route('**/api/keep-awake**', (route) => route.fulfill({ status: 404, json: { error: 'n/a' } }))
  await openSettings(page)
  await page.evaluate(() => { for (const k of Object.keys(sessionStorage)) if (k.startsWith('walnut.settings.disclosure.')) sessionStorage.removeItem(k) })
  const advanced = await clickNav(page, 'advanced')
  await advanced.getByTestId('advanced-disclosure-git').click()
  const before = cfg.puts.length
  await row(advanced, 'Push to remote').getByRole('switch').click()
  await expect.poll(() => cfg.puts.length, { timeout: 10_000 }).toBeGreaterThan(before)
  const put = cfg.puts[cfg.puts.length - 1]
  expect(put.git_versioning.enabled).toBe(true)
  expect(put.git_versioning.push_enabled).toBe(true)
  expect(put.git_versioning.commit_debounce_ms).toBe(45000)
  expect(put.session_server.enabled).toBe(true)
  expect(put.session_server.port).toBe(7891)
  // Advanced no longer owns `tools` or `agent`: it never writes them, so the
  // values another surface keeps there survive untouched.
  expect(put.tools).toBeUndefined()
  expect(put.agent).toBeUndefined()
  expect(cfg.state().tools.exec.timeout).toBe(12345)
  expect(cfg.state().agent.subagent.max_concurrent).toBe(7)
  // Keep awake's rows are hidden (route 404 = unsupported?) or collapsed; either way its value survives.
  expect(put.keep_awake?.enabled ?? cfg.state().keep_awake.enabled).toBe(true)
})

test('C71: unset idle numbers stay empty and are never written back as a guess', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => {
    const { idle_timeout_minutes: _a, max_idle: _b, ...rest } = c.session ?? {}
    c.session = rest
  })
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  await expect(page.locator('#idle-timeout')).toHaveValue('')
  await expect(page.locator('#idle-timeout')).toHaveAttribute('placeholder', '60')
  await expect(page.locator('#max-idle')).toHaveValue('')
  await expect(page.locator('#max-idle')).toHaveAttribute('placeholder', '30')
  await expect(row(sessions, 'Idle timeout').locator('.settings-row-help')).toContainText('60 here and 120 on remote hosts')
  await sessions.locator('#permission-prompt').click()
  await expect.poll(() => cfg.puts.length, { timeout: 10_000 }).toBeGreaterThan(0)
  const put = cfg.puts[cfg.puts.length - 1]
  expect(put.session.idle_timeout_minutes).toBeUndefined()
  expect(put.session.max_idle).toBeUndefined()
  expect(src('SessionsSection.tsx')).not.toContain('Between 0 and 1440')
  expect(src('SessionsSection.tsx')).not.toMatch(/\?\? 30\b/)
})

test('C60: a typed number saves when the pane is left 200ms later; a failure marks the pane', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => { c.session = { ...c.session, idle_timeout_minutes: 30 } })
  await openSettings(page)
  await clickNav(page, 'sessions')
  const saved = await recordSaved(page)
  await page.locator('#idle-timeout').fill('42')
  await page.getByTestId('settings-nav-tasks').click()
  await expect.poll(() => cfg.puts.some((p) => p.session?.idle_timeout_minutes === 42), { timeout: 10_000 }).toBe(true)
  await expect(page.locator('#tasks.settings-section')).toBeVisible()
  await page.waitForTimeout(2_500)
  expect(await saved()).not.toContain('Saved')

  cfg.failPuts(true)
  await clickNav(page, 'sessions')
  await page.locator('#idle-timeout').fill('43')
  await page.getByTestId('settings-nav-tasks').click()
  await expect(page.getByTestId('settings-nav-error-sessions')).toBeVisible({ timeout: 10_000 })
  await clickNav(page, 'sessions')
  await expect(page.locator('#idle-timeout-row + .settings-row-error[role="alert"]')).toContainText("Couldn't save")
})

test('C61: Default engine heads Sessions, is one sentence; the small-jobs warning only when it applies; segments are radios', async ({ page }) => {
  await fakeConfig(page, (c) => {
    c.agent = { ...c.agent, main_provider: 'claude_cli' }
    c.defaults = { ...c.defaults, engine: 'claude' }
  })
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  const def = row(sessions, 'Default engine')
  await expect(def).toHaveAttribute('data-testid', 'default-engine-row')
  // The first row of the pane.
  await expect(sessions.locator('.settings-row').first()).toHaveAttribute('data-testid', 'default-engine-row')
  await expect(def.getByTestId('default-engine-used-for')).toHaveText("Everything Walnut starts uses it; a session can still pick its own.")
  await expect(sessions.getByText('Small background jobs')).toHaveCount(0)
  // Segments (radios) for five engines or fewer, a select beyond that; either
  // way Claude Code is the picked one.
  const picker = def.getByTestId('default-engine-select')
  await expect(picker).toBeVisible()
  if (await picker.evaluate((el) => el.tagName) === 'SELECT') {
    await expect(picker).toHaveValue('claude')
    await expect(picker.locator('option[value="claude"]')).toHaveText('Claude Code')
  } else {
    const claude = def.getByTestId('default-engine-option-claude')
    await expect(claude).toHaveAttribute('role', 'radio')
    await expect(claude).toHaveAttribute('aria-checked', 'true')
  }
  // No per-engine settings anywhere in Settings: they live in the session's popover.
  await expect(page.locator('[data-testid^="engine-settings-tab-"], [data-testid="engine-settings-host"], .engine-setting-row')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-engines')).toHaveCount(0)
})

test('C61: an API in use shows the small-jobs warning in warning colour', async ({ page }) => {
  await fakeConfig(page, (c) => { c.agent = { ...c.agent, main_provider: 'anthropic' } })
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  const warn = sessions.getByTestId('default-engine-small-jobs')
  await expect(warn).toContainText('Small background jobs use an API instead')
  const [color, expected] = await warn.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--priority-important-text)'
    el.appendChild(probe)
    const out = [getComputedStyle(el).color, getComputedStyle(probe).color]
    probe.remove()
    return out
  })
  expect(color).toBe(expected)
})

const JEV_ON = (c: Json) => {
  c.jev = { ...c.jev, api_key: '${file:secrets/jev.key}', decisions: { quick_parse: true, session_organize: true } }
}

test('C63: Tasks rows, the after-session group and the triage label in General', async ({ page }) => {
  await fakeConfig(page, (c) => { c.ui = { ...c.ui, show_priority: false } })
  await openSettings(page)
  const tasks = await clickNav(page, 'tasks')
  await expect(row(tasks, 'Default priority')).toHaveCount(0)
  await tasks.locator('#settings-show-priority').click()
  await expect(row(tasks, 'Default priority')).toBeVisible()
  const after = tasks.getByTestId('tasks-after-session')
  await expect(after).toContainText('After a session finishes')
  // Off and Right away (On heartbeat went with the heartbeat, 2026-10-27).
  await expect(after.locator('#triage-notify-mode[role="radiogroup"] [role="radio"]')).toHaveCount(2)
  await expect(after.getByTestId('triage-notify-buffered')).toHaveCount(0)
  await expect(row(after, 'Tell Ask Walnut')).toBeVisible()
  await expect(row(after, 'Wait before summarizing')).toBeVisible()
  expect(await tasks.innerText()).not.toContain('Default engine')

  // C83: an unknown project name warns in the help line.
  const project = page.locator('#settings-project')
  await project.fill('No such project anywhere 9f2')
  await expect(row(tasks, 'Default project').locator('.settings-row-help')).toContainText('No project named "No such project anywhere 9f2" yet')
  await expect(row(tasks, 'Default project')).toHaveAttribute('data-state', 'warning')
  await project.press('Escape')

  // General's Chat notifications group (where the triage label sat) is gone.
  const general = await clickNav(page, 'general')
  await expect(row(general, 'Session triage results')).toHaveCount(0)
})

test('C76: Uses names the resolved runner; .check() on both segments switches and saves', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => {
    c.agent = { ...c.agent, main_provider: 'claude_cli' }
    c.jev = { ...c.jev, decisions: { quick_parse: false, session_organize: false } }
  })
  await openSettings(page)
  const tasks = await clickNav(page, 'tasks')
  const card = tasks.getByTestId('smart-task-creation')
  await expect(card.getByTestId('smart-runner-default')).toHaveText('Claude Code')
  await expect(card.getByTestId('smart-runner-default')).toBeChecked()
  const n = cfg.puts.length
  await card.getByTestId('smart-runner-jev').check()
  await expect(card.getByTestId('jev-settings')).toBeVisible()
  await expect.poll(() => cfg.puts.slice(n).some((p) => p.jev?.decisions?.quick_parse === true), { timeout: 10_000 }).toBe(true)
  await card.getByTestId('smart-runner-default').check()
  await expect(card.getByTestId('jev-settings')).toHaveCount(0)
  await expect.poll(() => cfg.puts.slice(n).some((p) => p.jev?.decisions?.quick_parse === false), { timeout: 10_000 }).toBe(true)
})

test('C76: with an API in effect the first segment is that API', async ({ page }) => {
  await fakeConfig(page, (c) => { c.agent = { ...c.agent, main_provider: 'anthropic' } })
  await openSettings(page)
  const tasks = await clickNav(page, 'tasks')
  await expect(tasks.getByTestId('smart-runner-default')).toHaveText('Anthropic')
  await expect(row(tasks, 'Uses').locator('.settings-row-help')).toHaveText('Slow: each guess calls Anthropic once.')
})

test('C53 + C54 + C58 + C79: Jev test result, two-step Remove, no native dialogs, widths hold', async ({ page }) => {
  await fakeConfig(page, JEV_ON)
  let testCalls = 0
  await page.route('**/api/jev/test', async (route) => {
    testCalls += 1
    await new Promise((r) => setTimeout(r, 400))
    return route.fulfill({ json: testCalls === 1 ? { ok: true, ms: 238, model: 'jev-latest' } : { ok: false, error: 'bad key' } })
  })
  const deletes: string[] = []
  await page.route('**/api/jev/key', (route) => {
    if (route.request().method() === 'DELETE') deletes.push(route.request().url())
    return route.fulfill({ json: { ok: true } })
  })
  page.on('dialog', (d) => { throw new Error(`native dialog opened: ${d.message()}`) })
  await openSettings(page)
  const tasks = await clickNav(page, 'tasks')
  const jev = tasks.getByTestId('jev-settings')
  await expect(row(jev, 'Jev model')).toBeVisible()

  const btn = jev.getByTestId('jev-test')
  const b1 = await btn.boundingBox()
  await btn.click()
  await expect(btn).toContainText('Testing...')
  const b2 = await btn.boundingBox()
  expect(Math.abs(b2!.x - b1!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(b2!.width - b1!.width)).toBeLessThanOrEqual(1)
  await expect(jev.getByTestId('jev-test-ok')).toHaveText('Connected in 238 ms')
  await btn.click()
  await expect(jev.getByTestId('jev-test-fail')).toHaveText("Couldn't connect: bad key")

  const remove = jev.getByTestId('jev-key-remove')
  const r1 = await remove.boundingBox()
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  const r2 = await remove.boundingBox()
  expect(Math.abs(r2!.x - r1!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(r2!.width - r1!.width)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(3_300)
  await expect(remove).toHaveText('Remove')
  expect(deletes).toHaveLength(0)
  await remove.click()
  await remove.click()
  await expect.poll(() => deletes.length, { timeout: 5_000 }).toBe(1)

  for (const f of ['JevSettings.tsx', 'SmartTaskCreation.tsx', 'AdvancedSection.tsx', 'ProvidersSection.tsx', 'SearchSection.tsx']) {
    const code = src(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
    expect(code, f).not.toMatch(/window\.confirm|[^.\w]confirm\((?!\{)|alert\(/)
  }
})

test('C72: Keep awake needs setup once; a failed setup shows the manual command with Copy', async ({ page }) => {
  await fakeConfig(page, (c) => { c.keep_awake = { ...c.keep_awake, enabled: true } })
  const state = { supported: true, enabled: true, holding: false, reason: 'no sessions', runningLocalSessions: 0, battery: null, online: true, needsSudo: true, setupDone: false, checkedAt: null }
  await page.route('**/api/keep-awake**', (route) => {
    const url = route.request().url()
    if (url.endsWith('/setup')) return route.fulfill({ json: { ok: false, detail: 'the helper did not install', state } })
    return route.fulfill({ json: { state, sudoSetupCommand: 'sudo /usr/local/bin/fixture-keep-awake --install' } })
  })
  await openSettings(page)
  await page.evaluate(() => { for (const k of Object.keys(sessionStorage)) if (k.startsWith('walnut.settings.disclosure.')) sessionStorage.removeItem(k) })
  const advanced = await clickNav(page, 'advanced')
  const disclose = advanced.getByTestId('advanced-disclosure-keep-awake')
  await expect(disclose.getByTestId('ka-summary')).toHaveText(/^(Off|On|Active|Needs setup)$/)
  await expect(disclose.getByTestId('ka-summary')).toHaveText('Needs setup')
  await disclose.click()
  const content = page.locator(`#${await disclose.getAttribute('aria-controls')}`)
  await expect(content.locator('.settings-row').first().locator('.settings-row-label')).toHaveText('Keep Mac awake')
  await expect(content.locator('.settings-row').first().getByRole('switch')).toBeVisible()
  await expect(content).toContainText('Needs your Mac password once.')
  await content.getByTestId('ka-setup').click()
  await expect(content.locator('.settings-row-error[role="alert"]')).toContainText("Setup didn't finish.")
  await expect(content.getByTestId('ka-setup-command')).toContainText('fixture-keep-awake --install')
  await expect(content.getByTestId('ka-setup-copy')).toBeVisible()
  await content.locator('#ka-enabled').click()
  for (const label of ['Battery floor', 'Offline release', 'Linger after last session']) {
    await expect(row(content, label)).toHaveAttribute('aria-disabled', 'true')
  }
})

test('C81: Raw config is a read-only pre with Copy', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await fakeConfig(page)
  await openSettings(page)
  const advanced = await clickNav(page, 'advanced')
  await advanced.getByTestId('advanced-disclosure-raw').click()
  const pre = advanced.getByTestId('advanced-raw-config')
  await expect(pre).toBeVisible()
  expect(await pre.evaluate((el) => el.tagName)).toBe('PRE')
  await expect(pre).toHaveCSS('max-height', '320px')
  await expect(pre).toHaveCSS('overflow-y', 'auto')
  expect(await pre.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  const block = advanced.locator('.settings-mono-row')
  expect(await block.locator('textarea, [contenteditable="true"]').count()).toBe(0)
  const copy = block.getByRole('button', { name: /^(Copy|Copied)$/ })
  await copy.click()
  await expect(copy).toHaveText('Copied')
  if (browserName === 'chromium') {
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(typeof JSON.parse(clip)).toBe('object')
  }
  await expect(copy).toHaveText('Copy', { timeout: 3_000 })
})

test('C51: with the master switch off, Triage rows are dimmed and inert', async ({ page }) => {
  await fakeConfig(page, (c) => {
    c.triage = { ...c.triage, enabled: false }
  })
  await openSettings(page)
  const tr = await clickNav(page, 'triage')
  for (const id of ['inbox-triage-every-row', 'inbox-triage-messages-row', 'inbox-triage-hours-row', 'inbox-triage-mode-row']) {
    await expect(tr.getByTestId(id)).toHaveAttribute('aria-disabled', 'true')
  }
  await expect(tr.getByTestId('inbox-triage-source-mail')).toBeDisabled()
})

test('C59: the API provider is one group with a segmented choice; every model label names its owner', async ({ page }) => {
  await fakeConfig(page, (c) => { c.agent = { ...c.agent, main_provider: 'claude_cli' } })
  await openSettings(page)
  const advanced = await clickNav(page, 'advanced')
  const providers = page.locator('#providers.settings-section')
  await expect(providers).toBeVisible()
  const desc = await providers.locator('.settings-folded-desc, .settings-card-desc').first().innerText()
  expect(desc.split(/(?<=\.)\s+/).filter(Boolean)).toHaveLength(1)
  await providers.getByTestId('providers-expand').click()
  await expect(providers.getByTestId('providers-summary')).toHaveText('Off')
  await providers.getByTestId('provider-mode-custom').click()
  await expect(providers.getByTestId('custom-agent-providers')).toBeVisible({ timeout: 15_000 })
  expect(await providers.locator('.settings-group').count()).toBe(1)
  expect(await providers.locator('.provider-card, .provider-radio').count()).toBe(0)
  await expect(providers.locator('.settings-row-label', { hasText: /^API model$/ })).toHaveCount(1)
  // Max tokens and Subagent model are gone (2026-10-27).
  await expect(providers.locator('#max-tokens')).toHaveCount(0)
  await expect(advanced.locator('.settings-row-label', { hasText: /^(Subagent model|Max tokens)$/ })).toHaveCount(0)

  const labels: string[] = []
  const collect = async () => labels.push(...await page.locator('.settings-pane .settings-row-label').allInnerTexts())
  await collect()
  await clickNav(page, 'sessions')
  await collect()
  expect(labels.map((l) => l.trim()).filter((l) => l === 'Model' || l === 'Default model')).toEqual([])
  expect(labels).toContain('API model')
  expect(labels).toContain('Default engine')
})

test('C64 + C63: the filter finds Apps for slack and Tasks for jev', async ({ page }) => {
  await fakeConfig(page)
  await openSettings(page)
  const filter = page.getByTestId('settings-filter')
  const firstVisibleNav = () => page.locator('[data-testid^="settings-nav-"]:visible').filter({ hasNot: page.locator('[data-testid^="settings-nav-error-"]') }).first()
  await filter.fill('slack')
  // The Plugins group's link to the Apps page keeps the old pane's id, plugin-store.
  await expect(firstVisibleNav()).toHaveAttribute('data-testid', 'settings-nav-plugin-store')
  await expect(firstVisibleNav()).toContainText('Apps')
  await filter.fill('jev')
  await expect(page.getByTestId('settings-nav-tasks')).toBeVisible()
  await filter.fill('')
})

test('C77: a change in one window reaches another window on the same server', async ({ page, browser }) => {
  await openSettings(page)
  const general = await clickNav(page, 'general')
  await expect(row(general, 'Appearance').locator('.settings-row-help')).toHaveText('Applies here now, and to other windows when they next open.')
  await expect(row(general, 'Focus bar').locator('.settings-row-help')).toContainText('other windows follow when they next open')
  await expect(general).not.toContainText('this window only')
  // A config switch that changes nothing another spec on this fixture reads
  // (Chat notifications, which this test used, are gone).
  const sessions = await clickNav(page, 'sessions')
  const sw = row(sessions, 'Auto approve in bypass mode').getByRole('switch')
  await expect(sw).toBeEnabled()
  const original = await sw.getAttribute('aria-checked')
  const flipped = original === 'true' ? 'false' : 'true'
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const put = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'PUT')
    await sw.click()
    expect((await put).ok()).toBe(true)
    await expect(sw).toHaveAttribute('aria-checked', flipped)
    const pageB = await other.newPage()
    await pageB.goto(new URL('/settings', page.url()).toString())
    await expect(pageB.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
    const sessionsB = await clickNav(pageB, 'sessions')
    await expect(row(sessionsB, 'Auto approve in bypass mode').getByRole('switch')).toHaveAttribute('aria-checked', flipped, { timeout: 10_000 })
  } finally {
    await other.close()
    if ((await sw.getAttribute('aria-checked')) !== original) {
      const back = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'PUT')
      await sw.click()
      await back
    }
    await expect(sw).toHaveAttribute('aria-checked', original!)
  }
})

const CAPS_OK = new Set('S3 SSH API URL ID JSON AWS TTS STT HTML QR SDK CLI MS MCP TOML ISO HEARTBEAT CLAUDE'.split(' '))
const BANNED_SYMBOLS = /[·→›▸▾✓✗×…↗]/
const DASHES = /[—–]/

/** Visible pane text with code/mono and server engine help removed. */
async function paneText(page: Page): Promise<{ text: string; transformed: string[] }> {
  return page.evaluate(() => {
    const pane = document.querySelector('.settings-pane') as HTMLElement
    const transformed: string[] = []
    for (const el of Array.from(pane.querySelectorAll<HTMLElement>('*'))) {
      if (getComputedStyle(el).textTransform !== 'none') transformed.push(`${el.tagName}.${el.className}`)
    }
    const clone = pane.cloneNode(true) as HTMLElement
    // Server-owned copy is out of scope here (engine help, hook descriptions: see notes).
    clone.querySelectorAll('code, kbd, pre, .mono, .settings-mono-value, [hidden], .engine-setting-help, .engine-setting-label, .engine-setting-control, .hook-row .settings-row-help, .hook-details, option, .settings-plugin-body').forEach((n) => n.remove())
    return { text: clone.innerText ?? clone.textContent ?? '', transformed }
  })
}

test('C8 + C10 + C80: configure panes use sentence case, no dashes, no decorative symbols', async ({ page }) => {
  await fakeConfig(page)
  await openSettings(page)
  for (const id of CONFIGURE_PANES) {
    await clickNav(page, id)
    await expandAll(page)
    const { text, transformed } = await paneText(page)
    expect(transformed, `${id}: text-transform`).toEqual([])
    const caps = (text.match(/\b[A-Z][A-Z0-9]{3,}\b/g) ?? []).filter((w) => !CAPS_OK.has(w))
    expect(caps, `${id}: all-caps words`).toEqual([])
    expect(text, `${id}: dashes`).not.toMatch(DASHES)
    expect(text, `${id}: symbols`).not.toMatch(BANNED_SYMBOLS)
  }
  for (const f of ['GeneralSection.tsx', 'TasksSection.tsx', 'SmartTaskCreation.tsx', 'JevSettings.tsx', 'FocusTiersSection.tsx',
    'SessionsSection.tsx', 'DefaultEngineRow.tsx', 'EngineSettingRows.tsx', 'AdvancedSection.tsx', 'ProvidersSection.tsx', 'HooksSection.tsx',
    'TriageSection.tsx', 'SearchSection.tsx', 'SttSection.tsx', 'SttDetectionPanel.tsx', 'SttSetupProgress.tsx', 'SttSetupRow.tsx', 'SttModelRows.tsx']) {
    const code = src(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
    expect(code, `${f}: dashes`).not.toMatch(DASHES)
    expect(code, `${f}: symbols`).not.toMatch(BANNED_SYMBOLS)
    expect(code, `${f}: form-group`).not.toMatch(/form-group|settings-collapsible/)
  }
})

test('captures every configure pane for review', async ({ page, browserName }) => {
  await fakeConfig(page)
  await openSettings(page)
  for (const id of CONFIGURE_PANES) {
    await clickNav(page, id)
    await page.waitForTimeout(500)
    // CSS pixels: WebKit's Desktop Safari profile renders at 2x.
    await page.locator('.settings-pane').screenshot({ path: `/tmp/settings-redesign/p3-${id}-${browserName}.png`, scale: 'css' })
  }
})

test('a double click on a switch while the first write is still in flight saves the second click', async ({ page }) => {
  const cfg = await fakeConfig(page, (c) => {
    c.session = { ...c.session, permission_prompt: true }
    c.triage = { ...c.triage, enabled: false }
  })
  cfg.delayPuts(600)
  await openSettings(page)
  const sessions = await clickNav(page, 'sessions')
  const sw = row(sessions, 'Intercept permission prompts').getByRole('switch')
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await sw.click()
  await expect.poll(() => cfg.puts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(1_500)
  expect(cfg.state().session.permission_prompt, cfg.gets().join('\n')).toBe(true)
  await expect(sw).toHaveAttribute('aria-checked', 'true')

  // Two different rows of one key in quick succession both land.
  const tr = await clickNav(page, 'triage')
  await tr.locator('#inbox-triage-enabled').click()
  await expect(tr.locator('#inbox-triage-every')).toBeEnabled()
  await tr.locator('#inbox-triage-every').fill('45m')
  await tr.locator('#inbox-triage-every').press('Enter')
  await tr.getByTestId('inbox-triage-mode-assist').click()
  await expect.poll(() => {
    const t = cfg.state().triage ?? {}
    return [t.enabled, t.every, t.mode]
  }, { timeout: 15_000 }).toEqual([true, '45m', 'assist'])
})
