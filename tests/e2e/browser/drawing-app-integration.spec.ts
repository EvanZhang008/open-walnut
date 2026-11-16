import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadHome } from './draft-helpers'
import { openKebabGroup } from './kebab-group-helpers'
import { useDrawingFixture } from './plugin-fixture'

// Its own server with the real Drawing plugin linked (plugin-mic-server.ts, PW_PLUGIN_FIXTURE=drawing),
// one per worker: the file's tests run in order on it.
useDrawingFixture()
test.describe.configure({ mode: 'default', timeout: 180_000 })
test.use({ viewport: { width: 1280, height: 900 } })
const APP_KEY = 'walnut-drawing:main'
const SHOTS = '/tmp/drawing-app-integration'
const workspace = (page: Page) => page.locator('.drawing-workspace')
const appRow = (page: Page) => page.getByTestId(`sidebar-open-app-${APP_KEY}`)

async function shot(page: Page, name: string) {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' })
}

async function openDrawingApp(page: Page) {
  await loadHome(page)
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('apps-search').fill('Drawing')
  await page.getByTestId('plugin-card-open-walnut-drawing').click()
  await expect(workspace(page)).toBeVisible({ timeout: 60_000 })
}

/**
 * The text tool opens Excalidraw's properties panel over the canvas's left 220 px, so `x` is
 * measured from LEFT: a double click on the panel never opens the text editor.
 */
const LEFT = 260

async function addText(page: Page, text: string, x: number, y: number) {
  const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible({ timeout: 60_000 })
  await canvas.click({ position: { x: 40, y: 180 } })
  // Measured after the click, which waits for a stable canvas: a new drawing remounts it.
  const box = await canvas.boundingBox()
  if (!box) throw new Error('The drawing canvas has no box')
  await page.keyboard.press('t')
  // One click: with the text tool picked, a double click's second press ends the empty text.
  await page.mouse.click(box.x + LEFT + x, box.y + y)
  const editor = workspace(page).locator('textarea.excalidraw-wysiwyg')
  await expect(editor).toBeVisible()
  await editor.fill(text)
  await editor.press('Escape')
  await expect(workspace(page).locator('.drawing-workspace-status')).toHaveText('Saved', { timeout: 30_000 })
}

async function documentOnScreen(page: Page) {
  const scenePath = await workspace(page).getAttribute('data-drawing-path')
  expect(scenePath).toBeTruthy()
  const response = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(scenePath!)}`)
  expect(response.ok(), await response.text()).toBe(true)
  return await response.json() as { path: string; title: string; revision: string; scene: { elements: Array<{ type: string; text?: string }> } }
}

test.describe('Drawing real plugin acceptance', () => {
  test('drawing App is active until closed, recently used and pinned without moving core apps', async ({ page }) => {
    await openDrawingApp(page)
    await expect(appRow(page)).toBeVisible()
    await page.getByTestId('sidebar-core-app-notes').click()
    await expect(appRow(page)).toBeVisible()
    await page.getByTestId('sidebar-core-app-apps').click()
    const recent = page.getByTestId(`apps-quick-recent-${APP_KEY}`)
    await expect(recent).toBeVisible()
    await page.getByTestId(`apps-quick-pin-${APP_KEY}`).click()
    await expect(page.getByTestId(`apps-quick-pinned-${APP_KEY}`)).toBeVisible()
    await shot(page, 'apps-pinned-active')
    await page.getByTestId(`sidebar-open-app-close-${APP_KEY}`).click()
    await expect(appRow(page)).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId(`apps-quick-pinned-${APP_KEY}`)).toBeVisible({ timeout: 60_000 })
    await page.getByTestId(`apps-quick-pinned-${APP_KEY}`).getByRole('button', { name: 'Open Drawing' }).click()
    await expect(workspace(page)).toBeVisible()
    await expect(appRow(page)).toBeVisible()
    await page.getByTestId('sidebar-core-app-apps').click()
    await page.getByTestId(`apps-quick-pin-${APP_KEY}`).click()
    await expect(page.getByTestId(`apps-quick-recent-${APP_KEY}`)).toBeVisible()
    await expect(page.getByTestId('sidebar-core-app-notes')).toBeVisible()
    await expect(page.getByTestId('sidebar-core-app-tasks')).toBeVisible()
  })

  test('a real editable scene is saved in Inbox, reopens from Notes and is searchable there', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openDrawingApp(page)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    await addText(page, 'Order -> review\nText, rating, user, pictures\nUnicode: ' + '\u4f60\u597d', 180, 230)
    const doc = await documentOnScreen(page)
    expect(doc.path).toMatch(/^inbox\//)
    expect(doc.scene.elements.some((element) => element.text?.includes('pictures'))).toBe(true)
    await shot(page, 'drawing-saved')
    await page.getByTestId('sidebar-core-app-notes').click()
    const filename = path.basename(doc.path)
    // The tree draws after the page: wait for the folder, then open it unless it is open already.
    // The folder's own arrow says whether it is open (the tree keeps that across visits); a click on
    // an open folder would close it.
    const inbox = page.locator('.notes-tree-folder[data-node-path="inbox"]')
    await expect(inbox).toBeVisible({ timeout: 30_000 })
    const entry = page.locator('.notes-tree-name').filter({ hasText: filename })
    if (!(await inbox.locator('.notes-tree-arrow.expanded').count())) await inbox.click()
    await expect(entry).toBeVisible({ timeout: 30_000 })
    await entry.click()
    await expect(workspace(page)).toHaveAttribute('data-drawing-path', doc.path, { timeout: 60_000 })
    const reopened = await documentOnScreen(page)
    expect(reopened.scene.elements).toEqual(doc.scene.elements)
    await shot(page, 'notes-editable-scene')
    const search = await page.request.get('/api/notes-v2/search?q=pictures')
    expect(search.ok(), await search.text()).toBe(true)
    expect(JSON.stringify(await search.json())).toContain(doc.path.replace(/\.excalidraw$/, '.drawing.md'))
    expect(errors).toEqual([])
  })

  test('session pane saves under its task and the real agent op appends without overwriting', async ({ page }) => {
    await loadHome(page)
    if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()
    const seeded = await page.request.post('/api/sessions/quick-start', {
      data: { cwd: process.cwd(), message: `Drawing review fixture ${Date.now()}`, project: 'Drawing Fixture' },
    })
    expect(seeded.ok(), await seeded.text()).toBe(true)
    const { sessionId, taskId } = await seeded.json() as { sessionId: string; taskId: string }
    await page.locator('.todo-search-input').fill(taskId)
    const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
    await expect(task).toBeVisible({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await panel.locator('.task-kebab-btn').click()
    const menu = page.locator('.task-kebab-menu:visible')
    const open = await openKebabGroup(menu, 'session-kebab-open')
    await open.getByTestId('session-menu-apps').click()
    await expect(page.getByTestId('session-app-pane')).toHaveAttribute('data-app-key', APP_KEY)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    await addText(page, 'Order\nreview\nuser', 150, 210)
    const before = await documentOnScreen(page)
    expect(before.path).not.toMatch(/^inbox\//)
    // The pane shares a small status on the same real app-state path the agent reads.
    await expect.poll(async () => {
      const response = await page.request.get('/api/v1/me/app-state', { headers: { 'x-walnut-caller-sid': sessionId } })
      return response.ok() ? JSON.stringify(await response.json()) : ''
    }, { timeout: 30_000 }).toContain(before.path)
    const read = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_read', { data: { path: before.path } })
    expect(read.ok(), await read.text()).toBe(true)
    const readResult = await read.json()
    expect(readResult.ok, JSON.stringify(readResult)).toBe(true)
    expect(readResult.result.path).toBe(before.path)
    const append = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_append', {
      data: { path: before.path, revision: before.revision, elements: [{ type: 'rectangle', x: 380, y: 150, width: 180, height: 100, text: 'Agent addition' }] },
    })
    expect(append.ok(), await append.text()).toBe(true)
    const appendResult = await append.json()
    expect(appendResult.ok, JSON.stringify(appendResult)).toBe(true)
    await expect.poll(async () => (await documentOnScreen(page)).scene.elements.length, { timeout: 30_000 }).toBeGreaterThan(before.scene.elements.length)
    const after = await documentOnScreen(page)
    expect(after.scene.elements.some((element) => element.text === 'Agent addition')).toBe(true)
    expect(after.scene.elements.filter((element) => element.text?.includes('review'))).toHaveLength(1)
    await shot(page, 'session-agent-addition')

    // The person sketches by hand; the agent looks at the picture, fixes text and tidies the strokes.
    const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
    const box = (await canvas.boundingBox())!
    await canvas.click({ position: { x: 40, y: 180 } })
    await page.keyboard.press('p')
    for (const [x0, y0, x1, y1] of [[160, 380, 300, 380], [300, 380, 300, 460], [380, 420, 520, 420]]) {
      await page.mouse.move(box.x + x0, box.y + y0)
      await page.mouse.down()
      for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + x0 + ((x1 - x0) * step) / 8, box.y + y0 + ((y1 - y0) * step) / 8)
      await page.mouse.up()
    }
    await page.keyboard.press('Escape')
    await expect(workspace(page).locator('.drawing-workspace-status')).toHaveText('Saved', { timeout: 30_000 })
    const sketched = await documentOnScreen(page)
    const strokes = sketched.scene.elements.filter((element) => element.type === 'freedraw') as Array<{ id: string }>
    expect(strokes.length).toBeGreaterThanOrEqual(3)
    const render = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_render', { data: { path: sketched.path } })
    const renderResult = await render.json()
    expect(renderResult.ok, JSON.stringify(renderResult)).toBe(true)
    const imagePath = renderResult.result.pngPath ?? renderResult.result.svgPath
    expect((await fs.stat(imagePath)).size).toBeGreaterThan(500)
    const label = sketched.scene.elements.find((element) => element.text === 'Order\nreview\nuser') as { id: string } | undefined
    expect(label).toBeTruthy()
    const tidy = await page.request.post('/api/plugin-runtime/walnut-drawing/ops/walnut_drawing_update', {
      data: {
        path: sketched.path, revision: sketched.revision,
        update: [{ id: label!.id, text: 'Order review' }],
        remove: strokes.map((stroke) => stroke.id),
        add: [
          { id: 'box1', type: 'rectangle', x: 160, y: 360, width: 150, height: 80, text: 'Order' },
          { id: 'box2', type: 'rectangle', x: 400, y: 360, width: 150, height: 80, text: 'Review' },
          { type: 'arrow', start: { id: 'box1' }, end: { id: 'box2' } },
        ],
      },
    })
    const tidyResult = await tidy.json()
    expect(tidyResult.ok, JSON.stringify(tidyResult)).toBe(true)
    // The open canvas takes the agent's edit at once (the server's push, well inside the 5 s poll),
    // and the file holds exactly that.
    await expect(workspace(page)).toHaveAttribute('data-drawing-revision', tidyResult.result.revision, { timeout: 3_000 })
    await expect(workspace(page).locator('.drawing-workspace-status')).toHaveText('Saved', { timeout: 30_000 })
    await shot(page, 'session-agent-tidied')
    await expect.poll(async () => {
      const doc = await documentOnScreen(page)
      return doc.scene.elements.filter((element) => !(element as { isDeleted?: boolean }).isDeleted && element.type === 'freedraw').length
    }, { timeout: 30_000 }).toBe(0)
    const tidied = await documentOnScreen(page)
    const live = tidied.scene.elements.filter((element) => !(element as { isDeleted?: boolean }).isDeleted) as Array<{ id: string; type: string; text?: string; startBinding?: { elementId: string }; endBinding?: { elementId: string } }>
    expect(live.some((element) => element.text === 'Order review')).toBe(true)
    expect(live.some((element) => element.text === 'Agent addition')).toBe(true)
    const arrow = live.find((element) => element.type === 'arrow' && element.startBinding && element.endBinding)
    expect(arrow).toBeTruthy()
    const idMap = tidyResult.result.idMap as Record<string, string>
    expect(arrow!.startBinding!.elementId).toBe(idMap.box1)
    expect(arrow!.endBinding!.elementId).toBe(idMap.box2)
    // Undo on the person's side must not bring the agent's removed strokes back as a silent revert.
    await page.keyboard.press('v')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(2_000)
    await expect(workspace(page).locator('.drawing-workspace-status')).toHaveText('Saved', { timeout: 30_000 })
    const afterUndo = await documentOnScreen(page)
    expect(afterUndo.scene.elements.filter((element) => !(element as { isDeleted?: boolean }).isDeleted && element.type === 'freedraw')).toHaveLength(0)
    await shot(page, 'session-agent-tidied-after-undo')
    await page.getByTestId('session-app-pane-close').click()
    await expect(page.getByTestId('session-app-pane')).toHaveCount(0)
    await expect(panel.locator('.session-panel-chat-col')).toBeVisible()
  })
})
