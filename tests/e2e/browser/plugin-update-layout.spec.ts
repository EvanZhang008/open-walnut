/**
 * Settings, Plugins update status: the round-two nitpicks (N2-1 .. N2-11) and C30, each
 * pinned against the real fixture (linked checkout pair + git source) in both engines.
 * Boots its own fixture server (see plugin-update-fixture.ts); serial, one page at a time.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  commitAll, ensureSourceInstalled, expandSidebar, git, startPluginFixture, type PluginFixture,
} from './plugin-update-fixture'

const SHOT_DIR = '/tmp/plugin-update-ux/after'
let fixture: PluginFixture

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  fixture = await startPluginFixture()
})
test.afterAll(async () => { await fixture?.stop() })

const UPDATABLE = ['acme-tracker', 'acme-notes', 'walnut-demo'] as const

/**
 * Settings, Plugins, through real clicks. The sidebar's Settings link returns to the last
 * pane Settings showed (`/settings#plugin-store` after the first test), so the URL may carry
 * a pane hash; the nav click then opens Plugins either way.
 */
async function openPlugins(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings(#[\w-]+)?$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}

async function openWithChips(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await openPlugins(page)
  await ensureSourceInstalled(page, fixture.home)
  for (const id of UPDATABLE) {
    await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
  }
}

/** Every chip back to current: take a pending source update, re-check the checkout. */
async function settleCurrent(page: Page): Promise<void> {
  await page.getByTestId('plugin-updates-check-now').click()
  for (const id of UPDATABLE) {
    await expect(page.getByTestId(`update-chip-${id}`)).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
  }
}

const rect = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
})

/**
 * Theme through General, back to Plugins. The sidebar's Settings link now returns to the
 * last pane (Plugins here), so General is opened with its own nav click first.
 */
async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-general').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}

async function collapseSidebar(page: Page): Promise<void> {
  if (await page.locator('.sidebar.collapsed').count()) return
  await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(1)
}

/**
 * Snapshots of one row on every DOM mutation: feedback text, Update label, chip kind. A
 * frame where feedback says "Updated to" while the button or chip still says Updating is
 * the N2-6 contradiction.
 */
const ROW_RECORDER = `(rowId) => {
  const frames = [];
  const row = document.querySelector('[data-testid="plugin-row-' + rowId + '"]');
  const snap = () => {
    const fb = row.querySelector('[data-testid="plugin-update-feedback-' + rowId + '"]');
    const btn = row.querySelector('[data-testid="plugin-update-' + rowId + '"]');
    const chip = row.querySelector('[data-testid="update-chip-' + rowId + '"]');
    frames.push({
      feedback: fb ? fb.textContent : '',
      button: btn ? btn.textContent : null,
      chip: chip ? chip.getAttribute('data-update-kind') : null,
    });
  };
  new MutationObserver(snap).observe(row, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__rowFrames = frames;
}`

test('(N2-1)(N2-2)(N2-6)(N2-10) an Update flips in one frame, costs one reload, and the chip stays on the title line', async ({ page }) => {
  await openWithChips(page)
  const origin = path.join(fixture.home, 'native-plugin-repo')
  await fs.writeFile(path.join(origin, 'LAYOUT-NOTES.md'), 'upstream change for the layout test\n')
  await commitAll(origin, 'Upstream change for the layout test')
  await page.getByTestId('plugin-updates-check-now').click()
  const demoChip = page.getByTestId('update-chip-walnut-demo')
  await expect(demoChip).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
  await expect(page.getByTestId('plugin-updates-check-now')).toBeEnabled()

  // Requests made by the page after the POST: one coalesced reload of each list (N2-10).
  const gets: Record<string, number> = {}
  let posted = false
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/update')) posted = true
    if (!posted || req.method() !== 'GET') return
    const p = new URL(req.url()).pathname
    if (['/api/plugin-runtime/registry', '/api/plugin-sources', '/api/plugin-runtime'].includes(p)) gets[p] = (gets[p] ?? 0) + 1
  })
  await page.evaluate(`(${ROW_RECORDER})('walnut-demo')`)
  await page.getByTestId('plugin-update-walnut-demo').click()
  const feedback = page.getByTestId('plugin-update-feedback-walnut-demo')
  await expect(feedback).toContainText('Updated to', { timeout: 60_000 })
  await expect(demoChip).toHaveAttribute('data-update-kind', 'current')
  await page.waitForTimeout(2_000)
  const frames = await page.evaluate(() => (window as unknown as { __rowFrames: Array<{ feedback: string; button: string | null; chip: string | null }> }).__rowFrames)
  const contradictions = frames.filter((f) => f.feedback.includes('Updated to') && (f.button?.includes('Updating') || f.chip === 'checking'))
  expect(contradictions, `frames where feedback and controls disagree: ${JSON.stringify(contradictions.slice(0, 3))}`).toEqual([])
  expect(gets['/api/plugin-runtime/registry'] ?? 0, `registry GETs ${JSON.stringify(gets)}`).toBeLessThanOrEqual(2)
  expect(gets['/api/plugin-sources'] ?? 0, `sources GETs ${JSON.stringify(gets)}`).toBeLessThanOrEqual(2)
  expect(gets['/api/plugin-runtime'] ?? 0, `runtime GETs ${JSON.stringify(gets)}`).toBeLessThanOrEqual(2)

  // The row now reads "Walnut Plugin Demo  RESTART TO ACTIVATE  v0.1.0  UP TO DATE" with only
  // Remove + toggle on the right: the chip stays on the title line at 1280 with the sidebar
  // open (N2-1), and the actions cluster is sized to its controls, not a 280px floor.
  await page.setViewportSize({ width: 1280, height: 800 })
  const row = page.getByTestId('plugin-row-walnut-demo')
  // The server now hot reloads an updated plugin (feedback "Updated to ..., reloaded"), so a
  // "Restart to activate" tag shows only when it could not; the layout holds either way.
  await expect(row).toBeVisible()
  const title = row.locator('.settings-row-copy .plugin-store-name')
  const titleBox = await rect(title)
  const chipBox = await rect(demoChip)
  expect(chipBox.top, 'chip sits on the title line').toBeLessThan(titleBox.top + 12)
  expect(titleBox.height, 'title block is one line').toBeLessThan(30)
  const actions = row.locator('.settings-row-actions')
  const actionsBox = await rect(actions)
  // Sized to its controls (the Update slot, Remove with its Confirm reserve, the switch) plus
  // the gaps between them, never a fixed floor. Font metrics differ per engine, so the sum is
  // measured rather than hardcoded.
  const fit = await actions.evaluate((el) => {
    const kids = Array.from(el.children).filter((c) => c.getBoundingClientRect().width > 0)
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0
    return {
      sum: kids.reduce((n, c) => n + c.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1),
      parts: kids.map((c) => `${c.tagName.toLowerCase()}.${(c as HTMLElement).className}:${Math.round(c.getBoundingClientRect().width)}`),
    }
  })
  expect(actionsBox.width, `actions ${fit.parts.join(' ')}`).toBeLessThanOrEqual(fit.sum + 1)
  expect(actionsBox.width).toBeLessThan(280)
  // Neighbouring rows keep the same height (the chip wrapping used to add 40px).
  const heights = await page.locator('[data-testid="plugin-store-installed"] .settings-row').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(40)

  // Sources card: the actions cluster is one line, whole (N2-2). While the plugin is loaded
  // the Installed row owns Update AND Remove (N3-17), so the card keeps only its own verb.
  const sourceActions = page.getByTestId('plugin-source-native-plugin-repo').locator('.plugin-store-source-actions')
  const buttons = sourceActions.locator('button')
  const tops = await buttons.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  expect(tops.length).toBeGreaterThanOrEqual(1)
  expect(new Set(tops).size, `source action tops ${tops.join(',')}`).toBe(1)
  await expect(sourceActions.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await expect(page.getByTestId('plugin-row-walnut-demo').getByRole('button', { name: 'Remove' })).toHaveCount(1)
  const sourceTitle = page.getByTestId('plugin-source-native-plugin-repo').locator('.plugin-store-source-title')
  const [titleR, actR] = [await rect(sourceTitle), await rect(sourceActions)]
  // Either on the title line or entirely under it; never straddling.
  expect(actR.top < titleR.bottom ? actR.left >= titleR.right - 1 : actR.top >= titleR.bottom - 1).toBe(true)

  // 960 wide, sidebar collapsed (card about 626px): controls stay on the right of the copy.
  await page.setViewportSize({ width: 960, height: 800 })
  await collapseSidebar(page)
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible()
  const rows = page.locator('[data-testid="plugin-store-installed"] .settings-row')
  for (let i = 0; i < await rows.count(); i += 1) {
    const r = rows.nth(i)
    const geometry = await r.evaluate((el) => {
      // A feedback line under a row ("Updated to ...") is a row with no copy or actions.
      const copyEl = el.querySelector('.settings-row-copy')
      const acts = el.querySelector('.settings-row-actions')
      if (!acts || !copyEl) return null
      const copy = copyEl.getBoundingClientRect()
      const a = acts.getBoundingClientRect()
      const kids = Array.from(acts.children).map((k) => k.getBoundingClientRect())
      const rowBox = el.getBoundingClientRect()
      return {
        id: el.getAttribute('data-testid'),
        inner: el.clientWidth - 24,
        actionsWidth: a.width,
        copyRight: copy.right, copyTop: copy.top,
        left: a.left, top: a.top,
        kidTops: kids.map((k) => Math.round(k.top)), kidBottoms: kids.map((k) => k.bottom),
        rowRight: rowBox.right, kidRights: kids.map((k) => k.right),
      }
    })
    if (!geometry) continue
    const label = `${geometry.id} (inner ${Math.round(geometry.inner)}, actions ${Math.round(geometry.actionsWidth)})`
    // The rule: the cluster stays beside the copy while the copy keeps 320px; only when it
    // cannot does the WHOLE cluster drop under the copy, left-aligned.
    const fits = geometry.inner - 16 - geometry.actionsWidth >= 320
    if (fits) {
      expect(geometry.top, `${label} actions beside the copy`).toBeLessThan(geometry.copyTop + 30)
      expect(geometry.left, `${label} actions to the right of the copy`).toBeGreaterThanOrEqual(geometry.copyRight - 1)
    } else {
      expect(geometry.left, `${label} dropped cluster is left-aligned`).toBeLessThan(geometry.copyRight)
    }
    if (geometry.kidTops.length > 1) expect(Math.max(...geometry.kidTops), `${label} one line`).toBeLessThan(Math.min(...geometry.kidBottoms))
    for (const right of geometry.kidRights) expect(right).toBeLessThanOrEqual(geometry.rowRight + 1)
  }
  // The rows that carry only a switch or Configure + switch beside a 320px copy: every card
  // in this fixture is wide enough for those, so at least one row proves the side-by-side case.
  const beside = await rows.evaluateAll((els) => els.filter((el) => {
    const acts = el.querySelector('.settings-row-actions')
    const copy = el.querySelector('.settings-row-copy')
    return acts && copy && acts.getBoundingClientRect().left >= copy.getBoundingClientRect().right - 1
  }).length)
  expect(beside).toBeGreaterThan(0)
  await page.screenshot({ path: path.join(SHOT_DIR, 'installed-960-sidebar-collapsed.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
})

/**
 * Alpha of a computed colour. A color-mix() result serialises as `color(srgb r g b / a)` in
 * Chromium and `oklab(l a b / a)` or `rgba()` elsewhere, so only the trailing alpha is read.
 */
const alphaOf = (value: string): number => {
  if (value === 'transparent') return 0
  const m = /^(rgba?|color|oklab|oklch|hsla?)\((.*)\)$/.exec(value.trim())
  if (!m) return NaN
  const inner = m[2]
  const slash = inner.indexOf('/')
  if (slash >= 0) return Number(inner.slice(slash + 1).trim().replace('%', '')) / (inner.includes('%', slash) ? 100 : 1)
  const parts = inner.split(/[\s,]+/).filter(Boolean)
  return m[1] === 'rgba' || m[1] === 'hsla' || parts.length === 4 ? Number(parts[3]) : 1
}

const styleOf = (target: Locator) => target.evaluate((el) => {
  const cs = getComputedStyle(el)
  return { color: cs.color, background: cs.backgroundColor, border: cs.borderTopColor, opacity: cs.opacity }
})

test('(N2-5)(N2-7)(N2-8)(N2-11) disabled Update is dimmed in both themes; hover, ahead tooltip and the busy header read right', async ({ page }) => {
  await openWithChips(page)
  const work = path.join(fixture.home, 'linked-work')
  // Ahead by one local commit: the tooltip agrees with the label (N2-7).
  await fs.writeFile(path.join(work, 'acme-tracker', 'AHEAD.md'), 'a local commit, not pushed\n')
  await commitAll(work, 'Local commit for the ahead tooltip')
  const tracker = page.getByTestId('update-chip-acme-tracker')
  await tracker.click()
  await expect(tracker).toHaveText(/Up to date, 1 ahead/i, { timeout: 30_000 })
  await expect(tracker).toHaveAttribute('title', /Nothing newer on the remote; you have 1 commit it does not\./)
  await expect(tracker).not.toHaveAttribute('title', /Same as the remote/)

  // Hover on the quiet chip is visible at a glance (N2-8): full border, a wash behind it.
  const demoChip = page.getByTestId('update-chip-walnut-demo')
  const rest = await styleOf(demoChip)
  await demoChip.hover()
  await page.waitForTimeout(300) // past the 150 ms border transition
  const hover = await styleOf(demoChip)
  expect(alphaOf(hover.border), `hover border ${hover.border}`).toBeGreaterThanOrEqual(0.95)
  expect(alphaOf(hover.background), `hover wash ${hover.background}`).toBeGreaterThan(0.05)
  expect(alphaOf(rest.background), `rest background ${rest.background}`).toBe(0)
  await page.mouse.move(5, 5)

  // Local changes: the disabled Update must not look like an enabled secondary button (N2-5).
  const scratch = path.join(work, 'acme-notes', 'scratch.txt')
  await fs.writeFile(scratch, 'uncommitted\n')
  await tracker.click()
  await expect(tracker).toHaveAttribute('data-update-kind', 'dirty', { timeout: 30_000 })
  const disabled = page.getByTestId('plugin-update-acme-tracker')
  await expect(disabled).toBeDisabled()
  const enabled = page.locator('[data-testid="plugin-store-installed"] button.settings-button-default:not([disabled])').first()
  for (const theme of ['Light', 'Dark'] as const) {
    await pickTheme(page, theme)
    const [dead, live] = [await styleOf(disabled), await styleOf(enabled)]
    expect(dead.color, `${theme}: disabled text differs from an enabled button`).not.toBe(live.color)
    expect(alphaOf(dead.border), `${theme}: disabled has no border (${dead.border})`).toBe(0)
    expect(alphaOf(live.border), `${theme}: enabled has a border (${live.border})`).toBeGreaterThan(0)
    // Legible (not faded out): the label is real text at full opacity in a muted token.
    expect(dead.opacity).toBe('1')
    // For the eye: the dirty linked row (disabled Update) and a row with an enabled Configure.
    await page.getByTestId('plugin-row-acme-tracker').screenshot({ path: path.join(SHOT_DIR, `disabled-update-${theme.toLowerCase()}.png`) })
    await page.getByTestId('plugin-row-calendar').screenshot({ path: path.join(SHOT_DIR, `enabled-configure-${theme.toLowerCase()}.png`) })
  }
  await pickTheme(page, 'Light')

  // The header's Check now while a check runs: dead verb, not the tail of the sentence (N2-11).
  // Only the first refresh is held back (times: 1), so nothing has to be unrouted mid-flight.
  await page.route('**/api/plugin-updates?refresh=1', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await route.continue()
  }, { times: 1 })
  const checkNow = page.getByTestId('plugin-updates-check-now')
  const status = page.getByTestId('plugin-updates-checked-at')
  await checkNow.click()
  await expect(status).toHaveText('Checking for updates...')
  await expect(checkNow).toBeDisabled()
  const [statusStyle, verbStyle] = [await styleOf(status), await styleOf(checkNow)]
  expect(verbStyle.color, 'busy Check now is not the status colour').not.toBe(statusStyle.color)
  await expect(status).toHaveText(/^Checked /, { timeout: 30_000 })

  // Back to a clean checkout for the tests after this one.
  await fs.rm(scratch, { force: true })
  await git(work, 'reset', '--hard', 'origin/main')
  await settleCurrent(page)
})

test('(N2-4)(N2-9) the provenance flyout survives the scroll that revealed its trigger, and Copy keeps focus', async ({ page }) => {
  await openWithChips(page)
  const pane = page.locator('.settings-content')
  const trigger = page.getByTestId('provenance-trigger-acme-notes')
  const flyout = page.getByTestId('provenance-flyout-acme-notes')
  // Start from the top of the pane so the click has to scroll the trigger into view first.
  for (const attempt of [1, 2, 3]) {
    await pane.evaluate((el) => { el.scrollTop = 0 })
    await page.waitForTimeout(150)
    const box = await trigger.boundingBox()
    const viewport = page.viewportSize()!
    if (box && box.y + box.height > viewport.height) break
    // The list is short enough to fit: shrink the window until the trigger is off screen.
    await page.setViewportSize({ width: 1280, height: Math.max(360, 800 - attempt * 200) })
  }
  const scrolls: number[] = []
  await page.evaluate(() => {
    ;(window as unknown as { __scrolls: number }).__scrolls = 0
    document.querySelector('.settings-content')!.addEventListener('scroll', () => { (window as unknown as { __scrolls: number }).__scrolls += 1 })
  })
  await trigger.click()
  scrolls.push(await page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls))
  await expect(flyout, `flyout open after a click that scrolled ${scrolls[0]} time(s)`).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  // A small wheel while open (trackpad momentum after the fingers lift) does not close it;
  // the flyout follows its anchor instead.
  const before = (await flyout.boundingBox())!
  await page.mouse.move(before.x + 400, before.y + 40)
  await page.mouse.wheel(0, 30)
  await page.waitForTimeout(250)
  await expect(flyout).toBeVisible()
  const after = (await flyout.boundingBox())!
  const anchor = (await trigger.boundingBox())!
  const below = Math.abs(after.y - (anchor.y + anchor.height))
  const above = Math.abs(after.y + after.height - anchor.y)
  expect(Math.min(below, above), `flyout hangs off its anchor (before y=${before.y}, after y=${after.y})`).toBeLessThan(12)

  // Copy path keeps the keyboard where it was (N2-9).
  const copy = flyout.getByRole('button', { name: /Copy path|Copied/ })
  await copy.click()
  await expect(copy).toHaveText('Copied')
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName.toLowerCase()}:${el.textContent}` : 'none'
  })
  expect(focused).toBe('button:Copied')
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('(C30) a row the registry scan skipped still checks on click: the chip goes from Not checked to the real state', async ({ page }) => {
  // The registry admits it ran out of budget before reaching acme-tracker: the row comes
  // back without its linked source (a catalog guess, no slug) and `linkedScanSkipped`.
  await page.route('**/api/plugin-runtime/registry', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { rows: Array<Record<string, unknown>> }
    for (const row of body.rows) {
      if (row.id !== 'acme-tracker') continue
      row.source = { kind: 'git' }
      delete row.sourceSlug
      row.linkedScanSkipped = true
    }
    await route.fulfill({ response, json: body })
  })
  // And the status GET has never keyed it (a skipped checkout has no row key yet).
  await page.route('**/api/plugin-updates**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { rowKeyOf: Record<string, string> }
    delete body.rowKeyOf['acme-tracker']
    await route.fulfill({ response, json: body })
  })
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await openPlugins(page)
  const chip = page.getByTestId('update-chip-acme-tracker')
  await expect(chip).toHaveAttribute('data-update-kind', 'unchecked', { timeout: 30_000 })
  await expect(chip).toHaveAttribute('title', /The checkout scan ran out of time\. Click to check\./)
  const posts: string[] = []
  page.on('request', (req) => { if (req.method() === 'POST') posts.push(new URL(req.url()).pathname) })
  await chip.click()
  await expect(chip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
  expect(posts).toEqual(['/api/plugin-runtime/acme-tracker/linked/check'])
  await page.unroute('**/api/plugin-runtime/registry')
  await page.unroute('**/api/plugin-updates**')
})

test('(N2-3) a clone that disappears reads Not installed here, keeps its name, and Restore on the Sources card brings it back', async ({ page }) => {
  await openWithChips(page)
  const clone = path.join(fixture.home, 'plugin-stores', 'native-plugin-repo')
  const parked = `${clone}.parked`
  await fs.rename(clone, parked)
  try {
    await page.goto(`http://127.0.0.1:${fixture.port}/`)
    await openPlugins(page)
    const card = page.getByTestId('plugin-source-native-plugin-repo')
    const sourceChip = page.getByTestId('update-chip-source-native-plugin-repo')
    await expect(sourceChip).toHaveAttribute('data-update-kind', 'missing', { timeout: 30_000 })
    await expect(sourceChip).toHaveText(/Not installed here/i)
    // The display name, never the slug, on the card title.
    await expect(card.locator('.plugin-store-source-title .settings-addons-ellipsis')).toHaveText('Walnut Plugin Demo')
    const restore = card.getByRole('button', { name: 'Restore' })
    await expect(restore).toBeVisible()
    await expect(restore).toHaveClass(/btn-primary/)
    await expect(restore).toHaveAttribute('title', 'Update will clone it again.')
    // The still-loaded Installed row keeps its chip on the SAME row key, and owns no second verb.
    const rowChip = page.getByTestId('update-chip-walnut-demo')
    await expect(rowChip).toHaveAttribute('data-update-kind', 'missing')
    expect(await page.getByRole('button', { name: /^(Update|Restore)$/ }).count()).toBe(1)
    await restore.click()
    await expect(page.getByTestId('plugin-update-feedback-source-native-plugin-repo')).toContainText('Updated to', { timeout: 60_000 })
    await expect(sourceChip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    await expect(rowChip).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
    await expect(card.getByRole('button', { name: 'Restore' })).toHaveCount(0)
    await fs.rm(parked, { recursive: true, force: true })
  } catch (error) {
    // Put the fixture back whatever happened, so the tests after this one see a clone.
    await fs.rm(clone, { recursive: true, force: true }).catch(() => undefined)
    await fs.rename(parked, clone).catch(() => undefined)
    throw error
  }
})
