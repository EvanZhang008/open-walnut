/**
 * Settings copy and small alignments that settings-polish.spec.ts does not
 * pin: unit slots, disabled-button reasons, help text that matches behavior. Same conventions: both
 * engines, real nav clicks, config writes intercepted so the fixture config
 * never changes under another spec.
 */
import { test, expect, type Page, type Request } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

const NAV = (id: string) => `settings-nav-${id}`

async function openSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(NAV(id))
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 20_000 })
}

async function recordWrites(page: Page): Promise<string[]> {
  const writes: string[] = []
  await page.route('**/api/**', async (route) => {
    const req: Request = route.request()
    if (req.method() === 'GET') return route.fallback()
    writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
    if (req.url().includes('/api/config')) return route.fulfill({ status: 200, json: { ok: true } })
    return route.fallback()
  })
  return writes
}

async function expandAll(page: Page) {
  for (let pass = 0; pass < 3; pass++) {
    const n = await page.evaluate(() => {
      const closed = Array.from(document.querySelectorAll<HTMLElement>(
        '.settings-pane [aria-expanded="false"]:not([aria-haspopup]):not([role="combobox"])'))
        .filter((el) => el.getBoundingClientRect().height > 0 && !(el as HTMLButtonElement).disabled)
      closed.forEach((el) => el.click())
      return closed.length
    })
    if (!n) return
    await page.waitForTimeout(200)
  }
}

/** Where each number field (with its unit, if any) ends, measured from its group's right border. */
async function numberEdges(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-input-with-unit'))
    .filter((w) => w.getBoundingClientRect().height > 0)
    .map((w) => {
      const row = w.closest<HTMLElement>('.settings-row')!
      const group = w.closest<HTMLElement>('.settings-group')!.getBoundingClientRect()
      const input = w.querySelector<HTMLElement>('input')!.getBoundingClientRect()
      const unit = w.querySelector<HTMLElement>('.settings-input-unit')
      const actions = row.querySelector<HTMLElement>(':scope > .settings-row-actions')!
      // Anything after the field in the same control cluster moves the edge; only the last one counts.
      const last = Array.from(actions.querySelectorAll<HTMLElement>('*'))
        .filter((e) => e.getBoundingClientRect().width > 0)
        .reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0)
      return {
        label: (row.querySelector('.settings-row-label')?.textContent ?? '').trim(),
        endsAtField: Math.abs(last - w.getBoundingClientRect().right) < 1.5,
        edge: Math.round(group.right - w.getBoundingClientRect().right),
        slack: unit ? 0 : Math.round(w.getBoundingClientRect().right - input.right),
      }
    }))
}

test('N03: a number field and its unit end on the 14px content edge; a unitless field reserves no slot', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  let measured = 0
  for (const pane of ['sessions', 'advanced', 'tasks', 'triage', 'backup', 'audio-capture']) {
    await clickNav(page, pane)
    await expandAll(page)
    for (const f of await numberEdges(page)) {
      measured++
      expect(f.slack, `${pane} ${f.label} empty unit slot`).toBeLessThanOrEqual(1)
      if (!f.endsAtField) continue
      expect(f.edge, `${pane} ${f.label} right edge`).toBeGreaterThanOrEqual(13)
      expect(f.edge, `${pane} ${f.label} right edge`).toBeLessThanOrEqual(15)
    }
  }
  expect(measured).toBeGreaterThan(8)
})

test('N15: every disabled push button looks the same, and one outside a dimmed group says why', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  const looks = new Map<string, string>()
  for (const pane of ['plugin-store', 'devices', 'search', 'audio-capture', 'tasks', 'backup', 'advanced']) {
    await clickNav(page, pane)
    if (pane === 'advanced') await expandAll(page)
    await page.waitForTimeout(400)
    const found = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(
      '.settings-pane .settings-button:disabled:not([aria-busy="true"]):not(.settings-button-text):not(.settings-button-danger)'))
      .filter((b) => b.getBoundingClientRect().height > 0)
      .map((b) => {
        const cs = getComputedStyle(b)
        // As the eye sees it: a dimmed group carries the 45% for its controls.
        let op = 1
        for (let n: HTMLElement | null = b; n; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity)
        return {
          text: (b.textContent ?? '').trim(),
          dimmed: !!b.closest('[aria-disabled="true"]'),
          title: b.title || b.closest('[title]')?.getAttribute('title') || '',
          look: `${cs.backgroundColor} ${cs.borderTopColor} ${cs.color} ${Math.round(op * 100) / 100}`,
        }
      }))
    for (const b of found) {
      looks.set(`${pane}: ${b.text}`, b.look)
      if (!b.dimmed) expect(b.title, `${pane} "${b.text}" is disabled without a reason`).not.toBe('')
    }
  }
  expect(looks.size, 'disabled buttons measured').toBeGreaterThan(2)
  expect(new Set(looks.values()).size, JSON.stringify(Object.fromEntries(looks))).toBe(1)
})

test('N16: General help says what the Appearance and Focus bar settings really reach', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'general')
  for (const id of ['settings-appearance-row', 'settings-focus-bar-row']) {
    const help = page.getByTestId(id).locator('.settings-row-help')
    await expect(help).toBeVisible()
    // Only this browser's storage changes at once; other windows pick it up on their next load.
    await expect(help).not.toContainText('every window')
    await expect(help).toContainText('next open')
  }
})

test('N19: the nav keeps the active item\'s group title clear of the filter when it scrolls', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'devices')
  await page.waitForTimeout(300)
  const m = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.settings-nav-list')!
    const active = document.querySelector<HTMLElement>('.settings-nav-item[aria-current="page"]')!
    const label = active.closest('.settings-nav-group')!.querySelector<HTMLElement>('.settings-nav-group-label')!
    return {
      scrolled: list.scrollTop,
      labelTop: label.getBoundingClientRect().top - list.getBoundingClientRect().top,
      activeTop: active.getBoundingClientRect().top - list.getBoundingClientRect().top,
      mask: getComputedStyle(list).maskImage || getComputedStyle(list).webkitMaskImage,
    }
  })
  // Either the list did not need to move, or it stopped with room for the item's group label.
  if (m.scrolled > 0) expect(m.activeTop, JSON.stringify(m)).toBeGreaterThanOrEqual(20)
  expect(m.mask, 'a scrolled list fades under the filter').toContain('gradient')
})

const PERMS = {
  platform: 'darwin', applicable: true, probedAt: Date.now(),
  launcher: { kind: 'mac-app', name: 'Walnut' },
  permissions: [
    { id: 'screen-recording', label: 'Screen Recording', state: 'granted', fixKind: 'settings-only', why: 'Lets Walnut see which app is in front.', launcherIndependent: true, steps: [] },
    { id: 'full-disk-access', label: 'Full Disk Access', state: 'denied', fixKind: 'settings-only', why: 'Lets Walnut read Screen Time.', launcherIndependent: true, steps: [] },
    { id: 'session-full-disk-access', label: 'Session file access', state: 'unknown', unverifiable: true, optional: true, fixKind: 'settings-only',
      why: 'Optional. Stops the repeated file access prompts while a session reads files.', launcherIndependent: true, steps: [] },
  ],
}

test('N21 N26: macOS Access help is a real sentence and every state tag ends on one column', async ({ page }) => {
  await recordWrites(page)
  await page.route((url) => url.pathname === '/api/permissions', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: PERMS }) : route.fallback())
  await openSettings(page)
  await clickNav(page, 'permissions')
  const rows = page.locator('.settings-pane .permission-row')
  await expect(rows).toHaveCount(3, { timeout: 20_000 })
  // "Optional." alone says nothing: the row reads on to what the grant does.
  await expect(rows.nth(2).locator('.settings-row-help')).toContainText('Stops the repeated file access prompts')
  const rights = await page.locator('.settings-pane .permission-row-state').evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().right)))
  expect(new Set(rights).size, JSON.stringify(rights)).toBe(1)
})

test('N21: Search and Hooks copy agrees with what the pane does', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'search')
  // Excluded folders stay indexed, so the pane is about what results show, not what the index covers.
  const desc = page.locator('.settings-pane .settings-pane-desc').first()
  await expect(desc).toContainText('search results show')
  await clickNav(page, 'hooks')
  const pane = page.locator('.settings-pane')
  await expect(pane.getByTestId('hooks-group-yours')).toBeVisible({ timeout: 20_000 })
  // A daemon hook change is pushed live (hooks.configure); nothing waits for a restart.
  await expect(pane).not.toContainText('applies after it restarts')
  await expect(pane.getByTestId('hooks-group-yours').locator('code', { hasText: '~/.open-walnut/hooks/' })).toBeVisible()
})

test('N24: Cloud Companion has a one-sentence description and names the chat agent Ask Walnut', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'devices')
  const cloud = page.locator('.settings-pane #cloud')
  await expect(cloud).toBeVisible({ timeout: 20_000 })
  const desc = await cloud.evaluate((el) => {
    const title = Array.from(el.querySelectorAll<HTMLElement>('h2, h3, [class*="title"]')).find((t) => /Cloud Companion/.test(t.textContent ?? ''))
    const next = title?.nextElementSibling as HTMLElement | null
    return { text: (next?.textContent ?? '').trim(), size: next ? parseFloat(getComputedStyle(next).fontSize) : 0 }
  })
  expect(desc.text, 'description under the title').toMatch(/^[A-Z][^.]+\.$/)
  expect(desc.size).toBeLessThan(14)
  await expect(page.locator('.settings-pane')).not.toContainText('Personal AI')
})

test('N26 N28: Calendar heading links stay put, Voice names its command in code', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'stt')
  await expect(page.locator('.settings-pane .settings-row-help code', { hasText: /^say$/ })).toBeVisible({ timeout: 20_000 })
  await clickNav(page, 'calendar')
  const groups = page.getByTestId('calendar-account-group')
  if (await groups.count() < 2) return
  const xs = await groups.evaluateAll((els) => els.map((g) => {
    const b = Array.from(g.querySelectorAll<HTMLElement>('button')).find((x) => x.textContent?.trim() === 'Show all')
    return Math.round(b!.getBoundingClientRect().left)
  }))
  expect(new Set(xs).size, JSON.stringify(xs)).toBe(1)
})

test('N27: opening Voice asks for the speech scan once', async ({ page }) => {
  await recordWrites(page)
  const scans: string[] = []
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/stt/detect') scans.push(r.url()) })
  await openSettings(page)
  await clickNav(page, 'stt')
  await page.waitForTimeout(1_500)
  // StrictMode mounts twice in dev; both mounts share the one scan in flight.
  expect(scans.length).toBeLessThanOrEqual(1)
})

test('C74: Phones & Cloud claims nothing before the devices list answers, so #cloud never moves', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    await gate
    return route.continue()
  })
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'devices')
  const devices = page.locator('#devices')
  await expect(devices).toContainText('Loading paired phones...')
  // No "no address" notice and no "No phones" claim while the list is unknown.
  await expect(devices).not.toContainText('No address for this machine')
  await expect(devices).not.toContainText('No phones paired yet.')
  const offsetOf = () => page.evaluate(() => {
    const pane = document.querySelector('.settings-pane')!
    return document.getElementById('cloud')!.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
  })
  const before = await offsetOf()
  release()
  await expect(devices).not.toContainText('Loading paired phones...', { timeout: 20_000 })
  await page.waitForTimeout(300)
  // The fixture pairs no phone and has a pairing address: nothing above #cloud changes height.
  expect(Math.abs((await offsetOf()) - before)).toBeLessThanOrEqual(1)
})
