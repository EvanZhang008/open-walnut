/**
 * Host problems on the draft surfaces, driven by the SERVER's host fixture
 * (src/core/hosts/host-fixture.ts through POST /api/test/host-fixture): the
 * frames are the real buildHostStatus, the Start gate is the real one, and a
 * fixture host lists folders and spawns sessions through the MockDaemon, so
 * no ssh is ever dialed.
 *
 *   picker   the Build box tab dot and its readiness note (C1, C2)
 *   Start    a refused Start (409 host_not_ready) restores the draft with the
 *            gate bar; Start anyway starts it (C3, C4, C48, C54)
 *   Settings the gate bar's Open Settings lands on the host's row; the auth
 *            host reads the shared headline and hint (C6, C35, C68)
 *   off      an ephemeral fixture: every remote host is off (C22, C79)
 *
 * Serial, and run with --workers=1 next to the banner specs: those route the
 * same aliases client-side, and a loaded server fixture would push real frames
 * for them. page.goto only loads the app; everything else is a real click.
 *
 * Run: PW_TEST_PORT=35991 npx playwright test host-problems-draft --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35991 npx playwright test host-problems-draft --project=webkit --workers=1
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { draftComposer, draftCwdPill, draftPanel, draftQuickChips, openDraft } from './draft-helpers'
import { SHOTS, hostFixture, resetServerHostFixture } from './host-problems-helpers'

test.describe.configure({ mode: 'serial' })

const REMOTE_OFF = 'Remote hosts are off on this test server.'

interface WireHost {
  host: string; label: string; connected: boolean; kind?: string; hint?: string; headline?: string
  readiness?: { problems: Array<{ kind: string; message: string; commands: string[] }> }
}

async function wireHost(request: APIRequestContext, host: string): Promise<WireHost> {
  const res = await request.get('/api/hosts/status')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { hosts: WireHost[] }
  const found = body.hosts.find((h) => h.host === host)
  expect(found, `${host} in /api/hosts/status`).toBeTruthy()
  return found!
}

async function taskCount(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/tasks')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { tasks?: unknown[] } | unknown[]
  return Array.isArray(body) ? body.length : (body.tasks ?? []).length
}

async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
}

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const hostTab = (page: Page, host: string): Locator => picker(page).locator(`.sps-host-tab[data-host="${host}"]`)

/** Open a draft and its folder picker; the picker's first answer has landed when this returns. */
async function openPicker(page: Page): Promise<Locator> {
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 10_000 })
  await expect(hostTab(page, 'devbox')).toBeVisible({ timeout: 20_000 })
  return panel
}

/** In the open picker: the host's tab, then a folder the fixture tree has, confirmed with Shift+Enter. */
async function pickRemoteFolder(page: Page, panel: Locator, host: string, dir: string): Promise<void> {
  await hostTab(page, host).click()
  await expect(hostTab(page, host)).toHaveClass(/active/)
  const input = picker(page).locator('.sps-search-input')
  await input.fill(dir)
  await expect(picker(page).locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  await input.press('Shift+Enter')
  await expect(picker(page)).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText(dir.split('/').filter(Boolean).pop()!)
}

/** Type a message and press Start; answers the quick-start response. */
async function start(page: Page, panel: Locator, text: string) {
  await draftComposer(page).fill(text)
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()
  return res
}

test.describe('draft surfaces against the server host fixture', () => {
  test.beforeAll(async ({ request }) => {
    await resetServerHostFixture(request)
    await hostFixture(request, { action: 'load', fixture: 'host-problems' })
  })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('picker: the Build box tab dot is warn, its note is the server sentence with Check again and Open Settings (C1, C2)', async ({ page, request }) => {
    const wire = await wireHost(request, 'buildbox')
    const problem = wire.readiness!.problems[0]
    expect(problem.kind).toBe('claude_outdated')
    await loadHome(page)
    await openPicker(page)
    const tab = hostTab(page, 'buildbox')
    const dot = tab.locator('.sps-host-dot')
    await expect(dot).toHaveAttribute('data-kind', 'warn')
    expect(await tab.getAttribute('title')).toMatch(/^Build box: /)
    const colors = await dot.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.background = 'var(--warning)'
      document.body.appendChild(probe)
      const want = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { have: getComputedStyle(el).backgroundColor, want }
    })
    expect(colors.have).toBe(colors.want)

    await tab.click()
    const note = picker(page).locator('.sps-host-note[data-host="buildbox"]')
    await expect(note).toHaveAttribute('data-type', 'readiness')
    await expect(note.locator('.sps-host-note-text')).toHaveText(problem.message)
    await expect(note.getByRole('button', { name: 'Check again' })).toBeVisible()
    await expect(note.getByRole('button', { name: 'Open Settings' })).toBeVisible()
    // No commands, no code chip; the row starts with the CSS dot, never a warning glyph.
    expect(problem.commands).toEqual([])
    await expect(note.locator('code, .host-cmd, .hc-chip')).toHaveCount(0)
    expect(await note.innerText()).not.toContain('⚠')
    await expect(note.locator('.sps-host-note-head > .sps-host-dot')).toHaveAttribute('data-kind', 'warn')
    await picker(page).screenshot({ path: `${SHOTS}/draft-picker-buildbox.png` })
  })

  test('Start on Build box: 409 host_not_ready before any write, the draft comes back with the gate bar; Start anyway starts it (C3, C4, C48, C54)', async ({ page, request }) => {
    const message = (await wireHost(request, 'buildbox')).readiness!.problems[0].message
    await loadHome(page)
    const panel = await openPicker(page)
    await pickRemoteFolder(page, panel, 'buildbox', '~/work/api')
    const draftId = await draftPanel(page).getAttribute('data-draft-id')
    const tasksBefore = await taskCount(request)

    const refused = await start(page, panel, 'check the build on the old CLI')
    expect(refused.status()).toBe(409)
    const body = await refused.json() as { code: string; error: string; allowOverride?: boolean; host: string }
    expect(body.code).toBe('host_not_ready')
    expect(body.error).toBe(message)
    expect(body.host).toBe('buildbox')
    expect(body.allowOverride).toBe(true)

    // The same draft is back where it was, with its text; nothing pending, no task written.
    // (The column strip animates the swap: the old copy leaves within the animation.)
    const restored = page.locator(`.main-page-session-column .draft-session-panel[data-draft-id="${draftId}"]`)
    await expect(restored).toHaveCount(1)
    await expect(restored).toBeVisible()
    await expect(page.locator('.pending-session-panel')).toHaveCount(0)
    await expect(draftComposer(page)).toHaveText('check the build on the old CLI')
    await expect(draftCwdPill(panel)).toContainText('api')
    expect(await taskCount(request)).toBe(tasksBefore)
    const bar = panel.locator('[data-testid="host-gate-bar"]')
    await expect(bar).toHaveAttribute('data-code', 'host_not_ready')
    await expect(bar.locator('.session-error-banner-text')).toHaveText(message)
    await expect(bar.getByRole('button', { name: 'Open Settings' })).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Start anyway' })).toBeVisible()
    await expect(page.getByText('Quick Start Failed')).toHaveCount(0)
    await bar.screenshot({ path: `${SHOTS}/draft-gate-bar.png` })

    // Start anyway: the same launch with overrideReadiness, and it starts.
    const again = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
    await bar.getByRole('button', { name: 'Start anyway' }).click()
    const started = await again
    expect((started.request().postDataJSON() as { overrideReadiness?: boolean }).overrideReadiness).toBe(true)
    expect(started.status()).toBe(200)
    const sid = (await started.json() as { sessionId?: string }).sessionId
    expect(sid).toBeTruthy()
    await expect(page.locator(`.session-panel[data-session-id="${sid}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`.draft-session-panel[data-draft-id="${draftId}"]`)).toHaveCount(0)
  })

  test('the gate bar opens the host row in Settings; Key box reads the shared headline and hint (C4, C6, C35, C68)', async ({ page, request }) => {
    const key = await wireHost(request, 'keybox')
    expect(key.kind).toBe('auth')
    await loadHome(page)
    const panel = await openPicker(page)
    await pickRemoteFolder(page, panel, 'buildbox', '~/work/web')
    const refused = await start(page, panel, 'second try on the build box')
    expect(refused.status()).toBe(409)
    await panel.locator('[data-testid="host-gate-bar"]').getByRole('button', { name: 'Open Settings' }).click()
    await expect(page).toHaveURL(/\/settings#rh-host-buildbox$/)

    const buildRow = page.locator('#rh-host-buildbox')
    await expect(buildRow).toBeVisible({ timeout: 20_000 })
    await expect(buildRow).toHaveClass(/rh-row-flash/)
    await expect(buildRow.locator('.rh-host-name')).toHaveText('Build box')
    await expect(buildRow.locator('.rh-host-alias')).toHaveText('buildbox')
    const line = buildRow.locator('.rh-readiness').first()
    await expect(line).toBeVisible()
    const text = await line.innerText()
    expect(text.startsWith('buildbox: ')).toBe(false)
    expect(text.split('Build box').length - 1).toBe(1)

    const keyRow = page.locator('#rh-host-keybox')
    await keyRow.scrollIntoViewIfNeeded()
    await expect(keyRow.locator('.rh-failure .hft-headline')).toHaveText(/^Could not connect to Key box/)
    // The server's hint verbatim, its `backticks` rendered as inline code.
    const hint = keyRow.locator('.rh-failure .hft-hint')
    await expect(hint).toHaveText(key.hint!.replace(/`/g, ''))
    await expect(hint.locator('code').first()).toHaveText('ssh alice@key.example.com')
    expect(await page.locator('body').innerText()).not.toContain("isn't reachable right now")
    await keyRow.screenshot({ path: `${SHOTS}/settings-keybox.png` })
  })
})

test.describe('an ephemeral fixture: every remote host is off', () => {
  test.beforeAll(async ({ request }) => {
    await resetServerHostFixture(request)
    await hostFixture(request, { action: 'load', fixture: 'host-problems-ephemeral' })
  })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('grey off dots, the off note, no remote chips, and a remote Start is refused host_off (C22, C79)', async ({ page, request }) => {
    await loadHome(page)
    const panel = await openPicker(page)
    await expect(draftQuickChips(panel).locator('.draft-quick-chip-host')).toHaveCount(0)
    const tabs = picker(page).locator('.sps-host-tab[data-host]')
    const hosts = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-host')).filter((h): h is string => !!h && h !== '__removed__'))
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) {
      const tab = hostTab(page, host)
      await expect(tab.locator('.sps-host-dot')).toHaveAttribute('data-kind', 'off')
      expect(await tab.getAttribute('title')).toMatch(/: Off on this test server$/)
    }
    await hostTab(page, 'devbox').click()
    await expect(picker(page).locator('.sps-host-note-off')).toHaveText(REMOTE_OFF)
    const shown = await picker(page).innerText()
    expect(shown).not.toContain('Could not connect')
    await expect(picker(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await picker(page).screenshot({ path: `${SHOTS}/draft-picker-off.png` })
    await page.keyboard.press('Escape')

    // The server refuses a remote Start with the same sentence, before any dial.
    const res = await request.post('/api/sessions/quick-start', {
      data: { message: 'off host probe', cwd: '/home/alice/work/api', host: 'devbox', sessionId: `hp-off-${Date.now()}` },
    })
    expect(res.status()).toBe(409)
    const body = await res.json() as { code: string; error: string }
    expect(body.code).toBe('host_off')
    expect(body.error).toBe(REMOTE_OFF)
  })
})
