/**
 * The draft launch bar's last row says what each control is (2026-09-24):
 * "Choose folder and host…" / "Folder/Host: x · host", then "Project: y" once
 * the folder decided one ("New project: y" when Start will create it), then
 * More. The project is changed in More's Project section, and the row's height
 * never depends on whether the project chip is there, so a quick folder click
 * never moves the chips above it under the pointer.
 *
 * Real UI only; page.goto is used only to load the app. Folders live in the
 * fixture's own temp tree; project names are neutral and stamped.
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  CHOOSE_FOLDER, basenameOf, discoverFixtureRoot, draftCwdPill, draftLaunchBar, draftMenuProject,
  draftMoreButton, draftPanel, draftProjectPill, draftQuickChips, draftTaskMenu, loadHome, openDraft,
  openDraftOnCwd,
} from './draft-helpers'
import { createTaskForLater } from './draft-outcome-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-folder-host-project/shots/spec'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

async function claimFolder(page: Page, project: string, cwd: string | null): Promise<void> {
  const res = await page.request.put(`/api/projects/${project}/metadata`, { data: cwd ? { default_cwd: cwd } : {} })
  expect(res.ok(), await res.text()).toBe(true)
}

function freshFolder(stem: string): string {
  const cwd = `${fixtureRoot}/projects/${stem}-${Date.now().toString(36)}`
  fs.mkdirSync(cwd, { recursive: true })
  return cwd
}

const flyout = (page: Page) => page.locator('.task-kebab-project-flyout')
const lastChildClass = (panel: Locator) => panel.locator('.draft-composer-bar')
  .evaluate((el) => el.lastElementChild?.className ?? '')

test('a fresh draft asks for a folder and host, and says nothing about a project', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await loadHome(page)
  const panel = await openDraft(page)
  await expect(draftCwdPill(panel)).toHaveText(CHOOSE_FOLDER)
  await expect(draftCwdPill(panel)).toHaveAttribute('aria-label', 'Choose folder and host')
  await expect(draftProjectPill(panel)).toHaveCount(0)
  expect(await lastChildClass(panel)).toContain('draft-more-btn')
  // The project is still settable before any folder: More's first section.
  await draftMoreButton(panel).click()
  await expect(draftMenuProject(page)).toContainText('Inbox')
  await expect(draftMenuProject(page)).toContainText('Inbox until you pick a folder or a project')
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
})

test('a folder a project owns reads Folder/Host and Project; a new folder reads New project', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const owned = freshFolder('acme-app')
  const OWNER = `Acme${Date.now().toString(36)}`
  await claimFolder(page, OWNER, owned)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, owned)
  await expect(draftCwdPill(panel)).toHaveText(`Folder/Host: ${basenameOf(owned)} · Local`)
  const title = await draftCwdPill(panel).getAttribute('title')
  expect(title).toContain(`Folder: ${owned}`)
  expect(title).toContain('Host: Local (this machine)')
  await expect(draftProjectPill(panel)).toHaveText(`Project: ${OWNER}`)
  await expect(draftProjectPill(panel)).not.toHaveClass(/draft-project-chip-new/)
  await expect(draftProjectPill(panel)).toHaveAttribute('title', `Tasks from this folder file under ${OWNER}. Change it in More.`)
  expect(await lastChildClass(panel)).toContain('draft-more-btn')

  const fresh = freshFolder('notes-lab')
  await draftCwdPill(panel).click()
  const input = page.locator('.session-path-selector .sps-search-input')
  await input.fill(fresh)
  await input.press('Shift+Enter')
  await expect(page.locator('.session-path-selector')).toBeHidden()
  const name = basenameOf(fresh)
  await expect(draftProjectPill(panel)).toHaveText(`New project: ${name}`)
  await expect(draftProjectPill(panel)).toHaveClass(/draft-project-chip-new/)
  await expect(draftProjectPill(panel)).toHaveAttribute('title', `Starting creates a new project named ${name}. Change it in More.`)
  expect(await draftProjectPill(panel).evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
  await draftLaunchBar(panel).screenshot({ path: `${SHOTS}/new-project-chip.png` })
})

test('the project chip opens More at its Project section; a pick there is the task project', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const stamp = Date.now().toString(36)
  const owned = freshFolder('marina-web')
  const OWNER = `Owner${stamp}`
  const OTHER = `Marina${stamp}`
  await claimFolder(page, OWNER, owned)
  await claimFolder(page, OTHER, null)
  // Enough projects that the list grows its filter box.
  for (let i = 0; i < 7; i++) await claimFolder(page, `Filler${stamp}${i}`, null)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, owned)
  const chip = draftProjectPill(panel)
  await expect(chip).toHaveText(`Project: ${OWNER}`)
  await chip.click()
  const menu = draftTaskMenu(page)
  await expect(menu).toBeVisible()
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  // The Project section is the menu's first section, right under its title.
  const first = await menu.evaluate((el) => el.children[1]?.getAttribute('data-testid'))
  expect(first).toBe('draft-menu-project')
  await expect(draftMenuProject(page)).toContainText(OWNER)
  await expect(draftMenuProject(page).locator('.draft-task-menu-project-why')).toHaveText(`Set by the folder ${basenameOf(owned)}`)
  const chipBox = await chip.boundingBox()
  const menuBox = await menu.boundingBox()
  expect(Math.abs((menuBox?.x ?? 0) - (chipBox?.x ?? 0)), 'the menu hangs from the chip').toBeLessThan(3)

  // Clicks inside the list (its filter box, its scroll) never close the menu.
  await draftMenuProject(page).locator('.task-kebab-project-current').click()
  await expect(flyout(page)).toBeVisible()
  const filter = flyout(page).locator('.task-kebab-project-filter')
  await filter.click()
  await flyout(page).evaluate((el) => { el.scrollTop = 40 })
  await expect(menu).toBeVisible()
  // One Escape closes one layer: the list first, then the menu.
  await page.keyboard.press('Escape')
  await expect(flyout(page)).toHaveCount(0)
  await expect(menu).toBeVisible()
  await draftMenuProject(page).locator('.task-kebab-project-current').click()
  await flyout(page).locator('.task-kebab-project-filter').fill(OTHER)
  await flyout(page).locator('.task-kebab-project-opt', { hasText: new RegExp(`^${OTHER}$`) }).click()
  await expect(menu).toHaveCount(0)
  await expect(chip).toHaveText(`Project: ${OTHER}`)
  await expect(chip).toHaveAttribute('title', 'Your pick. Change it in More.')

  // The launch carries it: the task files under the picked project.
  await panel.locator('.chat-input-textarea').fill(`file under the picked project ${stamp}`)
  const taskId = await createTaskForLater(page, panel)
  const res = await page.request.get(`/api/tasks/${taskId}`)
  expect(((await res.json()) as { task: { project?: string } }).task.project).toBe(OTHER)
})

test('a keyboard open from the project chip lands on the Project row; Escape returns to the chip', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const owned = freshFolder('keys-case')
  await claimFolder(page, `Keys${Date.now().toString(36)}`, owned)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, owned)
  const chip = draftProjectPill(panel)
  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(draftTaskMenu(page)).toBeVisible()
  await expect(draftMenuProject(page).locator('.task-kebab-project-current')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(chip).toBeFocused()
})

test('Inbox picked in More stays visible as Project: Inbox', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const owned = freshFolder('inbox-case')
  await claimFolder(page, `Inboxcase${Date.now().toString(36)}`, owned)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, owned)
  await draftMoreButton(panel).click()
  await draftMenuProject(page).locator('.task-kebab-project-current').click()
  await flyout(page).locator('.task-kebab-project-opt', { hasText: /^Inbox$/ }).click()
  await expect(draftProjectPill(panel)).toHaveText('Project: Inbox')
  await expect(draftProjectPill(panel)).toHaveAttribute('title', 'Your pick: no project. Change it in More.')
})

test('a quick folder names its host only when two chips share a folder name', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const now = new Date().toISOString()
  // Read-only stub of the history: two "walnut" checkouts (remote + local) and
  // one unique folder on each side.
  await page.route('**/api/sessions/working-dirs', (route) => route.fulfill({ json: { hosts: [], dirs: [
    { cwd: '/home/pw/remote/walnut', host: 'remote-fixture', hostLabel: 'Big remote host', project: '', count: 9, lastUsed: now },
    { cwd: '/Users/pw/code/walnut', host: null, project: '', count: 8, lastUsed: now },
    { cwd: '/home/pw/remote/solo-remote', host: 'remote-fixture', hostLabel: 'Big remote host', project: '', count: 7, lastUsed: now },
    { cwd: '/Users/pw/code/solo-local', host: null, project: '', count: 6, lastUsed: now },
  ] } }))
  await loadHome(page)
  const panel = await openDraft(page)
  const chips = draftQuickChips(panel)
  await expect(chips).toHaveCount(4)
  const texts = (await chips.allTextContents()).map((t) => t.trim()).sort()
  expect(texts).toEqual(['solo-local', 'solo-remote', 'walnut · Big remote host', 'walnut · Local'])
  await draftLaunchBar(panel).screenshot({ path: `${SHOTS}/quick-chips-collision.png` })
})

/** Top of every quick chip plus the pill row's height. */
async function rowGeometry(panel: Locator): Promise<{ tops: number[]; bar: number }> {
  const tops = await draftQuickChips(panel).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  const bar = await panel.locator('.draft-composer-bar').evaluate((el) => Math.round(el.getBoundingClientRect().height))
  return { tops, bar }
}

for (const width of [2400, 1100]) {
  test(`a quick folder click moves nothing under the pointer (${width}px window)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await loadHome(page)
    const panel = await openDraft(page)
    const chips = draftQuickChips(panel)
    await expect(chips.first()).toBeVisible()
    // The row fills in from the working-dirs answer: measure once it settled.
    let count = -1
    await expect.poll(async () => { const n = await chips.count(); const same = n === count; count = n; return same }, { intervals: [300] }).toBe(true)
    const before = await rowGeometry(panel)
    const barWidth = await panel.locator('.draft-composer-bar').evaluate((el) => el.getBoundingClientRect().width)
    await chips.first().click()
    await expect(draftProjectPill(panel)).toBeVisible()
    const after = await rowGeometry(panel)
    expect(after.tops, 'no quick chip moved').toEqual(before.tops)
    expect(Math.abs(after.bar - before.bar), `the row kept its height at ${Math.round(barWidth)}px`).toBeLessThanOrEqual(1)
    // Every part of the row stays inside the column.
    const overflow = await panel.locator('.draft-composer-bar').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [...el.children].some((c) => c.getBoundingClientRect().right > r.right + 1)
    })
    expect(overflow).toBe(false)
    await draftLaunchBar(panel).screenshot({ path: `${SHOTS}/row-${width}.png` })
  })
}

test('a bound draft moves its task from the project chip, before any Start', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  const stamp = Date.now().toString(36)
  const TARGET = `Moved${stamp}`
  await claimFolder(page, TARGET, null)
  const cwd = `${fixtureRoot}/projects/walnut`
  const created = await page.request.post('/api/tasks', { data: { title: `bound chip move ${stamp}`, source: 'local', project: 'Walnut', cwd } })
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  await loadHome(page)
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`).first()
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.hover()
  await row.locator('.task-start-btn').click()
  const panel = draftPanel(page)
  await expect(panel.locator('.draft-bound-task')).toBeVisible()

  const chip = draftProjectPill(panel)
  await expect(chip).toHaveText('Project: Walnut')
  await chip.click()
  await expect(draftTaskMenu(page), 'a bound draft has no More: the list opens directly').toHaveCount(0)
  await expect(flyout(page)).toBeVisible()
  // Escape closes only the list and hands focus back to the chip.
  await page.keyboard.press('Escape')
  await expect(flyout(page)).toHaveCount(0)
  await expect(chip).toBeFocused()
  await expect(panel.locator('.draft-bound-task')).toBeVisible()
  await chip.click()
  await expect(flyout(page)).toBeVisible()
  const filter = flyout(page).locator('.task-kebab-project-filter')
  if (await filter.count()) await filter.fill(TARGET)
  await flyout(page).locator('.task-kebab-project-opt', { hasText: new RegExp(`^${TARGET}$`) }).click()
  await expect.poll(async () => {
    const r = await page.request.get(`/api/tasks/${taskId}`)
    return ((await r.json()) as { task: { project?: string } }).task.project
  }, { timeout: 10_000 }).toBe(TARGET)
  await expect(chip).toHaveText(`Project: ${TARGET}`, { timeout: 10_000 })
})
