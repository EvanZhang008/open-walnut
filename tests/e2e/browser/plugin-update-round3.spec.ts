/**
 * Apps page plugin update status: the round-three nitpicks (N3-1 .. N3-18) and the two
 * checklist items that failed with them (C49, C60 is a hook unit test), each pinned against
 * the real fixture (linked checkout pair + git source) in both engines. Boots its own fixture
 * server (plugin-update-fixture.ts); serial, one page at a time.
 *
 * The Apps page is a store: a plugin's update chip, Check again, Update button and feedback
 * sit in the Version section of its detail page (opened from its card); Check now, the
 * header line and the Sources group stay on the card grid.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  commitAll, ensureSourceInstalled, expectChipKinds, git, openPlugins, openVersion, startPluginFixture, type PluginFixture,
} from './plugin-update-fixture'
import { backToApps, openPluginDetail } from './apps-store-helpers'

const SHOT_DIR = '/tmp/plugin-update-ux/after'
let fixture: PluginFixture

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  fixture = await startPluginFixture()
})

const shot = (page: Page, name: string, target?: Locator) => (target ?? page).screenshot({
  path: path.join(SHOT_DIR, `r3-${name}-${test.info().project.name}.png`),
})
test.afterAll(async () => { await fixture?.stop() })

const UPDATABLE = ['acme-tracker', 'acme-notes', 'walnut-demo'] as const

const rect = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, x: r.left, y: r.top }
})

/** Every `data-update-kind` a chip ever carries, from document start (see native-plugin.spec.ts). */
const CHIP_KIND_RECORDER = `
  window.__chipKinds = {};
  const note = (el) => {
    const id = el.getAttribute('data-testid'); const kind = el.getAttribute('data-update-kind');
    if (!id || !id.startsWith('update-chip-') || !kind) return;
    const list = (window.__chipKinds[id] ||= []);
    if (list[list.length - 1] !== kind) list.push(kind);
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

function kindsSeen(page: Page, rowId: string): Promise<string[]> {
  return page.evaluate((id) => ((window as unknown as { __chipKinds: Record<string, string[]> }).__chipKinds ?? {})[id] ?? [], `update-chip-${rowId}`)
}

async function openWithChips(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await openPlugins(page)
  await ensureSourceInstalled(page, fixture.home)
  await expectChipKinds(page, UPDATABLE, 'current')
}

/** Every chip back to current after a knob was turned. */
async function settleCurrent(page: Page): Promise<void> {
  await page.getByTestId('plugin-updates-check-now').click()
  await expectChipKinds(page, UPDATABLE, 'current')
}

async function collapseSidebar(page: Page): Promise<void> {
  if (await page.locator('.sidebar.collapsed').count()) return
  await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(1)
}

/**
 * Put the git source one commit behind and let the header find out (on the card grid). The
 * card says Update available; the plugin's page says it on its chip. Ends back on the grid.
 */
async function putSourceBehind(page: Page, note: string): Promise<void> {
  const origin = path.join(fixture.home, 'native-plugin-repo')
  await fs.writeFile(path.join(origin, `${note}.md`), `${note}\n`)
  await commitAll(origin, note)
  await page.getByTestId('plugin-updates-check-now').click()
  await expect(page.getByTestId('plugin-card-walnut-demo-status')).toHaveText('Update available', { timeout: 30_000 })
  await expect(page.getByTestId('plugin-updates-check-now')).toBeEnabled()
  await expectChipKinds(page, ['walnut-demo'], 'available')
}

/** Push a commit from the publisher clone so the linked checkout is behind. Ends back on the grid. */
async function putLinkedBehind(page: Page, note: string): Promise<void> {
  const publisher = path.join(fixture.home, 'linked-publisher')
  await fs.writeFile(path.join(publisher, 'acme-tracker', `${note}.md`), `${note}\n`)
  await commitAll(publisher, note)
  await git(publisher, 'push', 'origin', 'main')
  await page.getByTestId('plugin-updates-check-now').click()
  await expect(page.getByTestId('plugin-card-acme-tracker-status')).toHaveText('Update available', { timeout: 30_000 })
  await expect(page.getByTestId('plugin-updates-check-now')).toBeEnabled()
  await expectChipKinds(page, ['acme-tracker'], 'available')
}

/** The right edge of a row's content box (its right padding taken off). */
const contentRight = (row: Locator) => row.evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight))

test('(N3-2)(N3-18) a row the server is still checking spins, never reads Not checked; the status GET does not wait for the registry', async ({ page }) => {
  // Until the test lets go, every status answer pretends the linked checkout has no cache and
  // a batch is running (`refreshing: true`, no linked rows); the ones after are real. Held by
  // a flag, not a count, so the chips can be read on their own pages while it lasts.
  let serverChecking = true
  await page.route('**/api/plugin-updates**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { rows: Record<string, unknown>; rowKeyOf: Record<string, string>; refreshing?: boolean }
    if (serverChecking) {
      for (const key of Object.keys(body.rows)) if (key.startsWith('linked:')) delete body.rows[key]
      body.refreshing = true
    }
    await route.fulfill({ response, json: body })
  })
  const started: Array<{ path: string; at: number }> = []
  page.on('request', (req) => {
    const p = new URL(req.url()).pathname
    if (req.method() === 'GET' && (p === '/api/plugin-runtime/registry' || p === '/api/plugin-updates')) started.push({ path: p, at: Date.now() })
  })
  await page.addInitScript(CHIP_KIND_RECORDER)
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await openPlugins(page)
  await expect(page.getByTestId('plugin-updates-checked-at')).toHaveText('Checking for updates...')
  // Each linked plugin's chip, on its own page, spins while the server checks.
  for (const id of ['acme-tracker', 'acme-notes']) {
    await openVersion(page, id)
    const chip = page.getByTestId(`update-chip-${id}`)
    await expect(chip).toHaveAttribute('data-update-kind', 'checking', { timeout: 15_000 })
    await expect(chip).toHaveAttribute('aria-busy', 'true')
    if (id !== 'acme-notes') await backToApps(page)
  }
  serverChecking = false
  await expect(page.getByTestId('update-chip-acme-notes')).toHaveAttribute('data-update-kind', 'current', { timeout: 30_000 })
  await backToApps(page)
  await expectChipKinds(page, ['acme-tracker'], 'current')
  for (const id of ['acme-tracker', 'acme-notes']) {
    const kinds = await kindsSeen(page, id)
    expect(kinds, `${id}: ${kinds.join(' > ')}`).not.toContain('unchecked')
    expect(kinds).toContain('checking')
  }
  await page.unroute('**/api/plugin-updates**')

  // The status GET was issued alongside the registry GET, not 1.7 s after its answer, and
  // the registry was read ONCE on mount (StrictMode used to fire it twice in the same ms).
  // Opening a plugin's page and coming back reads it no more.
  const registry = started.filter((r) => r.path === '/api/plugin-runtime/registry')
  const updates = started.filter((r) => r.path === '/api/plugin-updates')
  expect(registry.length, JSON.stringify(started)).toBe(1)
  expect(updates.length).toBeGreaterThanOrEqual(1)
  expect(Math.abs(updates[0].at - registry[0].at), `updates GET vs registry GET: ${JSON.stringify(started)}`).toBeLessThan(600)
})

test('(N3-7)(N3-9)(N3-17) pills share one height, the header link is text-safe, one Remove per source', async ({ page }) => {
  await openWithChips(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  // The chip is the same pill as the tags on the plugin's page (its origin, its state).
  for (const id of ['acme-tracker', 'walnut-demo']) {
    await openVersion(page, id)
    const tag = page.getByTestId(`plugin-row-${id}`).locator('.settings-tag').first()
    const chip = page.getByTestId(`update-chip-${id}`)
    const [b, c] = [await rect(tag), await rect(chip)]
    expect(Math.abs(b.height - c.height), `${id}: tag ${b.height} vs chip ${c.height}`).toBeLessThanOrEqual(0.5)
    await backToApps(page)
  }
  // Check now reads in the same text-safe accent as the chip (4.5:1 on the light card).
  const link = page.getByTestId('plugin-updates-check-now')
  const colours = await link.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent-text)'
    document.body.appendChild(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return { actual: getComputedStyle(el).color, expected }
  })
  expect(colours.actual).toBe(colours.expected)
  // The plugin's own page owns Remove while its plugin is loaded: the Sources card has none,
  // and the grid none at all.
  const card = page.getByTestId('plugin-source-native-plugin-repo')
  await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  expect(await page.getByRole('button', { name: /^Remove\b/ }).count()).toBe(0)
  await openPluginDetail(page, 'walnut-demo')
  await expect(page.getByTestId('plugin-remove-walnut-demo')).toHaveCount(1)
  expect(await page.getByRole('button', { name: /^Remove\b/ }).count()).toBe(1)
  await backToApps(page)
  // No GIT badge on the card: the origin line already says git (N3-10).
  await expect(card.locator('.badge', { hasText: /^git$/i })).toHaveCount(0)
})

/**
 * Every settings row of a plugin's page with controls, measured: never past the row, one line,
 * and when dropped under the copy, flush right. Returns the right edges and how many dropped.
 */
async function measureDetailRows(page: Page): Promise<{ rights: number[]; wrapped: number; n: number }> {
  // The page's own sections: where it comes from, its version, Remove.
  const rows = page.locator('[data-testid="plugin-detail"] :is([data-testid^="plugin-source-"], [data-testid^="plugin-version-"], [data-testid^="plugin-remove-group-"]) .settings-row')
  const n = await rows.count()
  const rights: number[] = []
  let wrapped = 0
  for (let i = 0; i < n; i += 1) {
    const row = rows.nth(i)
    const actions = row.locator(':scope > .settings-row-actions')
    if (!(await actions.count())) continue
    const [copyBox, actBox] = [await rect(row.locator(':scope > .settings-row-copy')), await rect(actions)]
    const rowRight = await contentRight(row)
    // Never past the row, and the cluster is one line.
    expect(actBox.right).toBeLessThanOrEqual(rowRight + 1)
    // One line: every control's vertical centre is the same (heights differ: toggle vs button).
    const centres = await actions.locator(':scope > *').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
    expect(Math.max(...centres) - Math.min(...centres), `row ${i} cluster centres ${centres.join(',')}`).toBeLessThanOrEqual(2)
    if (actBox.top >= copyBox.bottom - 1) {
      // Dropped under the copy: flush right.
      wrapped += 1
      expect(Math.abs(actBox.right - rowRight), `row ${i}: cluster right ${actBox.right} vs row right ${rowRight}`).toBeLessThanOrEqual(1.5)
    }
    // The invisible Update slot never sits in front of a visible control: those start where
    // they end up once the button shows, and nothing is pushed in behind an empty box.
    const slot = actions.locator('.plugin-update-slot')
    if (await slot.count()) {
      const slotLeft = (await rect(slot)).left
      const visibleRights = await slot.evaluate((el) => Array.from(el.parentElement!.children)
        .filter((c) => c !== el && c.getBoundingClientRect().width > 0)
        .map((c) => c.getBoundingClientRect().right))
      for (const right of visibleRights) expect(right, `row ${i}: a visible control after the slot`).toBeLessThanOrEqual(slotLeft + 1)
    }
    rights.push(Math.round(actBox.right))
  }
  return { rights, wrapped, n }
}

test('(N3-3)(N3-15) at 960 the dropped controls sit flush right on every row, the plugin page and Sources stack the same way', async ({ page }) => {
  await openWithChips(page)
  // Sidebar expanded (the N3-3 evidence: card 442px, group 394px).
  await page.setViewportSize({ width: 960, height: 800 })
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  await openPluginDetail(page, 'acme-tracker')
  const at960 = await measureDetailRows(page)
  expect(at960.n).toBeGreaterThanOrEqual(3)
  // Controls of every row end at the same x.
  expect(new Set(at960.rights).size, `cluster right edges ${at960.rights.join(',')}`).toBe(1)
  await shot(page, 'detail-960', page.getByTestId('plugin-detail'))
  await backToApps(page)

  // Sources card: title line, then origin line, then the controls (flush right), like a row.
  const card = page.getByTestId('plugin-source-native-plugin-repo')
  await card.scrollIntoViewIfNeeded()
  const [title, origin, actions] = [card.locator('.plugin-store-source-title'), card.locator('.settings-row-copy .plugin-store-origin'), card.locator('.plugin-store-source-actions')]
  const [t, o, a] = [await rect(title), await rect(origin), await rect(actions)]
  expect(o.top).toBeGreaterThanOrEqual(t.bottom - 1)
  const cardRight = await card.evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight))
  expect(a.right).toBeLessThanOrEqual(cardRight + 1)
  if (a.top >= o.bottom - 1) expect(Math.abs(a.right - cardRight)).toBeLessThanOrEqual(1.5)
  else expect(a.left).toBeGreaterThanOrEqual(Math.max(t.right, o.right) - 1)
  // And the same rule at a width where the card must drop its controls.
  await page.setViewportSize({ width: 700, height: 800 })
  await card.scrollIntoViewIfNeeded()
  const [o2, a2] = [await rect(origin), await rect(actions)]
  const cardRight2 = await card.evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight))
  if (a2.top >= o2.bottom - 1) expect(Math.abs(a2.right - cardRight2)).toBeLessThanOrEqual(1.5)
  // The plugin's page in a narrow group (under 600px: 820 wide, sidebar expanded, above the
  // phone layout): rows wrap their controls, and the dropped ones sit flush right.
  await page.setViewportSize({ width: 820, height: 800 })
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  await openPluginDetail(page, 'acme-tracker')
  await expect.poll(() => page.getByTestId('plugin-version-acme-tracker').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(600)
  const narrow = await measureDetailRows(page)
  expect(narrow.wrapped, 'in a group under 600px at least one row wraps its controls').toBeGreaterThan(0)
  expect(new Set(narrow.rights).size, `cluster right edges ${narrow.rights.join(',')}`).toBe(1)
  await shot(page, 'detail-820', page.getByTestId('plugin-detail'))
  await backToApps(page)
  await page.setViewportSize({ width: 1280, height: 800 })
})

/** Width of a clone of the button carrying another label, measured off-screen in the same parent. */
async function widthWithLabel(button: Locator, label: string): Promise<number> {
  return button.evaluate((el, text) => {
    const clone = el.cloneNode(true) as HTMLElement
    const cell = clone.querySelector('.plugin-update-label > span')
    if (cell) cell.textContent = text
    clone.style.position = 'absolute'
    clone.style.visibility = 'hidden'
    clone.removeAttribute('data-testid')
    el.parentElement!.appendChild(clone)
    const w = clone.getBoundingClientRect().width
    clone.remove()
    return w
  }, label)
}

test('(N3-4)(N3-5)(N3-8)(N3-11)(N3-12)(N3-16) the Update button: shared-checkout note, one width, a visible ring, dead while checking', async ({ page }) => {
  await openWithChips(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await putLinkedBehind(page, 'round3-linked-one')
  // Two plugins share the checkout: each primary says so, naming the other (N3-4).
  await openVersion(page, 'acme-notes')
  await expect(page.getByTestId('plugin-update-acme-notes')).toHaveAttribute('title', 'Also updates Acme Tracker (same checkout).')
  await backToApps(page)
  await openVersion(page, 'acme-tracker')
  const update = page.getByTestId('plugin-update-acme-tracker')
  await expect(update).toHaveClass(/btn-primary/)
  await expect(update).toHaveAttribute('title', 'Also updates Acme Notes (same checkout).')
  // One width through every label (N3-5): the button is already as wide as "Updating...", the busy label as it renders.
  const box = await rect(update)
  const wide = await widthWithLabel(update, 'Updating...')
  const narrow = await widthWithLabel(update, 'Update')
  expect(Math.abs(box.width - wide), `button ${box.width} vs Updating... ${wide}`).toBeLessThanOrEqual(0.5)
  expect(Math.abs(box.width - narrow), `button ${box.width} vs Update ${narrow}`).toBeLessThanOrEqual(0.5)
  // Keyboard focus ring: 2px solid accent, not the UA's 1px auto (N3-8). Reached by Tab from
  // the chip (a programmatic .focus() does not count as keyboard focus for :focus-visible).
  // Safari reaches buttons with Option+Tab (plain Tab walks text fields only).
  const tabKey = test.info().project.name === 'webkit' ? 'Alt+Tab' : 'Tab'
  await page.getByTestId('update-chip-acme-tracker').focus()
  for (let i = 0; i < 6; i += 1) {
    if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'plugin-update-acme-tracker') break
    await page.keyboard.press(tabKey)
  }
  await expect(update).toBeFocused()
  const ring = await update.evaluate((el) => {
    const s = getComputedStyle(el)
    return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }
  })
  expect(ring.style).toBe('solid')
  expect(ring.width).toBe('2px')
  expect(ring.shadow).not.toBe('none')
  // While Check now runs, the button stays in place but is disabled (N3-12). Check now is on
  // the card grid, so the refresh GET is held for 4 s: long enough to come back to the
  // plugin's page and look at it.
  await page.route('**/api/plugin-updates?refresh=1', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    await route.continue()
  })
  await backToApps(page)
  await page.getByTestId('plugin-updates-check-now').click()
  await openVersion(page, 'acme-tracker')
  await expect(page.getByTestId('update-chip-acme-tracker')).toHaveAttribute('data-update-kind', 'checking')
  await expect(update).toBeDisabled()
  await expect(update).not.toHaveClass(/btn-primary/)
  expect(Math.abs((await rect(update)).x - box.x), 'the button did not move while disabled').toBeLessThanOrEqual(0.5)
  await expect(page.getByTestId('update-chip-acme-tracker')).toHaveAttribute('data-update-kind', 'available', { timeout: 30_000 })
  await page.unroute('**/api/plugin-updates?refresh=1')
  await expect(update).toBeEnabled()
  await expect(update).toHaveClass(/btn-primary/)
  // Press it: the button never moves or resizes while it reads Updating… (N3-5).
  await page.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="plugin-update-acme-tracker"]');
    const frames = []; window.__btnFrames = frames;
    const snap = () => { const b = document.querySelector('[data-testid="plugin-update-acme-tracker"]'); if (!b) return; const r = b.getBoundingClientRect(); frames.push({ x: r.left, w: r.width, label: b.textContent }); };
    snap();
    new MutationObserver(snap).observe(btn.closest('.settings-row'), { subtree: true, childList: true, attributes: true, characterData: true });
  })()`)
  await update.click()
  const feedback = page.getByTestId('plugin-update-feedback-acme-tracker')
  await expect(feedback).toContainText('Updated to', { timeout: 60_000 })
  const frames = await page.evaluate(() => (window as unknown as { __btnFrames: Array<{ x: number; w: number; label: string }> }).__btnFrames)
  expect(frames.some((f) => f.label.includes('Updating')), `frames ${JSON.stringify(frames.slice(0, 6))}`).toBe(true)
  const xs = new Set(frames.map((f) => Math.round(f.x * 2) / 2))
  const ws = new Set(frames.map((f) => Math.round(f.w * 2) / 2))
  expect(xs.size, `button x moved: ${JSON.stringify([...xs])}`).toBe(1)
  expect(ws.size, `button width changed: ${JSON.stringify([...ws])}`).toBe(1)
  // Success reads as success (N3-16): a check icon, the row foreground, and the sibling named on hover.
  await expect(feedback).toContainText('reloaded Acme Tracker and 1 more')
  await expect(feedback.locator('svg.plugin-update-feedback-icon')).toHaveCount(1)
  await expect(feedback.locator('.plugin-update-feedback-text')).toHaveAttribute('title', 'Reloaded Acme Tracker, Acme Notes')
  const fg = await feedback.locator('.plugin-update-feedback-text').evaluate((el) => {
    const probe = document.createElement('span'); probe.style.color = 'var(--fg)'; document.body.appendChild(probe)
    const expected = getComputedStyle(probe).color; probe.remove()
    return { actual: getComputedStyle(el).color, expected }
  })
  expect(fg.actual).toBe(fg.expected)
})

test('(N3-1)(N3-6)(N3-10)(N3-11) a failed Update is said once on the plugin page, Details stays put, the Sources card keeps one line', async ({ page }) => {
  await openWithChips(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await putSourceBehind(page, 'round3-source-one')
  // The Sources chip does not promise a button the card does not have (N3-11).
  const sourceChip = page.getByTestId('update-chip-source-native-plugin-repo')
  await expect(sourceChip).toHaveAttribute('data-update-kind', 'available')
  expect(await sourceChip.getAttribute('title')).toMatch(/^Update on its plugin page moves this plugin to [0-9a-f]{7}\. Click to check again\.$/)
  await expect(page.getByTestId('plugin-source-native-plugin-repo').getByTestId('plugin-update-source-native-plugin-repo')).toHaveCount(0)

  // Make the remote unreachable, then press Update: 502, reported on the plugin's page and nowhere else.
  await openVersion(page, 'walnut-demo')
  const origin = path.join(fixture.home, 'native-plugin-repo')
  const errorLogs: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errorLogs.push(msg.text()) })
  await fs.rename(origin, `${origin}.away`)
  try {
    const responses: number[] = []
    page.on('response', (res) => { if (res.url().includes('/api/plugin-sources/native-plugin-repo/update')) responses.push(res.status()) })
    await page.getByTestId('plugin-update-walnut-demo').click()
    const feedback = page.getByTestId('plugin-update-feedback-walnut-demo')
    await expect(feedback).toContainText('Could not update:', { timeout: 60_000 })
    expect(responses).toEqual([502])
    // Said once: on the plugin's Version section, never again on the Sources card.
    await expect(page.getByTestId('plugin-update-feedback-source-native-plugin-repo')).toHaveCount(0)
    // No incident card: the toast that used to cover the header never appears (N3-1).
    await page.waitForTimeout(1_500)
    await expect(page.getByText(/This API endpoint is failing/)).toHaveCount(0)
    await expect(page.locator('[class*="toast"], [class*="notification"]').filter({ hasText: /plugin-sources|HTTP 502/ })).toHaveCount(0)
    // Details -> Hide details: the control the user clicked does not move or grow (N3-6).
    const toggle = feedback.locator('.plugin-update-feedback-toggle')
    await expect(toggle).toHaveText('Details')
    const before = await rect(toggle)
    await toggle.click()
    await expect(toggle).toHaveText('Hide details')
    await expect(feedback.locator('pre.plugin-update-detail')).toBeVisible()
    const after = await rect(toggle)
    expect(Math.abs(after.x - before.x), 'toggle x').toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.y - before.y), 'toggle y').toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.width - before.width), 'toggle width').toBeLessThanOrEqual(0.5)
    // The pre is a full-width block under the sentence, never beside the toggle.
    const pre = await rect(feedback.locator('pre.plugin-update-detail'))
    expect(pre.top).toBeGreaterThanOrEqual(after.bottom - 1)
    await shot(page, 'row-update-failed-details', page.getByTestId('plugin-version-walnut-demo'))
    await toggle.click()
    await expect(toggle).toHaveText('Details')
    expect(Math.abs((await rect(toggle)).x - before.x)).toBeLessThanOrEqual(0.5)
  } finally {
    await fs.rename(`${origin}.away`, origin)
  }
  // Take the update for real: the card's title line holds name, badge, version and chip at
  // 1280 even with RESTART TO ACTIVATE on it (N3-10).
  await page.getByTestId('plugin-update-walnut-demo').click()
  await expect(page.getByTestId('plugin-update-feedback-walnut-demo')).toContainText('Updated to', { timeout: 60_000 })
  await backToApps(page)
  const card = page.getByTestId('plugin-source-native-plugin-repo')
  await expect(card.locator('.badge', { hasText: /restart to activate/i })).toBeVisible()
  const title = card.locator('.plugin-store-source-title')
  const [t, c] = [await rect(title), await rect(sourceChip)]
  expect(t.height, 'title cluster is one line').toBeLessThan(30)
  expect(Math.abs(c.top - t.top)).toBeLessThan(6)
  await expect(card.locator('.badge', { hasText: /^git$/i })).toHaveCount(0)
  await shot(page, 'sources-updated-1280', card)
})

test('(C49)(N3-13) offline: chips keep their words and turn stale, the header says Offline, one GET when back online', async ({ page, context }) => {
  await openWithChips(page)
  await settleCurrent(page)
  const gets: string[] = []
  page.on('request', (req) => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/plugin-updates') gets.push(req.url()) })
  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  const head = page.getByTestId('plugin-updates-checked-at')
  await expect(head).toHaveText(/^Offline, last checked/)
  const checkNow = page.getByTestId('plugin-updates-check-now')
  await expect(checkNow).toBeDisabled()
  await expect(checkNow).toHaveAttribute('title', 'You are offline. Check again when you are back online.')
  // Each plugin's chip, on its own page: the same words, marked stale.
  for (const id of UPDATABLE) {
    await openVersion(page, id)
    const chip = page.getByTestId(`update-chip-${id}`)
    await expect(chip).toHaveAttribute('data-update-kind', 'current')
    await expect(chip).toContainText('Up to date')
    await expect(chip).toHaveClass(/plugin-update-chip--stale/)
    await expect(chip.locator('.plugin-update-chip-stale-mark')).toHaveCount(1)
    if (id === 'walnut-demo') await shot(page, 'offline-stale', page.getByTestId(`plugin-version-${id}`))
    await backToApps(page)
  }
  // The Sources card chip agrees with the plugin's page.
  await expect(page.getByTestId('update-chip-source-native-plugin-repo')).toHaveClass(/plugin-update-chip--stale/)
  // Focus and visibility while offline send nothing; neither does opening a plugin's page.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(800)
  expect(gets).toEqual([])
  // Back online: exactly one passive GET (the WS reconnect that follows rides its debounce),
  // and the stale marking goes. Two passive GETs closer than 5 s collapse, so the network
  // comes back more than 5 s after the Check now above.
  await page.waitForTimeout(5_500)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => gets.length, { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(3_000)
  expect(gets.length).toBe(1)
  await expect(head).not.toHaveText(/Offline/)
  await expect(checkNow).toBeEnabled()
  for (const id of UPDATABLE) {
    await openVersion(page, id)
    await expect(page.getByTestId(`update-chip-${id}`)).not.toHaveClass(/plugin-update-chip--stale/)
    await backToApps(page)
  }
  expect(gets.length, 'opening the plugin pages sent no status GET').toBe(1)
})
