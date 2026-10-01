/**
 * Folder picker: what plain Enter does, and Quick access for a user with no history.
 *
 * The fresh-install walk found two gaps: a user typed a folder and pressed Enter,
 * and nothing happened (only ⇧Enter or a small button worked); and the first open
 * showed every home subfolder (Library, Music, ...) with no starting point.
 *
 *   (i)   a typed folder that exists: Enter uses it (exact name, and trailing slash,
 *         where the listing highlights no child so Enter cannot open one)
 *   (ii)  a typed folder that does not exist: Enter takes the create row, and the
 *         launch carries createCwd
 *   (iii) a user with no history: the home listing leads with Quick access
 *
 * The folders under test live in a temp dir this spec creates (the fixture's local
 * host lists the real file system). A fresh user is the working-dirs answer routed
 * to empty for one page. Real UI keys and clicks throughout; page.goto only to load.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { draftComposer, draftCwdPill, openDraft } from './draft-helpers'

// A first wave on a cold fixture (load + reload + history) can take most of 30s alone.
test.describe.configure({ timeout: 60_000 })

const SHOTS = '/tmp/onboarding-walk/picker'
let tmp = ''
let existing = ''

test.beforeAll(() => {
  // realpath: macOS tmpdir is a /var → /private/var link, and the listing reports what it was asked.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-picker-enter-')))
  existing = path.join(tmp, 'existing')
  fs.mkdirSync(path.join(existing, 'inner'), { recursive: true })
  fs.mkdirSync(SHOTS, { recursive: true })
})

test.afterAll(() => {
  if (tmp.includes('pw-picker-enter-')) fs.rmSync(tmp, { recursive: true, force: true })
})

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const input = (page: Page): Locator => picker(page).locator('.sps-search-input')
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A fresh draft's folder picker, on the Local tab, in the blank view. */
async function openPicker(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible()
  await expect(picker(page).locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  // Pin Local so a dead fixture SSH host cannot hold the verdict at 'unknown'.
  const localTab = picker(page).locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  if ((await input(page).inputValue()) !== '') {
    await input(page).press('Escape')
    await expect(input(page)).toHaveValue('')
  }
  return panel
}

async function expectPill(panel: Locator, cwd: string): Promise<void> {
  await expect(draftCwdPill(panel)).toHaveAttribute('aria-label', new RegExp(`^Folder and host: ${esc(cwd)} on `))
}

test('(i) Enter on a typed folder that exists uses it', async ({ page }) => {
  const panel = await openPicker(page)
  await input(page).fill(existing)
  await expect(picker(page).locator('.sps-status-btn.sps-status-valid')).toBeVisible()
  await expect(picker(page).locator('.sps-status-btn')).toHaveAttribute('title', /\(Enter\)$/)
  await expect(picker(page).locator('.sps-keys-hint')).toContainText('Enter select or use path')
  await picker(page).screenshot({ path: `${SHOTS}/enter-existing-typed.png` })
  await input(page).press('Enter')
  await expect(picker(page)).toBeHidden()
  await expectPill(panel, existing)
})

test('(i) Enter on a trailing-slash folder uses the folder, not its first child', async ({ page }) => {
  const panel = await openPicker(page)
  await input(page).fill(`${existing}/`)
  const list = picker(page).locator('.sps-path-list')
  await expect(list.locator('.sps-path-item', { hasText: 'inner' })).toBeVisible()
  await expect(picker(page).locator('.sps-status-btn.sps-status-valid')).toBeVisible()
  // Nothing highlighted: nothing on screen says Enter would open "inner".
  await expect(list.locator('.sps-path-item.active')).toHaveCount(0)
  await picker(page).screenshot({ path: `${SHOTS}/enter-trailing-slash.png` })
  await input(page).press('Enter')
  await expect(picker(page)).toBeHidden()
  await expectPill(panel, existing)

  // Reopen: ↓ picks "inner", and then Enter opens it (arrow keys still win).
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible()
  await input(page).fill(`${existing}/`)
  await expect(list.locator('.sps-path-item', { hasText: 'inner' })).toBeVisible()
  await input(page).press('ArrowDown')
  await expect(list.locator('.sps-path-item.active')).toContainText('inner')
  await input(page).press('Enter')
  await expect(input(page)).toHaveValue(`${existing}/inner/`)
  await expect(picker(page)).toBeVisible()
  // An empty folder: its note, plus the hint that says what Enter does.
  await expect(list.locator('.sps-live-note')).toContainText('No subdirectories')
  await expect(list.locator('.sps-empty')).toHaveText('No matches. Press Enter to use this path.')
  await input(page).press('Enter')
  await expect(picker(page)).toBeHidden()
  await expectPill(panel, path.join(existing, 'inner'))
})

test('(ii) Enter on a folder that does not exist takes the create row; the launch carries createCwd', async ({ page }) => {
  const panel = await openPicker(page)
  const fresh = path.join(tmp, `brand-new-${Date.now().toString(36)}`)
  await input(page).fill(fresh)
  const list = picker(page).locator('.sps-path-list')
  await expect(list.locator('.sps-create-row')).toContainText(path.basename(fresh))
  await expect(list.locator('.sps-empty')).toHaveText('Folder does not exist. Press Enter to create it and start here.')
  await expect(picker(page).locator('.sps-status-btn.sps-status-missing')).toBeVisible()
  await picker(page).screenshot({ path: `${SHOTS}/enter-missing-create.png` })

  let body: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taskId: 'pw-enter-fake', task: { id: 'pw-enter-fake' } }) })
  })
  await input(page).press('Enter')
  await expect(picker(page)).toBeHidden()
  await expectPill(panel, fresh)

  await draftComposer(page).fill('start in the new folder')
  await draftComposer(page).press('Enter')
  await expect.poll(() => body, { timeout: 10_000 }).not.toBeNull()
  expect(body!.createCwd).toBe(true)
  expect(body!.cwd).toBe(fresh)
  // The launch was answered by the route above, so nothing was made on disk.
  expect(fs.existsSync(fresh)).toBe(false)
})

test('(iii) a user with no history sees Quick access first on the home listing', async ({ page }) => {
  // A fresh install from the picker's point of view: no history, no remote hosts.
  await page.route('**/api/sessions/working-dirs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dirs: [], hosts: [] }) }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible()
  // No history: the picker opens on the home folder.
  await expect(input(page)).toHaveValue('~/')

  const quick = picker(page).locator('[data-section-id="quick:__local__"]')
  await expect(quick).toBeVisible({ timeout: 20_000 })
  await expect(quick.locator('.sps-section-label')).toHaveText('⭐ Quick access')
  // Quick access leads the list, before the home listing itself.
  await expect(picker(page).locator('.sps-section').first()).toHaveAttribute('data-section-id', 'quick:__local__')
  const rows = quick.locator('.sps-path-item')
  const titles = await rows.locator('.sps-path-cwd').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
  const home = titles[0].replace(/\/+$/, '')
  expect(home.length).toBeGreaterThan(1)
  // Home first, then only the usual work folders (the fixture's home has "projects";
  // its daemon, notes, tasks and hidden dirs are never offered here).
  const QUICK = ['Desktop', 'Documents', 'Downloads', 'code', 'Code', 'projects', 'Projects', 'src', 'dev', 'workplace', 'repos', 'git', 'GitHub', 'work']
  const projectsIdx = titles.indexOf(`${home}/projects/`)
  expect(projectsIdx).toBeGreaterThan(0)
  for (const t of titles.slice(1)) {
    expect(t.startsWith(`${home}/`)).toBe(true)
    expect(QUICK).toContain(t.slice(home.length + 1).replace(/\/$/, ''))
  }
  await picker(page).screenshot({ path: `${SHOTS}/quick-access-fresh-user.png` })

  // Nothing highlighted until ↓; ↓ lands on the home row, then walks to "projects",
  // and Enter opens it like any row. Quick access then steps aside.
  await expect(picker(page).locator('.sps-path-item.active')).toHaveCount(0)
  await input(page).press('ArrowDown')
  await expect(rows.first()).toHaveClass(/active/)
  for (let i = 0; i < projectsIdx; i++) await input(page).press('ArrowDown')
  await expect(rows.nth(projectsIdx)).toHaveClass(/active/)
  await input(page).press('Enter')
  await expect(input(page)).toHaveValue(/\/projects\/$/)
  await expect(quick).toHaveCount(0)

  // Back on the home listing it returns; the home row itself picks the home folder.
  await input(page).fill('~/')
  await expect(quick).toBeVisible({ timeout: 20_000 })
  await rows.first().click()
  await expect(picker(page)).toBeHidden()
  await expectPill(panel, home)
})

test('(iii) with history, the home listing shows no Quick access', async ({ page }) => {
  await openPicker(page)
  await input(page).fill('~/')
  await expect(picker(page).locator('.sps-path-list .sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  await expect(picker(page).locator('[data-section-id^="quick:"]')).toHaveCount(0)
})
