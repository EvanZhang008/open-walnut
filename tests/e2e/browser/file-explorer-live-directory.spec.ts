import { test, expect, type Locator, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION = 'pw-vscode-session'
const TASK = 'pw-task-vscode'
const EVIDENCE = '/tmp/files-directory-refresh'
const row = (tree: Locator, name: string) => tree.locator('.sfe-name').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })

async function openFiles(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION)
  await page.locator(`.todo-panel-item[data-task-id="${TASK}"] .todo-item-title`).click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION}"]`)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const tree = panel.locator('.session-file-explorer')
  await expect(row(tree, 'refresh-target.txt')).toBeVisible()
  const response = await page.request.get(`/api/sessions/${SESSION}`)
  expect(response.ok()).toBe(true)
  const body = await response.json()
  const cwd = body.session?.cwd ?? body.cwd
  expect(typeof cwd).toBe('string')
  return { panel, tree, cwd: cwd as string }
}

test.beforeEach(async ({ page, baseURL }) => {
  await fs.mkdir(EVIDENCE, { recursive: true })
  await page.route(/\/api\/ui-prefs(\?|$)/, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { prefs: {} } })
    : route.fulfill({ json: { ok: true } }))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
    localStorage.setItem('open-walnut-live-edit', '0')
  })
  await page.evaluate(url => { window.location.href = url }, baseURL!)
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
})

test('external changes update the root and a deep expanded folder without Refresh or losing a draft', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const { tree, cwd } = await openFiles(page)
  const rootName = `live-tree-${test.info().project.name}`
  const root = path.join(cwd, rootName)
  const deep = path.join(root, 'docs', 'designs', 'current')
  await fs.mkdir(deep, { recursive: true })
  await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(deep, `item-${String(i).padStart(3, '0')}.txt`), `Item ${i}\n`)))
  await fs.writeFile(path.join(deep, 'draft.txt'), 'Preserve this draft\n')
  try {
    await expect(row(tree, rootName)).toBeVisible({ timeout: 15_000 })
    for (const name of [rootName, 'docs', 'designs', 'current']) await row(tree, name).click()
    await expect(row(tree, 'draft.txt')).toBeVisible()
    await row(tree, 'draft.txt').click()
    const editor = tree.locator('.cm-content')
    await expect(editor).toContainText('Preserve this draft')
    await editor.click()
    await editor.press('End')
    await editor.pressSequentially(' UNSAVED')
    await expect(editor).toContainText('UNSAVED')
    const scroller = tree.locator('.session-file-explorer-tree')
    await row(tree, 'item-080.txt').scrollIntoViewIfNeeded()
    const scrollBefore = await scroller.evaluate(el => el.scrollTop)
    expect(scrollBefore).toBeGreaterThan(0)
    for (let round = 0; round < 2; round++) {
      const added = `z-new-${round}.txt`
      const renamed = `z-renamed-${round}.txt`
      await fs.writeFile(path.join(deep, added), 'Created externally\n')
      await expect(row(tree, added)).toBeAttached({ timeout: 15_000 })
      await fs.rename(path.join(deep, added), path.join(deep, renamed))
      await expect(row(tree, added)).toHaveCount(0, { timeout: 15_000 })
      await expect(row(tree, renamed)).toBeAttached()
      await fs.unlink(path.join(deep, renamed))
      await expect(row(tree, renamed)).toHaveCount(0, { timeout: 15_000 })
      await expect(editor).toContainText('UNSAVED')
      expect(await fs.readFile(path.join(deep, 'draft.txt'), 'utf8')).toBe('Preserve this draft\n')
      expect(await scroller.evaluate(el => el.scrollTop)).toBe(scrollBefore)
    }
    const anchor = row(tree, 'item-080.txt')
    const beforeTop = (await anchor.boundingBox())!.y
    await fs.writeFile(path.join(deep, 'aaa-before.txt'), 'Inserted above the viewport\n')
    await expect(row(tree, 'aaa-before.txt')).toBeAttached({ timeout: 15_000 })
    expect(Math.abs((await anchor.boundingBox())!.y - beforeTop)).toBeLessThanOrEqual(1)
    await fs.unlink(path.join(deep, 'aaa-before.txt'))
    await expect(row(tree, 'aaa-before.txt')).toHaveCount(0, { timeout: 15_000 })
    expect(Math.abs((await anchor.boundingBox())!.y - beforeTop)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${EVIDENCE}/${test.info().project.name}-deep-tree.png` })
    await fs.rm(root, { recursive: true })
    await expect(row(tree, rootName)).toHaveCount(0, { timeout: 15_000 })
    await expect(editor).toContainText('UNSAVED')
    expect(errors).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an expanded directory keeps its children through a delayed UI rename and continues refreshing', async ({ page }) => {
  test.setTimeout(60_000)
  const { tree, cwd } = await openFiles(page)
  const name = `rename-tree-${test.info().project.name}`
  const renamed = `${name}-new`
  const source = path.join(cwd, name)
  const destination = path.join(cwd, renamed)
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'kept.txt'), 'Keep the expanded row\n')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached = false
  await page.route('**/api/files/rename', async route => {
    const response = await route.fetch()
    reached = true
    await held
    await route.fulfill({ response })
  })
  try {
    await expect(row(tree, name)).toBeVisible({ timeout: 15_000 })
    await row(tree, name).click()
    await expect(row(tree, 'kept.txt')).toBeVisible()
    await row(tree, name).click({ button: 'right' })
    await page.getByTestId('file-ctx-menu').getByRole('menuitem', { name: 'Rename…' }).click()
    const input = tree.getByRole('textbox', { name: 'New name' })
    await input.fill(renamed)
    await input.press('Enter')
    await expect.poll(() => reached).toBe(true)
    await page.waitForTimeout(6_000)
    await expect(row(tree, 'kept.txt')).toBeVisible()
    release()
    await expect(row(tree, renamed)).toBeVisible()
    await expect(row(tree, 'kept.txt')).toBeVisible()
    await fs.writeFile(path.join(destination, 'after-rename.txt'), 'Still updates\n')
    await expect(row(tree, 'after-rename.txt')).toBeVisible({ timeout: 15_000 })
  } finally {
    release()
    await page.unroute('**/api/files/rename')
    await fs.rm(source, { recursive: true, force: true })
    await fs.rm(destination, { recursive: true, force: true })
  }
})

test('refresh holds the visible row in its own section when two roots overlap', async ({ page }) => {
  test.setTimeout(60_000)
  const response = await page.request.get(`/api/sessions/${SESSION}`)
  const body = await response.json()
  const cwd = body.session?.cwd ?? body.cwd
  const name = `overlap-${test.info().project.name}`
  const root = path.join(cwd, name)
  await fs.mkdir(root, { recursive: true })
  await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(root, `overlap-${String(i).padStart(3, '0')}.txt`), 'Row\n')))
  await page.route(`**/api/sessions/${SESSION}/changes?**`, route => route.fulfill({ json: {
    sessionId: SESSION, groups: [{ repoRoot: root, label: name, kind: 'other', files: [] }], fileCount: 0, anyPartial: false,
  } }))
  try {
    const { tree } = await openFiles(page)
    const sections = tree.locator('.sfe-root-section')
    await expect(sections).toHaveCount(2)
    await row(sections.first(), name).click()
    await sections.last().locator('.sfe-root-header').click()
    const anchor = row(sections.last(), 'overlap-080.txt')
    await anchor.scrollIntoViewIfNeeded()
    const top = (await anchor.boundingBox())!.y
    await fs.writeFile(path.join(root, 'aaa-insert.txt'), 'Inserted\n')
    await expect(row(sections.last(), 'aaa-insert.txt')).toBeAttached({ timeout: 15_000 })
    expect(Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a stale listing survives a host outage and catches up without a click after recovery', async ({ page }) => {
  test.setTimeout(60_000)
  const { tree, cwd } = await openFiles(page)
  const name = `recovered-${test.info().project.name}.txt`
  const target = path.join(cwd, name)
  let down = true
  await page.route('**/api/files/list-many', async route => {
    if (!down) return route.fallback()
    const { paths } = route.request().postDataJSON() as { paths: string[] }
    await route.fulfill({ json: { listings: paths.map(path => ({ path, error: 'Reconnecting to host', code: 'host_reconnecting' })), truncated: false, timedOut: false } })
  })
  try {
    await fs.writeFile(target, 'Recovered\n')
    const stale = tree.locator('.sfe-notice', { hasText: 'Showing the last known contents' })
    await expect(stale).toBeVisible({ timeout: 15_000 })
    await expect(stale).toHaveAttribute('title', 'Reconnecting to host')
    await expect(row(tree, 'refresh-target.txt')).toBeVisible()
    down = false
    await expect(row(tree, name)).toBeVisible({ timeout: 15_000 })
    await expect(stale).toHaveCount(0)
    await tree.getByRole('button', { name: 'Hide file tree', exact: true }).click()
    await expect(tree.locator('.session-file-explorer-tree')).toHaveCount(0)
    await tree.getByRole('button', { name: 'Show file tree', exact: true }).click()
    await expect(row(tree, name)).toBeVisible()
  } finally {
    await page.unroute('**/api/files/list-many')
    await fs.rm(target, { force: true })
  }
})
