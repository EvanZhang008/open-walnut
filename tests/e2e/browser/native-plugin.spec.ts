import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/walnut-plugin-demo'
/** Where the update-status design shots land (light, dark, narrow); read by the reviewers. */
const UPDATE_SHOT_DIR = '/tmp/plugin-update-ux/after'
const execFileAsync = promisify(execFile)
let child: ChildProcessWithoutNullStreams | null = null
let fixturePort = 0
let fixtureHome = ''
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Plugin fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Plugin App fixture exited early (${child?.exitCode})\n${output.slice(-12_000)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`)
      if (response.ok) return
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Plugin App fixture\n${output.slice(-12_000)}`)
}

async function stopChild(): Promise<void> {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 20_000) }),
  ])
  if (timer) clearTimeout(timer)
  if (graceful) return
  child.kill('SIGKILL')
  await Promise.race([
    stopped,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Plugin App fixture did not stop')), 5_000)),
  ])
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
}

async function openDemo(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })
}

/** Settings, Plugins, from anywhere in the console (real clicks, never a goto to the section). */
async function openPlugins(page: Page): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}

/** The fixture git source, installed through the UI unless an earlier test already did. */
async function ensureSourceInstalled(page: Page): Promise<void> {
  if (await page.getByTestId('plugin-source-native-plugin-repo').count()) return
  const pluginStore = page.locator('#plugin-store')
  await pluginStore.locator('#plugin-source-url').fill(pathToFileURL(path.join(fixtureHome, 'native-plugin-repo')).href)
  await pluginStore.getByTestId('plugin-trust-confirm').check()
  await pluginStore.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('plugin-source-native-plugin-repo')).toBeVisible({ timeout: 30_000 })
}

/** git in a repo the fixture created under the OS temp dir; identity pinned, never the user's. */
function git(cwd: string, ...args: string[]) {
  return execFileAsync(
    'git',
    ['-c', 'user.name=Walnut Test', '-c', 'user.email=walnut-test@example.invalid', ...args],
    { cwd },
  )
}

/** Stage everything and commit, so a test does not depend on which files an earlier test left tracked. */
async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-m', message)
}

/** Same helper as mail-app-design.spec.ts, landing back on the Plugins section. */
async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}

/**
 * Records every `data-update-kind` a chip ever carries, from document start, so a test
 * can prove a chip never PASSED THROUGH `unchecked` (a plain poll could miss the flash).
 */
const CHIP_KIND_RECORDER = `
  window.__chipKinds = {};
  const note = (el) => {
    const id = el.getAttribute('data-testid'); const kind = el.getAttribute('data-update-kind');
    if (!id || !id.startsWith('update-chip-') || !kind) return;
    (window.__chipKinds[id] ||= []).push(kind);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') note(r.target);
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        note(n); n.querySelectorAll('[data-update-kind]').forEach(note);
      });
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-update-kind'] });
`

/** Every kind ever seen on one chip, oldest first. */
function kindsSeen(page: Page, rowId: string): Promise<string[]> {
  return page.evaluate((id) => ((window as unknown as { __chipKinds: Record<string, string[]> }).__chipKinds ?? {})[id] ?? [], `update-chip-${rowId}`)
}

/** Text glyphs the design bans from chips and triggers (they render as emoji or mismatched fallbacks). */
const BANNED_GLYPHS = /[\u26A0\u2713\u270E\u21C5\u2205\u25CB\u25CC\u24D8]/

/** WCAG contrast of an element's text colour against the card it sits on. */
async function contrastAgainstCard(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const parse = (c: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(c)
      if (!m) return null
      const [r, g, b, a = '1'] = m[1].split(',').map((v) => v.trim())
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) }
    }
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const fg = parse(getComputedStyle(el).color)
    let node: HTMLElement | null = el as HTMLElement
    let bg = null
    while (node && !bg) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0) bg = c
      node = node.parentElement
    }
    if (!fg || !bg) return 0
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    return (l1 + 0.05) / (l2 + 0.05)
  })
}

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  fixturePort = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/test-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_TEST_PORT: String(fixturePort),
      PW_NATIVE_PLUGIN_FIXTURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  await waitForServer(fixturePort)
  ;({ walnutHome: fixtureHome } = await discoverBrowserFixture(fixturePort))
})

test.afterAll(async () => {
  await stopChild()
})

test('installs a first-class Plugin App and exercises its real capabilities', async ({ page, context }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  const pluginStore = page.locator('#plugin-store')
  await pluginStore.locator('#plugin-source-url').fill(
    pathToFileURL(path.join(fixtureHome, 'native-plugin-repo')).href,
  )
  const addButton = pluginStore.getByRole('button', { name: 'Add', exact: true })
  await expect(addButton).toBeDisabled()
  await pluginStore.getByTestId('plugin-trust-confirm').check()
  await addButton.click()
  await expect(page.getByText(/Added.*found 1 plugin/)).toBeVisible({ timeout: 30_000 })
  await expect(pluginStore.getByTestId('plugin-trust-confirm')).not.toBeChecked()
  const sourceCard = page.getByTestId('plugin-source-native-plugin-repo')
  await expect(sourceCard.getByText('Walnut Plugin Demo').first()).toBeVisible()
  await expect(sourceCard.getByText('active', { exact: true })).toBeVisible()
  const skillsResponse = await page.request.get(`http://127.0.0.1:${fixturePort}/api/skills`)
  if (!skillsResponse.ok()) throw new Error(`Skills catalogue failed: ${await skillsResponse.text()}`)
  const skills = await skillsResponse.json() as { skills: Array<{ dirName: string }> }
  expect(skills.skills.some((skill) => skill.dirName === 'walnut-demo')).toBe(true)

  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-home').click()
  const composer = page.locator('.main-page-chat .chat-input-textarea')
  await composer.fill('/app:walnut-demo')
  const appCommand = page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })
  await expect(appCommand.locator('.command-palette-source-app')).toHaveText('App')
  await appCommand.click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })

  const app = page.getByTestId('plugin-demo-app')
  await expect(page.getByTestId('app-host-native')).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('[data-testid="plugin-dashboard"]')).toHaveCount(0)

  await app.getByTestId('plugin-demo-action-react-count').click()
  await app.getByTestId('plugin-demo-action-react-count').click()
  await expect(app.getByTestId('plugin-demo-action-react-count')).toContainText('2')

  const demoNav = page.getByTestId('sidebar-app-walnut-demo:main')
  await app.getByTestId('plugin-demo-action-badge-count').click()
  const countBadge = demoNav.locator('.notification-badge-count')
  await expect(countBadge).toHaveText('3')
  const [navBounds, badgeBounds] = await Promise.all([demoNav.boundingBox(), countBadge.boundingBox()])
  expect(navBounds).not.toBeNull()
  expect(badgeBounds).not.toBeNull()
  expect(badgeBounds!.x).toBeGreaterThanOrEqual(navBounds!.x)
  expect(badgeBounds!.y).toBeGreaterThanOrEqual(navBounds!.y)
  expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(navBounds!.x + navBounds!.width)
  expect(badgeBounds!.y + badgeBounds!.height).toBeLessThanOrEqual(navBounds!.y + navBounds!.height)
  await app.getByTestId('plugin-demo-action-badge-dot').click()
  await expect(demoNav.locator('.notification-badge-dot')).toBeVisible()
  await app.getByTestId('plugin-demo-action-badge-clear').click()
  await expect(demoNav.locator('.notification-badge-count, .notification-badge-dot')).toHaveCount(0)

  await app.getByTestId('plugin-demo-open-auxiliary-page').click()
  await expect(page).toHaveURL(/\/plugin-demo-about$/)
  await expect(page.getByTestId('plugin-demo-auxiliary-page')).toBeVisible()
  await expect(page.getByTestId('sidebar-app-walnut-demo:main')).toHaveCount(1)
  await openDemo(page)

  await app.getByTestId('plugin-demo-tab-web').click()
  for (const action of ['refresh-status', 'event-echo', 'web-event-emit', 'web-ops-call']) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }

  await app.getByTestId('plugin-demo-tab-server').click()
  for (const action of [
    'task-create',
    'task-get',
    'task-list',
    'task-query',
    'task-children',
    'task-update',
    'task-note',
    'task-log',
    'task-complete',
    'config-read',
    'config-patch',
    'storage-roundtrip',
    'sqlite-roundtrip',
    'storage-list',
    'storage-delete',
    'secret-roundtrip',
    'timer-timeout',
    'timer-interval-start',
    'timer-interval-stop',
    'notify',
    'notify-error',
    'notify-recover',
    'ops-catalogue',
    'ops-selftest',
    'unsafe-inspect',
  ]) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }
  await expect(app.getByTestId('plugin-demo-receipt-task-list')).not.toContainText('Playwright test task')
  await expect(app.getByTestId('plugin-demo-receipt-task-query')).not.toContainText('pw-task-001')
  await expect(app.getByTestId('plugin-demo-receipt-secret-roundtrip')).not.toContainText('demo-value')
  await expect(app.getByTestId('plugin-demo-receipt-ops-selftest')).toContainText('"valuesReported": false')
  await app.getByTestId('plugin-demo-probe-url').fill('http://127.0.0.1/private')
  await app.getByTestId('plugin-demo-action-http-probe').click()
  await expect(app.getByTestId('plugin-demo-receipt-http-probe')).toContainText('only fetches the fixed URL')
  await app.getByTestId('plugin-demo-action-secret-delete').click()
  await app.getByTestId('plugin-demo-action-task-cleanup').click()
  await expect(app.getByTestId('plugin-demo-receipt-task-cleanup')).toHaveAttribute('data-ok', 'true', {
    timeout: 30_000,
  })

  await app.getByTestId('plugin-demo-tab-registry').click()
  for (const action of ['tool-handler-probe', 'cron-handler-probe', 'provider-adapter-probe', 'sync-adapter-probe', 'registry-list']) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }

  await app.getByTestId('plugin-demo-tab-views').click()
  await app.getByTestId('plugin-demo-view-task').click()
  await expect(app.getByTestId('plugin-demo-active-view').getByTestId('plugin-task-view')).toBeVisible({ timeout: 30_000 })
  await app.getByTestId('plugin-demo-view-calendar').click()
  await expect(app.getByTestId('plugin-demo-active-view')).toBeVisible()

  const deepLinkPage = await context.newPage()
  await deepLinkPage.goto(`http://127.0.0.1:${fixturePort}/apps/walnut-demo~main/views`)
  await expect(deepLinkPage.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })
  await expect(deepLinkPage.getByTestId('plugin-demo-section-views')).toBeVisible()
  await deepLinkPage.close()

  await app.getByTestId('plugin-demo-tab-platform').click()
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop.png'), fullPage: true })
  await app.getByTestId('plugin-demo-tab-server').click()
  await app.getByTestId('plugin-demo-section-server').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'capabilities.png'), fullPage: true })

  // The app's entry is managed on the PLUGIN's row in the Plugins section —
  // there is no separate Apps panel.
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  const appRow = page.getByTestId('plugin-app-row-walnut-demo:main')
  await expect(appRow).toBeVisible()
  const visibility = page.getByTestId('plugin-app-visibility-walnut-demo:main')
  await expect(visibility).toHaveText('Hide')
  await visibility.click()
  await expect(demoNav).toHaveCount(0)
  await expect(appRow).toContainText('Hidden')
  // Hidden keeps its deep link: Open still lands on the app.
  await page.getByTestId('plugin-app-open-walnut-demo:main').click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
  await expect(demoNav).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-home').click()
  const hiddenComposer = page.locator('.main-page-chat .chat-input-textarea')
  await hiddenComposer.click()
  // Typed, not filled: the palette opens off the CARET, and it renders nothing at
  // all when no command matches — so "the hidden App has no entry" only means
  // something once the palette is demonstrably open and listing other Apps.
  await hiddenComposer.pressSequentially('/app:', { delay: 15 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:core:tasks' }))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await hiddenComposer.fill('')
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(visibility).toHaveText('Show')
  await visibility.click()
  await expect(demoNav).toBeVisible()

  // Reload keeps the #plugin-store hash, so the section re-anchors on its own.
  await page.reload()
  await expect(page.getByTestId('plugin-app-row-walnut-demo:main')).toBeVisible({ timeout: 30_000 })
  await expect(demoNav).toBeVisible()
  expect(pageErrors).toEqual([])
})

/**
 * Update status (spec /tmp/plugin-update-ux/spec.md section 9). Serial, on the same fixture:
 * two linked siblings (`acme-tracker`, `acme-notes`) from one checkout plus the git source
 * installed above. Every git command here runs in a repo the fixture created under the OS
 * temp dir, never in the Walnut checkout.
 */
test.describe('update status', () => {
  const UPDATABLE = ['acme-tracker', 'acme-notes', 'walnut-demo']

  test('(a) chips on every updatable row without a click; one batch GET, no per-row POST', async ({ page }) => {
    await page.addInitScript(CHIP_KIND_RECORDER)
    const updateGets: string[] = []
    const checkPosts: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/plugin-updates' && req.method() === 'GET') updateGets.push(url.search)
      if (req.method() === 'POST' && /\/(linked\/check|plugin-sources\/[^/]+\/check)$/.test(url.pathname)) checkPosts.push(url.pathname)
    })
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    // Warm-up: a cold server cache answers `refreshing` and the client polls until the
    // batch lands; the strict request count below is taken on the warm second visit.
    for (const id of UPDATABLE) {
      await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    }
    // Built-in rows and the hand-copied folder: no chip, no Update, and no Check anywhere
    // on the page any more.
    const installed = page.getByTestId('plugin-store-installed')
    const rowIds = await installed.locator('[data-testid^="plugin-row-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.slice('plugin-row-'.length)))
    expect(rowIds.length).toBeGreaterThan(UPDATABLE.length)
    expect(rowIds).toContain('acme-copied')
    for (const id of rowIds.filter((id) => !UPDATABLE.includes(id))) {
      const row = page.getByTestId(`plugin-row-${id}`)
      await expect(row.locator('[data-testid^="update-chip-"]')).toHaveCount(0)
      await expect(row.getByRole('button', { name: /^(Update|Restore|Check)$/ })).toHaveCount(0)
    }
    // A folder copied in by hand is exactly that: it says so instead of pretending to be a
    // git install with a chip whose click could never answer.
    await expect(page.getByTestId('plugin-row-acme-copied')).toContainText('Local folder')
    // The origin label names the source only; what the plugin adds is appended from its
    // manifest. These fixtures add nothing, so a label that baked in "· sync" would show
    // here (and doubled on a real sync plugin: "Linked · sync · sync").
    const linkedOrigin = page.getByTestId('plugin-row-acme-tracker').locator('.plugin-store-origin')
    await expect(linkedOrigin).toHaveText(/^Linked(?!\s*·\s*sync)/)
    await expect(linkedOrigin).not.toContainText('sync')
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('plugin-updates-check-now')).toBeVisible()
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked /)

    updateGets.length = 0
    checkPosts.length = 0
    await page.reload()
    await expect(installed).toBeVisible({ timeout: 30_000 })
    for (const id of UPDATABLE) {
      await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 10_000 })
      const kinds = await kindsSeen(page, id)
      expect(kinds, `${id} must start pending or current, never unchecked`).not.toContain('unchecked')
      expect(['pending', 'current', 'checking']).toContain(kinds[0])
    }
    expect(updateGets.filter((q) => !q.includes('refresh=1'))).toHaveLength(1)
    expect(checkPosts).toEqual([])
    // At rest a row is three lines (title, description, origin) and no feedback line.
    for (const id of UPDATABLE) {
      const copy = page.getByTestId(`plugin-row-${id}`).locator('.settings-row-copy')
      expect(await copy.locator(':scope > *').count()).toBeLessThanOrEqual(3)
      await expect(copy.locator('.plugin-update-feedback')).toHaveCount(0)
    }
    // "Up to date" is the click-to-check control: a button with a pointer cursor and a hover
    // you can see (N12).
    const current = page.getByTestId('update-chip-acme-tracker')
    expect(await current.evaluate((el) => el.tagName)).toBe('BUTTON')
    expect(await current.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer')
    const restBorder = await current.evaluate((el) => getComputedStyle(el).borderTopColor)
    await current.hover()
    await expect.poll(() => current.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(restBorder)
    await page.mouse.move(0, 0)
  })

  test('(g) a slow first GET keeps chips pending and never shows Not checked', async ({ page }) => {
    await page.addInitScript(CHIP_KIND_RECORDER)
    await page.route('**/api/plugin-updates*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue()
    })
    try {
      await page.goto(`http://127.0.0.1:${fixturePort}/`)
      await openPlugins(page)
      const chip = page.getByTestId('update-chip-acme-tracker')
      await expect(chip).toHaveAttribute('data-update-kind', 'pending')
      await expect(chip).toHaveAttribute('aria-busy', 'true')
      // The header says nothing while the first GET is out: "Not checked yet" is the server's
      // answer, not the client's not-having-asked (N8).
      await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText('')
      await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 15_000 })
      await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked /)
      expect(await kindsSeen(page, 'acme-tracker')).not.toContain('unchecked')
    } finally {
      await page.unroute('**/api/plugin-updates*')
    }
  })

  test('(b)(c)(l) Check now finds an upstream commit; Update takes it, the row keeps its width, feedback stays', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const chip = page.getByTestId('update-chip-walnut-demo')
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    // The source was installed from file://<fixtureHome>/native-plugin-repo, so a commit
    // THERE is an upstream change for the clone Walnut runs.
    const origin = path.join(fixtureHome, 'native-plugin-repo')
    await fs.writeFile(path.join(origin, 'FIXTURE-NOTES.md'), 'An upstream change.\n')
    await commitAll(origin, 'Upstream change one')
    const checkedAt = page.getByTestId('plugin-updates-checked-at')
    const checkNow = page.getByTestId('plugin-updates-check-now')
    await checkNow.click()
    await expect(checkedAt).toHaveText('Checking for updates…')
    await expect(checkedAt).not.toHaveText(/\d/)
    await expect(chip).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(chip).toContainText('1 commit behind')
    // A git source names the commit Update would move to, like a linked checkout does (N19).
    expect(await chip.getAttribute('title')).toMatch(/Update moves this plugin to [0-9a-f]{7}\./)
    await expect(checkedAt).toHaveText(/^Checked just now/)
    const row = page.getByTestId('plugin-row-walnut-demo')
    const update = page.getByTestId('plugin-update-walnut-demo')
    await expect(update).toHaveClass(/btn-primary/)
    await expect(update).toBeEnabled()
    // One primary at most, and never two grey verbs side by side.
    expect(await row.locator('.settings-row-actions .btn-primary').count()).toBe(1)
    await expect(row.getByRole('button', { name: 'Check', exact: true })).toHaveCount(0)
    // Every control on the row is one height: Update and Remove both 28px (N14).
    const updateBox = (await update.boundingBox())!
    const removeBox = (await row.getByRole('button', { name: 'Remove' }).boundingBox())!
    expect(Math.abs(updateBox.height - removeBox.height)).toBeLessThanOrEqual(1)
    expect(removeBox.height).toBeLessThanOrEqual(29)
    const actions = row.locator('.settings-row-actions')
    const before = (await actions.boundingBox())!
    await update.click()
    const feedback = page.getByTestId('plugin-update-feedback-walnut-demo')
    await expect(feedback).toContainText('Updated to', { timeout: 60_000 })
    await expect(feedback).toHaveAttribute('role', 'status')
    await expect(page.getByRole('status').filter({ hasText: 'Updated to' })).toHaveCount(1)
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 5_000 })
    await expect(update).toHaveCount(0)
    const after = (await actions.boundingBox())!
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1)
    // The plugin was loaded when its files changed, so until a restart the row's badge and the
    // Sources card both read RESTART TO ACTIVATE, and the switch stays on: the old code still
    // runs (N7).
    await expect(row.locator('.badge').filter({ hasText: /^restart to activate$/i })).toBeVisible()
    await expect(row.locator('.badge').filter({ hasText: /^on$/i })).toHaveCount(0)
    await expect(page.locator('#plugin-toggle-walnut-demo')).toBeChecked()
    await expect(page.getByTestId('plugin-source-status-native-plugin-repo')).toHaveText(/restart to activate/i)
    // Row copy never carries a path, a host or a git command.
    const text = await row.innerText()
    expect(text).not.toMatch(/(^|\s)\/(Users|home|private|var|tmp|opt)\//)
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(text).not.toMatch(/\bgit (fetch|pull|status|rev-parse|merge|rebase)\b/)
    // No page banner for an update: the row said "restart" once if it needed to.
    await expect(page.locator('.plugin-store-banner-restart')).toHaveCount(0)
    await expect(page.locator('.settings-notice').filter({ hasText: /Restart Walnut to apply/ })).toHaveCount(0)
    // The feedback line never expires on a timer.
    await page.waitForTimeout(15_000)
    await expect(feedback).toBeVisible()
    await expect(feedback).toContainText('Updated to')
  })

  test('(d) an unreachable remote keeps the last known answer, marked stale', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const chip = page.getByTestId('update-chip-walnut-demo')
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const origin = path.join(fixtureHome, 'native-plugin-repo')
    await fs.rename(origin, `${origin}.away`)
    try {
      await page.getByTestId('plugin-updates-check-now').click()
      await expect(chip).toHaveAttribute('data-update-kind', 'unreachable', { timeout: 30_000 })
      await expect(chip).toHaveClass(/plugin-update-chip--stale/)
      await expect(chip).toContainText('Up to date')
      expect(await chip.getAttribute('title')).toContain('Last checked')
      // The "remote unreachable" mark sits INSIDE the pill after the words, 12px, not a 9px
      // badge notching the outline (N13).
      const mark = chip.locator('.plugin-update-chip-stale-mark')
      await expect(mark).toBeVisible()
      const [pill, markBox] = await Promise.all([chip.boundingBox(), mark.boundingBox()])
      expect(markBox!.width).toBeGreaterThanOrEqual(12)
      expect(markBox!.x).toBeGreaterThanOrEqual(pill!.x)
      expect(markBox!.x + markBox!.width).toBeLessThanOrEqual(pill!.x + pill!.width + 0.5)
      expect(markBox!.y).toBeGreaterThanOrEqual(pill!.y - 0.5)
      expect(markBox!.y + markBox!.height).toBeLessThanOrEqual(pill!.y + pill!.height + 0.5)
      // Stale never dims the words below the contrast floor.
      expect(await contrastAgainstCard(chip)).toBeGreaterThanOrEqual(4.5)
      // Last known was current, so there is nothing to press.
      await expect(page.getByTestId('plugin-update-walnut-demo')).toHaveCount(0)
      // Partial failure: the linked origin is still there, so the header counts, not folds.
      await expect(page.getByTestId('plugin-updates-checked-at')).toContainText('could not be reached')
      const text = await page.getByTestId('plugin-row-walnut-demo').innerText()
      expect(text).not.toMatch(/(^|\s)\/(Users|home|private|var|tmp|opt)\//)
    } finally {
      await fs.rename(`${origin}.away`, origin)
    }
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked just now$/)
  })

  test('(i)(j) linked siblings share one state: local changes block Update, one Update flips both', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const tracker = page.getByTestId('update-chip-acme-tracker')
    const notes = page.getByTestId('update-chip-acme-notes')
    const demo = page.getByTestId('update-chip-walnut-demo')
    for (const chip of [tracker, notes, demo]) await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const work = path.join(fixtureHome, 'linked-work')
    const scratch = path.join(work, 'acme-tracker', 'scratch.txt')
    const posts: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/(linked\/check|plugin-sources\/[^/]+\/check)$/.test(new URL(req.url()).pathname)) posts.push(new URL(req.url()).pathname)
    })
    await fs.writeFile(scratch, 'uncommitted\n')
    try {
      // A chip click re-checks THIS row only: one POST, the git source's chip untouched.
      await tracker.click()
      await expect(tracker).toHaveAttribute('data-update-kind', 'dirty', { timeout: 30_000 })
      expect(posts).toEqual(['/api/plugin-runtime/acme-tracker/linked/check'])
      await expect(demo).toHaveAttribute('data-update-kind', 'current')
      // The sibling shares the checkout, so it shares the answer.
      await expect(notes).toHaveAttribute('data-update-kind', 'dirty')
      await expect(tracker).toContainText('Local changes')
      const wrap = page.getByTestId('plugin-update-wrap-acme-tracker')
      await expect(wrap).toHaveAttribute('title', 'Commit or stash your changes in the checkout first.')
      await expect(page.getByTestId('plugin-update-acme-tracker')).toBeDisabled()
      // WebKit shows no title on a disabled button and no browser shows one on focus, so the
      // reason also appears as a tip under the button while the wrapper has focus.
      const updateBefore = (await page.getByTestId('plugin-update-acme-tracker').boundingBox())!
      const rowBefore = (await page.getByTestId('plugin-row-acme-tracker').boundingBox())!
      const nextRowBefore = (await page.getByTestId('plugin-row-acme-notes').boundingBox())!
      await wrap.focus()
      const reason = page.getByTestId('plugin-update-reason-acme-tracker')
      await expect(reason).toBeVisible()
      await expect(reason).toHaveText('Commit or stash your changes in the checkout first.')
      await expect(reason).toHaveClass(/plugin-update-reason/)
      await expect(reason).toHaveId('plugin-update-reason-acme-tracker')
      // The tip is an overlay (N3-14): nothing in the list moves, not the button, not the row,
      // not the row below; it hangs under the button, inside the viewport; and it reads at 4.5:1 (N20).
      const updateAfter = (await page.getByTestId('plugin-update-acme-tracker').boundingBox())!
      const rowAfter = (await page.getByTestId('plugin-row-acme-tracker').boundingBox())!
      const nextRowAfter = (await page.getByTestId('plugin-row-acme-notes').boundingBox())!
      expect(Math.abs(updateAfter.y - updateBefore.y)).toBeLessThanOrEqual(1)
      expect(Math.abs(rowAfter.height - rowBefore.height), 'row height on focus').toBeLessThanOrEqual(1)
      expect(Math.abs(nextRowAfter.y - nextRowBefore.y), 'next row top on focus').toBeLessThanOrEqual(1)
      const tipBox = (await reason.boundingBox())!
      expect(tipBox.y).toBeGreaterThanOrEqual(updateBefore.y + updateBefore.height - 1)
      expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(updateBefore.x + updateBefore.width + 1)
      const viewport = page.viewportSize()!
      expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(viewport.width)
      expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(viewport.height)
      expect(await contrastAgainstCard(reason)).toBeGreaterThanOrEqual(4.5)
      // A click on the disabled area shows the same tip, and the rows still do not move.
      await page.getByTestId('plugin-updates-check-now').focus()
      await expect(reason).toHaveCount(0)
      await wrap.click()
      await expect(reason).toBeVisible()
      expect(Math.abs((await page.getByTestId('plugin-row-acme-notes').boundingBox())!.y - nextRowBefore.y)).toBeLessThanOrEqual(1)
      await page.getByTestId('plugin-updates-check-now').focus()
      await expect(reason).toHaveCount(0)
      // Remove and the switch are not locked by an update state; Configure would be while updating.
      await expect(page.locator('#plugin-toggle-acme-tracker')).toBeEnabled()
    } finally {
      await fs.rm(scratch, { force: true })
    }
    // A commit pushed from the publisher clone puts the checkout behind: both chips say so.
    const publisher = path.join(fixtureHome, 'linked-publisher')
    await fs.writeFile(path.join(publisher, 'acme-tracker', 'CHANGES.md'), 'upstream\n')
    await commitAll(publisher, 'Publisher change one')
    await git(publisher, 'push', 'origin', 'main')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(tracker).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(notes).toHaveAttribute('data-update-kind', 'available')
    await expect(tracker).toContainText('1 commit behind')
    await expect(page.getByTestId('plugin-update-acme-notes')).toHaveClass(/btn-primary/)
    await page.getByTestId('plugin-update-acme-tracker').click()
    const feedback = page.getByTestId('plugin-update-feedback-acme-tracker')
    await expect(feedback).toContainText('Updated to', { timeout: 60_000 })
    await expect(feedback).toContainText('reloaded Acme Tracker and 1 more')
    await expect(feedback).not.toContainText('acme-')
    await expect(page.getByTestId('plugin-update-feedback-acme-notes')).toHaveCount(0)
    await expect(tracker).toHaveAttribute('data-update-kind', 'current', { timeout: 5_000 })
    await expect(notes).toHaveAttribute('data-update-kind', 'current')
    await expect(page.getByTestId('plugin-update-acme-tracker')).toHaveCount(0)
    await expect(page.getByTestId('plugin-update-acme-notes')).toHaveCount(0)
  })

  test('(C57) two Updates in flight keep their own Updating label and their own feedback', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const tracker = page.getByTestId('update-chip-acme-tracker')
    const demo = page.getByTestId('update-chip-walnut-demo')
    for (const chip of [tracker, demo]) await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const origin = path.join(fixtureHome, 'native-plugin-repo')
    await fs.writeFile(path.join(origin, 'FIXTURE-NOTES.md'), 'A second upstream change.\n')
    await commitAll(origin, 'Upstream change two')
    const publisher = path.join(fixtureHome, 'linked-publisher')
    await fs.writeFile(path.join(publisher, 'acme-tracker', 'CHANGES.md'), 'upstream two\n')
    await commitAll(publisher, 'Publisher change two')
    await git(publisher, 'push', 'origin', 'main')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(tracker).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(demo).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    // The linked update is held 4 s, the source update 1 s: the fast one finishing must
    // not touch the slow one's label or button.
    await page.route('**/api/plugin-runtime/acme-tracker/linked/update', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      await route.continue()
    })
    await page.route('**/api/plugin-sources/native-plugin-repo/update', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await route.continue()
    })
    try {
      const trackerUpdate = page.getByTestId('plugin-update-acme-tracker')
      await trackerUpdate.click()
      await page.getByTestId('plugin-update-walnut-demo').click()
      await expect(trackerUpdate).toHaveText('Updating…')
      await expect(page.getByTestId('plugin-update-walnut-demo')).toHaveText('Updating…')
      // The sibling shares the row key, so its Update is locked too, but only the PRESSED row
      // says Updating… (N10).
      await expect(page.getByTestId('plugin-update-acme-notes')).toHaveText('Update')
      await expect(page.getByTestId('plugin-update-acme-notes')).toBeDisabled()
      const demoFeedback = page.getByTestId('plugin-update-feedback-walnut-demo')
      await expect(demoFeedback).toContainText('Updated to', { timeout: 60_000 })
      await expect(trackerUpdate).toHaveText('Updating…')
      await expect(trackerUpdate).toBeDisabled()
      const trackerFeedback = page.getByTestId('plugin-update-feedback-acme-tracker')
      await expect(trackerFeedback).toContainText('Updated to', { timeout: 60_000 })
      await expect(trackerFeedback).toContainText('Acme Tracker')
      await expect(demoFeedback).not.toContainText('Acme Tracker')
      await expect(tracker).toHaveAttribute('data-update-kind', 'current')
      await expect(demo).toHaveAttribute('data-update-kind', 'current')
    } finally {
      await page.unroute('**/api/plugin-runtime/acme-tracker/linked/update')
      await page.unroute('**/api/plugin-sources/native-plugin-repo/update')
    }
  })

  test('(m)(C48) the Sources card mirrors the Installed row: same chip kind, one Update per slug, no bare URL', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const rowChip = page.getByTestId('update-chip-walnut-demo')
    const cardChip = page.getByTestId('update-chip-source-native-plugin-repo')
    await expect(rowChip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const card = page.getByTestId('plugin-source-native-plugin-repo')
    await expect(card.locator('strong').first()).toHaveText('Walnut Plugin Demo')
    // One plugin in the source: its version and status sit on the title row, and the name is
    // not repeated on a list of one (N16).
    await expect(card.locator('li')).toHaveCount(0)
    await expect(card.getByTestId('plugin-source-status-native-plugin-repo')).toHaveText(/^(active|restart to activate)$/i)
    await expect(card.locator('.plugin-store-version')).toHaveText(/^v\d/)
    expect((await card.innerText()).split('Walnut Plugin Demo').length - 1).toBe(1)
    expect(await cardChip.getAttribute('data-update-kind')).toBe(await rowChip.getAttribute('data-update-kind'))
    const cardText = await card.innerText()
    expect(cardText).not.toMatch(/https?:\/\/|git@|file:\/\/|@ [0-9a-f]{7}|sha(256|512)-/)
    expect(cardText).toMatch(/git · /)
    expect(cardText).not.toContain('not installed on this machine')
    // The Installed row owns the verb: with an update available there is exactly ONE
    // Update for this slug on the whole page, and it is on the row.
    const origin = path.join(fixtureHome, 'native-plugin-repo')
    await fs.writeFile(path.join(origin, 'FIXTURE-NOTES.md'), 'A third upstream change.\n')
    await commitAll(origin, 'Upstream change three')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(rowChip).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(cardChip).toHaveAttribute('data-update-kind', 'available')
    await expect(page.locator('[data-testid="plugin-update-walnut-demo"], [data-testid="plugin-update-source-native-plugin-repo"]')).toHaveCount(1)
    await expect(page.getByTestId('plugin-update-walnut-demo')).toBeVisible()
    await page.getByTestId('plugin-update-walnut-demo').click()
    await expect(page.getByTestId('plugin-update-feedback-walnut-demo')).toContainText('Updated to', { timeout: 60_000 })
    await expect(cardChip).toHaveAttribute('data-update-kind', 'current', { timeout: 5_000 })
    await expect(page.getByTestId('plugin-update-feedback-source-native-plugin-repo')).toHaveCount(0)
  })

  test('(h) offline: header says Offline, Check now is disabled, nothing is requested; back online checks once', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not flip navigator.onLine under setOffline')
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    await expect(page.getByTestId('update-chip-walnut-demo')).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const gets: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/plugin-updates') gets.push(req.url())
    })
    await context.setOffline(true)
    try {
      const checkedAt = page.getByTestId('plugin-updates-checked-at')
      await expect(checkedAt).toHaveText(/^Offline · last checked /)
      const checkNow = page.getByTestId('plugin-updates-check-now')
      await expect(checkNow).toBeDisabled()
      await expect(checkNow).toHaveAttribute('title', 'You are offline. Check again when you are back online.')
      await page.waitForTimeout(1_500)
      expect(gets).toEqual([])
      // Chips keep what they knew, marked stale (C49); no wall of warnings.
      await expect(page.getByTestId('update-chip-walnut-demo')).toContainText('Up to date')
      await expect(page.getByTestId('update-chip-walnut-demo')).toHaveClass(/plugin-update-chip--stale/)
      // Two passive GETs closer than 5 s collapse (online + the WS reconnect that follows it),
      // so the network comes back more than 5 s after the GET that opened the section.
      await page.waitForTimeout(4_500)
    } finally {
      await context.setOffline(false)
    }
    await expect.poll(() => gets.length, { timeout: 15_000 }).toBe(1)
    await expect(page.getByTestId('update-chip-walnut-demo')).not.toHaveClass(/plugin-update-chip--stale/)
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked /, { timeout: 15_000 })
    await expect(page.getByTestId('plugin-updates-check-now')).toBeEnabled()
  })

  test('(C28) a failing status GET shows Could not check with Retry; rows keep their chips', async ({ page }) => {
    await page.route('**/api/plugin-updates*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }))
    try {
      await page.goto(`http://127.0.0.1:${fixturePort}/`)
      await openPlugins(page)
      const checkedAt = page.getByTestId('plugin-updates-checked-at')
      await expect(checkedAt).toHaveText('Could not check', { timeout: 30_000 })
      await expect(page.getByTestId('plugin-updates-retry')).toBeVisible()
      // ONE verb after a failed GET: Retry replaces Check now, never both (N9).
      await expect(page.getByTestId('plugin-updates-check-now')).toHaveCount(0)
      expect((await page.locator('.plugin-store-updates-head').innerText()).replace(/\s+/g, ' ').trim()).toBe('Could not check · Retry')
      const chip = page.getByTestId('update-chip-acme-tracker')
      await expect(chip).toBeVisible()
      expect(['pending', 'unchecked']).toContain(await chip.getAttribute('data-update-kind'))
      await expect(page.getByTestId('plugin-row-acme-tracker')).toBeVisible()
    } finally {
      await page.unroute('**/api/plugin-updates*')
    }
    await page.getByTestId('plugin-updates-retry').click()
    await expect(page.getByTestId('update-chip-acme-tracker')).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked /)
    await expect(page.getByTestId('plugin-updates-retry')).toHaveCount(0)
  })

  test('(n) Tab order follows the DOM: chip, provenance, then the actions', async ({ page, browserName }) => {
    // Safari reaches buttons with Option+Tab (plain Tab walks text fields only).
    const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const chip = page.getByTestId('update-chip-walnut-demo')
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const row = page.getByTestId('plugin-row-walnut-demo')
    const expected = await row.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]'))
      .filter((node) => !node.hasAttribute('disabled') && node.tabIndex >= 0)
      .map((node) => node.dataset.testid || node.id || node.textContent?.trim() || ''))
    expect(expected[0]).toBe('update-chip-walnut-demo')
    expect(expected[1]).toBe('provenance-trigger-walnut-demo')
    expect(expected.slice(2)).toEqual(expect.arrayContaining(['Remove', 'plugin-toggle-walnut-demo']))
    expect(expected.indexOf('Remove')).toBeLessThan(expected.indexOf('plugin-toggle-walnut-demo'))
    await chip.focus()
    const seen: string[] = []
    for (let i = 0; i < expected.length; i += 1) {
      seen.push(await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null
        return node?.dataset.testid || node?.id || node?.textContent?.trim() || ''
      }))
      await page.keyboard.press(tabKey)
    }
    expect(seen).toEqual(expected)
    // Enter and Space on the header button work like a click (it goes busy, then settles).
    const checkNow = page.getByTestId('plugin-updates-check-now')
    await checkNow.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked just now/, { timeout: 30_000 })
  })

  test('(e)(C34)(C35) light, dark and 960px: screenshots, contrast, one-line actions', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    for (const id of UPDATABLE) {
      await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    }
    await fs.mkdir(UPDATE_SHOT_DIR, { recursive: true })
    const installed = page.getByTestId('plugin-store-installed')
    // A MIX of chip kinds for the shots and the contrast pass, not three "Up to date": the git
    // source goes behind (available, blue) and the linked checkout gets a scratch file (dirty,
    // amber), so the colours that failed 4.5:1 on the light card are the ones measured (C34, N5).
    const origin = path.join(fixtureHome, 'native-plugin-repo')
    await fs.writeFile(path.join(origin, 'FIXTURE-NOTES.md'), 'A shot-time upstream change.\n')
    await commitAll(origin, 'Upstream change for the shots')
    const scratch = path.join(fixtureHome, 'linked-work', 'acme-notes', 'scratch.txt')
    await fs.writeFile(scratch, 'uncommitted for the shots\n')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(page.getByTestId('update-chip-walnut-demo')).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(page.getByTestId('update-chip-acme-tracker')).toHaveAttribute('data-update-kind', 'dirty', { timeout: 30_000 })
    await expect(page.getByTestId('update-chip-acme-notes')).toHaveAttribute('data-update-kind', 'dirty')
    const chips = page.locator('[data-testid^="update-chip-"]')
    const contrastAll = async (theme: string) => {
      const kinds = new Set<string>()
      for (let i = 0; i < await chips.count(); i += 1) {
        const chip = chips.nth(i)
        const kind = (await chip.getAttribute('data-update-kind')) ?? ''
        kinds.add(kind)
        // Soft, so every chip in both themes is measured and reported in one run.
        expect.soft(await contrastAgainstCard(chip), `${theme} chip ${i} (${kind}) contrast`).toBeGreaterThanOrEqual(4.5)
        // Outline chip, never a solid badge: transparent background.
        expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
      }
      expect([...kinds].sort()).toEqual(['available', 'dirty'])
      // The 12px header time reads at 4.5:1 too (N20).
      expect.soft(await contrastAgainstCard(page.getByTestId('plugin-updates-checked-at')), `${theme} header contrast`).toBeGreaterThanOrEqual(4.5)
    }
    // Viewport shots (the section scrolls inside the settings pane, so an element shot
    // would only show the part on screen anyway); the group head is scrolled to the top.
    const shoot = async (name: string) => {
      // Picking a theme scrolls the pane to the theme picker; wait until the group's head
      // is actually on screen (WebKit finishes the scroll a frame late) before shooting.
      // The nav click's own smooth scroll can land AFTER an instant scroll here (WebKit), so
      // scroll, let a few frames pass, and repeat until the head stays put near the top.
      const head = installed.locator('.plugin-store-group-head')
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await installed.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior }))
        await page.waitForTimeout(200)
        const top = (await head.boundingBox())?.y ?? -1
        if (top >= 0 && top < 160) break
      }
      await expect(head).toBeInViewport()
      await page.screenshot({ path: path.join(UPDATE_SHOT_DIR, name) })
    }
    await shoot('installed-light.png')
    await contrastAll('light')
    await pickTheme(page, 'Dark')
    await shoot('installed-dark.png')
    await contrastAll('dark')
    await pickTheme(page, 'Light')

    await page.setViewportSize({ width: 960, height: 800 })
    await expect(page.getByTestId('plugin-updates-check-now')).toBeVisible()
    const rows = installed.locator('.settings-row')
    for (let i = 0; i < await rows.count(); i += 1) {
      const row = rows.nth(i)
      const measured = await row.evaluate((el) => {
        const actions = el.querySelector('.settings-row-actions')
        const rowRect = el.getBoundingClientRect()
        const kids = actions ? Array.from(actions.children) as HTMLElement[] : []
        return {
          tops: kids.map((k) => k.getBoundingClientRect().top),
          bottoms: kids.map((k) => k.getBoundingClientRect().bottom),
          rights: kids.map((k) => k.getBoundingClientRect().right),
          rowRight: rowRect.right,
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }
      })
      // One line: every control overlaps every other vertically (a centred switch is
      // shorter than a button, so identical tops would be the wrong test).
      if (measured.tops.length > 1) {
        expect(Math.max(...measured.tops), `row ${i} actions on one line`).toBeLessThan(Math.min(...measured.bottoms))
      }
      for (const right of measured.rights) expect(right).toBeLessThanOrEqual(measured.rowRight + 1)
      expect(measured.scroll).toBeLessThanOrEqual(measured.client + 1)
    }
    // The chip stays whole: one line tall, wherever the title line wrapped it.
    for (const id of UPDATABLE) {
      const chip = page.getByTestId(`update-chip-${id}`)
      const height = await chip.evaluate((el) => el.clientHeight)
      expect(height).toBeLessThanOrEqual(26)
    }
    // Nothing scrolls sideways at 960px: neither the Installed group nor the settings pane
    // (N6). On failure the message names the descendants that stick out.
    for (const selector of ['[data-testid="plugin-store-installed"]', '.settings-content']) {
      const measured = await page.locator(selector).evaluate((el) => {
        const box = el.getBoundingClientRect()
        const out: string[] = []
        for (const node of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
          const r = node.getBoundingClientRect()
          if (r.width > 0 && r.right > box.right + 1) {
            const section = node.closest('.settings-section')?.id ?? '?'
            out.push(`#${section} ${node.tagName.toLowerCase()}#${node.id}.${String(node.className).split(' ').slice(0, 2).join('.')} right=${Math.round(r.right)} (box ${Math.round(box.right)})`)
          }
        }
        return { scroll: el.scrollWidth, client: el.clientWidth, out: out.slice(0, 8) }
      })
      expect(measured.scroll, `${selector} overflows: ${measured.out.join('; ')}`).toBeLessThanOrEqual(measured.client)
    }
    await shoot('installed-narrow.png')
    // The flyout is still whole at 960px wide.
    await page.getByTestId('provenance-trigger-acme-notes').click()
    const flyout = page.getByTestId('provenance-flyout-acme-notes')
    await expect(flyout).toBeVisible()
    const rect = (await flyout.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(960)
    expect(rect.y + rect.height).toBeLessThanOrEqual(800)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1280, height: 800 })
    // Back to a clean fixture for the tests after this one: take the source update, drop the
    // scratch file and re-check the checkout.
    await fs.rm(scratch, { force: true })
    await page.getByTestId('plugin-update-walnut-demo').click()
    await expect(page.getByTestId('plugin-update-feedback-walnut-demo')).toContainText('Updated to', { timeout: 60_000 })
    await page.getByTestId('update-chip-acme-tracker').click()
    for (const id of UPDATABLE) {
      await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    }
  })

  test('(N1)(N2) a failed Update is one sentence with the raw text behind Details; the stale chip keeps its count', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const tracker = page.getByTestId('update-chip-acme-tracker')
    await expect(tracker).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const publisher = path.join(fixtureHome, 'linked-publisher')
    await fs.writeFile(path.join(publisher, 'acme-tracker', 'CHANGES.md'), 'upstream for the failure test\n')
    await commitAll(publisher, 'Publisher change for the failure test')
    await git(publisher, 'push', 'origin', 'main')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(tracker).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await expect(tracker).toContainText('1 commit behind')
    const origin = path.join(fixtureHome, 'linked-origin.git')
    await fs.rename(origin, `${origin}.away`)
    try {
      // Update against a remote that is gone: the row says ONE sentence, never git's own words.
      await page.getByTestId('plugin-update-acme-tracker').click()
      const feedback = page.getByTestId('plugin-update-feedback-acme-tracker')
      await expect(feedback).toContainText('Could not update:', { timeout: 60_000 })
      const line = await feedback.locator('.plugin-update-feedback-text').innerText()
      expect(line).toMatch(/^Could not update: /)
      expect(line).not.toMatch(/(^|[\s'"])\/(Users|home|private|var|tmp|opt)\//)
      expect(line).not.toMatch(/fatal:|git exited|error:/)
      expect(line).not.toMatch(/linked-work|linked-publisher/)
      expect(line.length).toBeLessThanOrEqual(160)
      // The raw text is one click away, and only there.
      const details = feedback.getByRole('button', { name: 'Details' })
      await expect(details).toBeVisible()
      await details.click()
      const detail = feedback.locator('.plugin-update-detail')
      await expect(detail).toBeVisible()
      expect(await detail.innerText()).toMatch(/fatal:|does not appear to be a git repository|linked-origin/)
      // A re-check while the remote is gone keeps the count it knew (N2): 1 COMMIT BEHIND, stale,
      // never a vaguer UPDATE AVAILABLE; the tooltip is scrubbed and ends in whole words.
      await tracker.click()
      await expect(tracker).toHaveAttribute('data-update-kind', 'unreachable', { timeout: 30_000 })
      await expect(tracker).toHaveClass(/plugin-update-chip--stale/)
      await expect(tracker).toContainText('1 commit behind')
      await expect(tracker).not.toContainText('Update available')
      await expect(page.getByTestId('update-chip-acme-notes')).toContainText('1 commit behind')
      const title = (await tracker.getAttribute('title')) ?? ''
      expect(title).toContain('Last checked')
      expect(title).not.toMatch(/(^|[\s'"])\/(Users|home|private|var|tmp|opt)\//)
      expect(title).not.toMatch(/fatal:|git exited/)
      expect(title).toMatch(/(does not appear to be a git repository\.|…) Click to check again\.$/)
      expect(title.length).toBeLessThanOrEqual(120 + 'Could not reach the remote just now. Last checked 59 minutes ago.  Click to check again.'.length)
      // The Update stays for the last known available, disabled with the offline reason.
      await expect(page.getByTestId('plugin-update-acme-tracker')).toBeDisabled()
      await expect(page.getByTestId('plugin-update-wrap-acme-tracker')).toHaveAttribute('title', /Could not reach the remote/)
    } finally {
      await fs.rename(`${origin}.away`, origin)
    }
    await tracker.click()
    await expect(tracker).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    await page.getByTestId('plugin-update-acme-tracker').click()
    await expect(page.getByTestId('plugin-update-feedback-acme-tracker')).toContainText('Updated to', { timeout: 60_000 })
    await expect(tracker).toHaveAttribute('data-update-kind', 'current', { timeout: 5_000 })
  })

  test('(N3) coming back to the window re-reads status: a fix made outside Walnut shows without a click', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    const tracker = page.getByTestId('update-chip-acme-tracker')
    await expect(tracker).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    const publisher = path.join(fixtureHome, 'linked-publisher')
    await fs.writeFile(path.join(publisher, 'acme-tracker', 'CHANGES.md'), 'upstream for the focus test\n')
    await commitAll(publisher, 'Publisher change for the focus test')
    await git(publisher, 'push', 'origin', 'main')
    await page.getByTestId('plugin-updates-check-now').click()
    await expect(tracker).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
    // The batch is over (no poll in flight) before the passive reads are counted.
    await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText(/^Checked /)
    await expect(page.getByTestId('plugin-updates-check-now')).toBeEnabled()
    const gets: string[] = []
    const posts: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (req.method() === 'GET' && url.pathname === '/api/plugin-updates') gets.push(url.search)
      if (req.method() === 'POST' && /\/(linked\/check|plugin-sources\/[^/]+\/check)$/.test(url.pathname)) posts.push(url.pathname)
    })
    // The user pulls in a terminal. Walnut did not do it, so only a fresh read can know.
    await git(path.join(fixtureHome, 'linked-work'), 'pull', '--ff-only')
    // A window switch minutes after a check asks nothing (C60): the check is fresh.
    await page.waitForTimeout(1_100)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(1_500)
    expect(gets, 'a fresh check gates the focus re-read').toEqual([])
    // Eleven minutes later (page clock only; the server keeps real time and so serves its
    // cache without fetching) the same focus is one passive GET.
    await page.clock.setSystemTime(Date.now() + 11 * 60_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => gets.length, { timeout: 10_000 }).toBe(1)
    await expect(tracker).toHaveAttribute('data-update-kind', 'current', { timeout: 15_000 })
    await expect(page.getByTestId('update-chip-acme-notes')).toHaveAttribute('data-update-kind', 'current')
    expect(posts).toEqual([])
    // A passive read never fetches: the header time is the last real check, not "just now"
    // (the server keeps its own 10 min gate), and the GET carried no refresh flag.
    expect(gets[0]).not.toContain('refresh=1')
    // Coming back through visibility does the same, once per return, not once per event.
    // Two passive reads closer than PASSIVE_DEBOUNCE_MS (5 s) collapse, so wait it out first.
    await page.waitForTimeout(5_500)
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(() => gets.length, { timeout: 10_000 }).toBe(2)
    await page.waitForTimeout(1_500)
    expect(gets.length).toBe(2)
  })

  test('(N4) a source added through the form gets its chip without a click; Remove re-reads too', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    await expect(page.getByTestId('update-chip-walnut-demo')).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    // A second git source with one plugin, made here under the fixture home.
    const repo = path.join(fixtureHome, 'second-source-repo')
    await fs.mkdir(path.join(repo, 'sample-second'), { recursive: true })
    await fs.writeFile(path.join(repo, 'sample-second', 'manifest.json'), JSON.stringify({
      id: 'sample-second',
      name: 'Sample Second',
      description: 'A second source for the update tests',
      version: '0.1.0',
      apiVersion: 1,
      engines: { walnut: '>=0.3.2' },
      server: 'server.mjs',
    }, null, 2))
    await fs.writeFile(path.join(repo, 'sample-second', 'server.mjs'), 'export function activate() {}\n')
    await git(repo, 'init', '--initial-branch=main')
    await commitAll(repo, 'Add the second source fixture')
    const gets: string[] = []
    const posts: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (req.method() === 'GET' && url.pathname === '/api/plugin-updates') gets.push(url.search)
      if (req.method() === 'POST' && /\/(linked\/check|plugin-sources\/[^/]+\/check)$/.test(url.pathname)) posts.push(url.pathname)
    })
    const pluginStore = page.locator('#plugin-store')
    await pluginStore.locator('#plugin-source-url').fill(pathToFileURL(repo).href)
    await pluginStore.getByTestId('plugin-trust-confirm').check()
    await pluginStore.getByRole('button', { name: 'Add', exact: true }).click()
    const row = page.getByTestId('plugin-row-sample-second')
    await expect(row).toBeVisible({ timeout: 30_000 })
    // Settles to Up to date on its own: no chip click, no per-row POST, no reload.
    const chip = page.getByTestId('update-chip-sample-second')
    await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    await expect(chip).toContainText('Up to date')
    await expect(page.getByTestId('update-chip-source-second-source-repo')).toHaveAttribute('data-update-kind', 'current')
    expect(posts).toEqual([])
    expect(gets.length).toBeGreaterThanOrEqual(1)
    // Remove the source: its card goes, and status is re-read for what is left. (The loaded
    // plugin itself stays in memory until a restart; the page says so in its banner.) The
    // Installed row owns Remove while the plugin is loaded; the card has none (N3-17).
    const before = gets.length
    const card = page.getByTestId('plugin-source-second-source-repo')
    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(0)
    expect(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 'one Remove per source page-wide')
      .toBe(await page.locator('.plugin-store-source').count())
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(card).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => gets.length, { timeout: 10_000 }).toBeGreaterThan(before)
    await expect(page.getByTestId('update-chip-walnut-demo')).toHaveAttribute('data-update-kind', 'current')
  })

  test('(k)(C20)(C21)(C22) provenance flyout: four rows, ~ path, full-path copy, in viewport, Esc returns focus', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${fixturePort}/`)
    await openPlugins(page)
    await ensureSourceInstalled(page)
    await expect(page.getByTestId('update-chip-acme-tracker')).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    // No text glyphs anywhere in a chip or a trigger; the trigger is a real 24px target.
    for (const id of UPDATABLE) {
      expect(await page.getByTestId(`update-chip-${id}`).textContent()).not.toMatch(BANNED_GLYPHS)
      expect(await page.getByTestId(`provenance-trigger-${id}`).textContent()).not.toMatch(BANNED_GLYPHS)
      expect(await page.getByTestId(`update-chip-${id}`).locator('svg[stroke="currentColor"]').count()).toBeGreaterThan(0)
    }
    const trigger = page.getByTestId('provenance-trigger-acme-tracker')
    const box = (await trigger.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(24)
    expect(box.height).toBeGreaterThanOrEqual(24)
    await page.evaluate(() => {
      document.addEventListener('copy', (e) => {
        (window as unknown as { __copied?: string }).__copied = e.clipboardData?.getData('text/plain') ?? ''
      })
    })
    await trigger.click()
    const flyout = page.getByTestId('provenance-flyout-acme-tracker')
    await expect(flyout).toBeVisible()
    await expect(flyout).toHaveAttribute('role', 'dialog')
    expect(await flyout.locator('dt').allTextContents()).toEqual(['Checkout', 'Branch', 'Commit', 'Remote'])
    const values = await flyout.locator('dd').evaluateAll((els) => els.map((el) => Array.from(el.childNodes)
      .filter((node) => !(node instanceof HTMLButtonElement))
      .map((node) => node.textContent ?? '').join('').trim()))
    // Needs the server's homeDir on /registry (or a checkoutDisplay per row): the client only folds.
    expect.soft(values[0], 'Checkout is shown relative to the home directory').toMatch(/^~\//)
    expect.soft(values[0]).not.toMatch(/^\/(Users|home|private|var)/)
    expect(values[1]).toContain('main')
    expect(values[2]).toMatch(/[0-9a-f]{7}/)
    expect(values[3]).not.toMatch(/^(file|https?|ssh):\/\//)
    await flyout.getByRole('button', { name: 'Copy path' }).click()
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '')
    expect(copied).toMatch(/^\//)
    expect(copied.endsWith('linked-work')).toBe(true)
    const viewport = page.viewportSize()!
    const rect = (await flyout.boundingBox())!
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width)
    // The flyout hangs off the trigger: left edges aligned, not opening from its right edge (N15).
    expect(Math.abs(rect.x - box.x)).toBeLessThanOrEqual(1)
    // Clicking inside keeps it open; Esc (with focus in the dialog) closes and returns
    // focus to the trigger.
    await flyout.locator('dt').first().click()
    await expect(flyout).toBeVisible()
    await flyout.getByRole('button', { name: /Copy path|Copied/ }).focus()
    await page.keyboard.press('Escape')
    await expect(flyout).toHaveCount(0)
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
    // Outside click closes too.
    await trigger.click()
    await expect(flyout).toBeVisible()
    await page.getByTestId('plugin-store-installed').locator('.plugin-store-group-head').click({ position: { x: 4, y: 4 } })
    await expect(flyout).toHaveCount(0)
    // The source card sits at the bottom of the page: its flyout still lands in the viewport.
    const sourceTrigger = page.getByTestId('provenance-trigger-source-native-plugin-repo')
    await sourceTrigger.scrollIntoViewIfNeeded()
    await sourceTrigger.click()
    const sourceFlyout = page.getByTestId('provenance-flyout-source-native-plugin-repo')
    await expect(sourceFlyout).toBeVisible()
    expect(await sourceFlyout.locator('dt').allTextContents()).toEqual(['Source', 'Installed at', 'Id'])
    await expect(sourceFlyout.locator('dd').first()).toContainText('file://')
    await expect(sourceFlyout.getByRole('button', { name: 'Copy URL' })).toBeVisible()
    const sourceRect = (await sourceFlyout.boundingBox())!
    expect(sourceRect.y + sourceRect.height).toBeLessThanOrEqual(viewport.height)
    expect(sourceRect.y).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('Escape')
    await expect(sourceFlyout).toHaveCount(0)
  })
})

test('reloads, isolates a render crash, restores, adapts to mobile, and disables cleanly', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await openDemo(page)

  const installedBundle = path.join(
    fixtureHome,
    'plugin-stores',
    'native-plugin-repo',
    'dist',
    'web.mjs',
  )
  const originalBundle = await fs.readFile(installedBundle, 'utf8')
  expect(originalBundle).toContain('Native plugin app')
  await fs.writeFile(installedBundle, originalBundle.replace('Native plugin app', 'Native plugin app reloaded'))
  const reload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
  expect(reload.ok(), await reload.text()).toBe(true)
  await openDemo(page)
  await expect(page.getByText('Native plugin app reloaded', { exact: true })).toBeVisible({ timeout: 30_000 })

  const crashBundle = `
export async function activate(walnut) {
  function CrashApp() { throw new Error('Plugin App fixture crash'); }
  walnut.ui.app({ id: 'main', title: 'Plugin Demo', component: CrashApp });
}
`
  await fs.writeFile(installedBundle, crashBundle)
  try {
    const crashReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
    expect(crashReload.ok(), await crashReload.text()).toBe(true)
    await expandSidebar(page)
    await page.getByTestId('sidebar-app-walnut-demo:main').click()
    await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
    await expect(page.getByText('Walnut Plugin Demo failed to render')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Plugin App fixture crash')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
  } finally {
    await fs.writeFile(installedBundle, originalBundle)
    const recoveryReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
    if (!recoveryReload.ok()) {
      throw new Error(`Plugin recovery reload failed: ${await recoveryReload.text()}`)
    }
  }
  await openDemo(page)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.sidebar-toggle').click()
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  await expect(page.getByTestId('plugin-demo-layout-mode')).toContainText('compact')
  expect(await page.getByTestId('plugin-demo-app').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const [toggleBounds, kickerBounds] = await Promise.all([
    page.locator('.sidebar-toggle').boundingBox(),
    page.getByText('Native plugin app', { exact: true }).boundingBox(),
  ])
  expect(toggleBounds).not.toBeNull()
  expect(kickerBounds).not.toBeNull()
  expect(kickerBounds!.y).toBeGreaterThanOrEqual(toggleBounds!.y + toggleBounds!.height)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'mobile.png'), fullPage: true })

  const disable = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/disable`)
  expect(disable.ok(), await disable.text()).toBe(true)
  await expect(page.getByTestId('sidebar-app-walnut-demo:main')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('style[data-walnut-plugin="walnut-demo"]')).toHaveCount(0)
  // Disabling the plugin while its App page is open does NOT teleport the reader
  // home. The page says the App is gone and offers the way back, which is what the
  // placement work deliberately replaced the silent bounce to `/` with — a reader
  // dropped on Home cannot tell a typo from a broken plugin.
  await expect(page.getByTestId('plugin-app-not-found')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/apps/walnut-demo~main$`))
  const statsAfterDisable = await page.request.get(`http://127.0.0.1:${fixturePort}/api/plugins/walnut-demo/stats`)
  expect(statsAfterDisable.status()).toBe(404)

  await page.setViewportSize({ width: 1280, height: 800 })
  // And the way back works: the card's own link, clicked, is how the reader leaves.
  await page.getByRole('link', { name: 'Back to Walnut' }).click()
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/$`))
  const composer = page.locator('.main-page-chat .chat-input-textarea')
  await composer.click()
  // Typed, and anchored on an App that IS there: the palette renders nothing when
  // no command matches, so a bare absence assertion would pass even if the
  // palette never opened.
  await composer.pressSequentially('/app:', { delay: 15 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:core:tasks' }))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await composer.fill('')
  await openSettings(page)
  await expect(page.getByTestId('settings-nav-walnut-demo:demo')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
