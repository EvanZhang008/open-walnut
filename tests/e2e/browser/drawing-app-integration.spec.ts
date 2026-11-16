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
  // Clear of the properties panel a selected text opens over the left 220 px.
  await canvas.click({ position: { x: LEFT + 40, y: 160 } })
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

/** Each tool's shortcut as the toolbar draws it: the letter after the hidden digit ('' for none). */
async function toolbarShortcuts(page: Page): Promise<Record<string, string>> {
  return workspace(page).evaluate((root) => {
    const out: Record<string, string> = {}
    for (const input of root.querySelectorAll<HTMLInputElement>('input[data-testid^="toolbar-"][name="editor-current-shape"]')) {
      const label = input.parentElement?.querySelector('.ToolIcon__keybinding')
      if (!label) continue
      if (getComputedStyle(label).display === 'none') { out[input.dataset.testid!.slice('toolbar-'.length)] = ''; continue }
      const digit = getComputedStyle(label).fontSize
      const after = getComputedStyle(label, '::after').content.replace(/^"|"$/g, '')
      // The digit itself is sized away; only the letter drawn after it shows.
      out[input.dataset.testid!.slice('toolbar-'.length)] = digit === '0px' && after !== 'none' ? after : `digit:${label.textContent}`
    }
    return out
  })
}

async function documentOnScreen(page: Page) {
  const scenePath = await workspace(page).getAttribute('data-drawing-path')
  expect(scenePath).toBeTruthy()
  const response = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(scenePath!)}`)
  expect(response.ok(), await response.text()).toBe(true)
  return await response.json() as { path: string; title: string; revision: string; scene: { elements: Array<{ type: string; text?: string }> } }
}

/**
 * The title of the drawing on screen, '' while it moves: an auto name renames the file right after
 * its first save, so for a moment the path on screen is already gone.
 */
async function titleOnScreen(page: Page) {
  const scenePath = await workspace(page).getAttribute('data-drawing-path')
  if (!scenePath) return ''
  const response = await page.request.get(`/api/drawings/file?path=${encodeURIComponent(scenePath)}`)
  return response.ok() ? (await response.json() as { title: string }).title : ''
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
    // The file is named from its first text once that text is saved (a rename right after).
    await expect.poll(() => titleOnScreen(page), { timeout: 30_000 }).toMatch(/^Order/)
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
    await expect.poll(() => titleOnScreen(page), { timeout: 30_000 }).toMatch(/^Order/)
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
  // ── Round 2 (the user's 11-16 asks): each part its own test, so each has its own proof clip. ──

  test('round 2: a quiet header, export in the drawing menu, full screen in the App keeps the editor and its view', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openDrawingApp(page)
    const bar = workspace(page).locator('.drawing-workspace-bar')
    // Quiet header: no PNG or SVG buttons.
    await expect(bar.getByRole('button', { name: /^(PNG|SVG)$/ })).toHaveCount(0)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    // Each tool shows its letter shortcut (V, R, D...), never the editor's digit; Image has no letter.
    await expect(workspace(page).locator('input[data-testid="toolbar-rectangle"]')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => toolbarShortcuts(page)).toEqual({ selection: 'V', rectangle: 'R', diamond: 'D', ellipse: 'O', arrow: 'A', line: 'L', freedraw: 'P', text: 'T', image: '', eraser: 'E' })
    // The extra tools menu opens from three dots, drawn in place of the shapes icon.
    const more = workspace(page).locator('.App-toolbar__extra-tools-trigger')
    await expect(more.locator('svg')).toBeHidden()
    expect(await more.evaluate((el) => getComputedStyle(el, '::before').maskImage || getComputedStyle(el, '::before').webkitMaskImage)).toContain('circle')
    // The letter is the real key: with the canvas focused, R picks the rectangle.
    await workspace(page).locator('canvas.excalidraw__canvas.interactive').click({ position: { x: LEFT + 300, y: 300 } })
    await page.keyboard.press('r')
    await expect(workspace(page).locator('input[data-testid="toolbar-rectangle"]')).toBeChecked()
    await page.keyboard.press('v')
    await addText(page, 'Full screen check', 180, 230)
    await shot(page, 'round2-header')

    // Export from the menu downloads a file.
    await workspace(page).getByTestId('main-menu-trigger').click()
    await expect(workspace(page).locator('.dropdown-menu').getByText('Download SVG', { exact: true })).toBeVisible()
    await shot(page, 'round2-menu')
    const [png] = await Promise.all([page.waitForEvent('download'), workspace(page).locator('.dropdown-menu').getByText('Download PNG', { exact: true }).click()])
    expect(png.suggestedFilename()).toMatch(/\.png$/)
    expect((await fs.stat((await png.path())!)).size).toBeGreaterThan(200)

    // Zoom in and pan first, so the view kept is not the default one.
    const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
    await canvas.click({ position: { x: LEFT + 200, y: 500 } })
    await page.keyboard.press('ControlOrMeta+=')
    await page.keyboard.press('ControlOrMeta+=')
    const cb = (await canvas.boundingBox())!
    await page.mouse.move(cb.x + LEFT + 200, cb.y + 400)
    await page.mouse.wheel(0, 120)
    const host = workspace(page).locator('.drawing-canvas-host')
    await expect(host).not.toHaveAttribute('data-zoom', '1')
    const view = async () => ({ i: await host.getAttribute('data-editor-instance'), z: await host.getAttribute('data-zoom'), x: await host.getAttribute('data-scroll-x'), y: await host.getAttribute('data-scroll-y') })
    const before = await view()

    // Full screen covers the page area beside the sidebar, top to bottom (the sidebar stays usable,
    // as in every Walnut full screen), with the same editor and view, both ways.
    await bar.getByRole('button', { name: 'Full screen', exact: true }).click()
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'true')
    const full = (await workspace(page).boundingBox())!
    const sidebar = (await page.locator('.sidebar').first().boundingBox())!
    expect(full).toMatchObject({ y: 0, height: 900 })
    expect(Math.abs(full.x - (sidebar.x + sidebar.width))).toBeLessThanOrEqual(2)
    expect(Math.round(full.x + full.width)).toBe(1280)
    expect(await view()).toEqual(before)
    await shot(page, 'round2-fullscreen')
    // Escape in the editor is the editor's, not a way out.
    await canvas.click({ position: { x: LEFT + 200, y: 500 } })
    await page.keyboard.press('Escape')
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'true')
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'false')
    expect(await view()).toEqual(before)
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'true')
    await bar.getByRole('button', { name: 'Exit full screen', exact: true }).click()
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'false')
    expect(await view()).toEqual(before)
    // The App keeps the last choice: reopened, it is not full screen.
    await page.reload()
    await expect(workspace(page)).toBeVisible({ timeout: 60_000 })
    await expect(workspace(page)).toHaveAttribute('data-fullscreen', 'false')
    expect(errors).toEqual([])
  })

  test('round 2: New drawing makes no file until there is content, its first text names it, rename from the title', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openDrawingApp(page)
    const bar = workspace(page).locator('.drawing-workspace-bar')
    const created: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/drawings') created.push(r.postData() ?? '') })
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    await expect(workspace(page)).toHaveAttribute('data-save-state', 'sketch')
    await page.waitForTimeout(1_500)
    expect(created).toEqual([])

    // The first text names the drawing (once), in the header and in Notes.
    await addText(page, 'Order -> review\nsecond line', 180, 230)
    await expect.poll(() => titleOnScreen(page), { timeout: 30_000 }).toMatch(/^Order/)
    const named = await documentOnScreen(page)
    expect(created).toHaveLength(1)
    await expect(bar.locator('.drawing-workspace-title')).toHaveText(named.title)
    expect(path.basename(named.path)).not.toMatch(/^Drawing \d|Untitled/)
    await shot(page, 'round2-auto-named')

    // Rename from the title: the file moves, the list shows the new name.
    await bar.getByRole('button', { name: /^Rename drawing/ }).click()
    const input = bar.getByRole('textbox', { name: 'Drawing name' })
    await input.fill('Review flow')
    await shot(page, 'round2-rename-editing')
    await input.press('Enter')
    await expect(bar.locator('.drawing-workspace-title')).toHaveText('Review flow', { timeout: 30_000 })
    await expect(workspace(page)).toHaveAttribute('data-drawing-path', /Review flow\.excalidraw$/)
    const renamed = await documentOnScreen(page)
    expect(path.dirname(renamed.path)).toBe(path.dirname(named.path))
    expect((await page.request.get(`/api/drawings/file?path=${encodeURIComponent(named.path)}`)).status()).toBe(404)
    await expect(workspace(page).locator('.drawing-workspace-file-title').filter({ hasText: 'Review flow' })).toBeVisible()
    // A later text never renames a name a person set.
    await addText(page, 'Another note', 180, 420)
    await page.waitForTimeout(1_500)
    expect((await documentOnScreen(page)).title).toBe('Review flow')
    await shot(page, 'round2-renamed')

    // Notes lists the renamed drawing.
    await page.getByTestId('sidebar-core-app-notes').click()
    const inbox = page.locator('.notes-tree-folder[data-node-path="inbox"]')
    await expect(inbox).toBeVisible({ timeout: 30_000 })
    if (!(await inbox.locator('.notes-tree-arrow.expanded').count())) await inbox.click()
    await expect(page.locator('.notes-tree-name').filter({ hasText: path.basename(renamed.path) })).toBeVisible({ timeout: 30_000 })
    expect(errors).toEqual([])
  })

  test('round 2: Browse libraries adds a catalog library, kept on the server after a reload; a selected shape is added too', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // The catalog, its preview and its library file are mocked: the spec never reaches the internet.
    const shape = (id: string, type: string, seed: number) => ({ id, type, x: 0, y: 0, width: 80, height: 50, version: 1, versionNonce: seed, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, angle: 0, seed, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, isDeleted: false })
    const libraryFile = {
      type: 'excalidrawlib', version: 2, source: 'https://libraries.excalidraw.com',
      libraryItems: [
        { id: 'lib-server', status: 'published', created: 1, name: 'Server', elements: [shape('srv', 'rectangle', 1)] },
        { id: 'lib-db', status: 'published', created: 1, name: 'Database', elements: [shape('db', 'ellipse', 2)] },
      ],
    }
    await page.route('**/api/drawings/library/catalog', (route) => route.fulfill({ json: { items: [
      { id: 'system-boxes', name: 'System boxes', description: 'Shapes for system design sketches', authors: [{ name: 'Ann' }], source: 'ann/system-boxes.excalidrawlib', preview: '/api/drawings/library/preview?source=ann%2Fsystem-boxes.png', created: '2024-01-01', updated: '2024-02-01', itemNames: ['Server', 'Database'] },
      { id: 'icons', name: 'Icons', description: 'Small icons', authors: [{ name: 'Bo' }], source: 'bo/icons.excalidrawlib', preview: null, created: '2024-01-01', updated: '2024-01-01', itemNames: ['Star'] },
    ] } }))
    await page.route('**/api/drawings/library/preview**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }))
    await page.route('**/api/drawings/library/fetch**', (route) => route.fulfill({ json: libraryFile }))
    const libraryIds = async () => {
      const lib = await (await page.request.get('/api/drawings/library')).json() as { libraryItems: Array<{ id: string }> }
      return lib.libraryItems.map((i) => i.id).sort()
    }

    await openDrawingApp(page)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    // A shape to add later, drawn while the canvas is wide (the docked library narrows it).
    const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    const box = (await canvas.boundingBox())!
    await canvas.click({ position: { x: LEFT + 200, y: 500 } })
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 300, box.y + 360)
    await page.mouse.down()
    await page.mouse.move(box.x + 420, box.y + 440, { steps: 10 })
    await page.mouse.up()
    await expect(workspace(page).locator('.drawing-workspace-status')).toHaveText('Saved', { timeout: 30_000 })
    // The new drawing holds only that shape (never the shapes of the drawing open before it).
    expect((await documentOnScreen(page)).scene.elements.map((e) => e.type)).toEqual(['rectangle'])
    // Nothing selected, so the Library shows no "add" tile.
    await canvas.click({ position: { x: 700, y: 250 } })

    // Browse libraries opens Walnut's catalog; Add puts the items in the library, kept on the server.
    await workspace(page).locator('.default-sidebar-trigger').click()
    await shot(page, 'round2-library-panel-empty')
    await workspace(page).locator('.library-menu-browse-button').click()
    const browser = page.getByRole('dialog', { name: 'Browse libraries' })
    await expect(browser).toBeVisible()
    await shot(page, 'round2-library-browser-all')
    await browser.getByRole('searchbox', { name: 'Search libraries' }).fill('database')
    await expect(browser.locator('.drawing-library-item')).toHaveCount(1)
    await shot(page, 'round2-library-browser')
    await browser.getByRole('button', { name: 'Add System boxes' }).click()
    await expect(browser.getByRole('button', { name: 'Add System boxes' })).toHaveText('Added')
    // Escape closes the dialog only: the Library panel behind it stays open with the new items.
    await page.keyboard.press('Escape')
    await expect(browser).toHaveCount(0)
    await expect(workspace(page).locator('.default-sidebar')).toBeVisible()
    await expect(workspace(page).locator('.library-unit')).toHaveCount(2, { timeout: 30_000 })
    await expect.poll(libraryIds, { timeout: 30_000 }).toEqual(['lib-db', 'lib-server'])
    await shot(page, 'round2-library-panel')

    // A selected shape goes into the library from the panel's own "add" tile. Selecting on the
    // canvas closes the (undocked) panel, so it is opened again with the shape selected.
    await page.mouse.move(box.x + 280, box.y + 330)
    await page.mouse.down()
    await page.mouse.move(box.x + 440, box.y + 460, { steps: 8 })
    await page.mouse.up()
    if (!(await workspace(page).locator('.default-sidebar').count())) await workspace(page).locator('.default-sidebar-trigger').click()
    const adder = workspace(page).locator('.library-unit__adder')
    await expect(adder).toHaveCount(1)
    await shot(page, 'round2-library-add-selected')
    // The tile pulses while it waits (the editor's own animation), so it never holds still.
    await adder.click({ force: true })
    await expect.poll(async () => (await libraryIds()).length, { timeout: 30_000 }).toBe(3)
    await page.waitForTimeout(600)

    // Reopened, the library is still there.
    await page.reload()
    await expect(workspace(page)).toBeVisible({ timeout: 60_000 })
    if (!(await workspace(page).locator('.default-sidebar').count())) await workspace(page).locator('.default-sidebar-trigger').click()
    await expect(workspace(page).locator('.library-unit')).toHaveCount(3, { timeout: 30_000 })
    await shot(page, 'round2-library-after-reload')
    expect(errors).toEqual([])
  })

  /**
   * 2026-11-16, the user: "for each diagram use one task session, and even for make diagram route
   * to there, so it is more visualized". In the App page Make a diagram and Text to diagram are
   * messages into the drawing's own assistant session (named "Drawing: <title>"), never the
   * editor's one-call diagram; the one-call path stays for the composer's sketch
   * (drawing-composer.spec.ts).
   */
  test('Make a diagram and Text to diagram in the App go to the drawing\'s own session, named after it', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let oneCall = 0
    await page.route('**/api/drawings/diagram', async (route) => { oneCall += 1; await route.abort() })

    // The sketch: made on the server, then opened from the Drawings list.
    const made = await page.request.post('/api/drawings', { data: { title: 'Order review sketch' } })
    expect(made.ok(), await made.text()).toBe(true)
    const doc = await made.json() as { path: string; revision: string }
    const seeded = await page.request.post('/api/drawings/append', { data: { path: doc.path, revision: doc.revision, elements: [
      { type: 'text', x: 0, y: 0, text: 'Order -> review' },
      { type: 'rectangle', x: 0, y: 60, width: 140, height: 70, text: 'Order' },
      { type: 'rectangle', x: 220, y: 60, width: 140, height: 70, text: 'Review' },
    ] } })
    expect(seeded.ok(), await seeded.text()).toBe(true)

    await openDrawingApp(page)
    await workspace(page).locator('.drawing-workspace-file').filter({ hasText: 'Order review sketch' }).click()
    await expect(workspace(page)).toHaveAttribute('data-drawing-path', doc.path, { timeout: 60_000 })
    await expect(workspace(page)).toHaveAttribute('data-save-state', 'saved', { timeout: 30_000 })
    const live = (await documentOnScreen(page)).scene.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted) as unknown as Array<{ id: string; x: number; width?: number }>
    const canvas = workspace(page).locator('canvas.excalidraw__canvas.interactive')
    await canvas.click({ position: { x: LEFT + 200, y: 860 - 120 } })
    await page.keyboard.press('Escape')
    // Zoom to fit (Shift+1, and Shift+3 for the selection) puts the drawing in the middle of the free
    // canvas. The editor's own keys measured its panels as if it sat at the page's top left, which
    // pushed everything into the canvas's right edge.
    const zoomHost = workspace(page).locator('.drawing-canvas-host')
    const canvasWidth = (await canvas.boundingBox())!.width
    const middle = (Math.min(...live.map((e) => e.x)) + Math.max(...live.map((e) => e.x + (e.width ?? 0)))) / 2
    const middleOnScreen = async () => (middle + Number(await zoomHost.getAttribute('data-scroll-x'))) * Number(await zoomHost.getAttribute('data-zoom')) / canvasWidth
    for (const key of ['Shift+1', 'Shift+3']) {
      if (key === 'Shift+3') await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.press(key)
      await expect.poll(middleOnScreen, { timeout: 5_000 }).toBeGreaterThan(0.25)
      expect(await middleOnScreen()).toBeLessThan(0.75)
    }
    await page.keyboard.press('ControlOrMeta+a')
    await page.waitForTimeout(400)

    // No conversation yet: the click opens the assistant and launches the drawing's task with the ask.
    const launch = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
    await workspace(page).getByRole('button', { name: 'Make a diagram' }).click()
    const body = (await launch).postDataJSON() as { message?: string; taskMeta?: { pinTier?: unknown } }
    expect(body.message).toMatch(/^Make a diagram from the shapes I selected \(element ids: /)
    for (const el of live) expect(body.message).toContain(el.id)
    expect(body.taskMeta?.pinTier).toBeNull()
    const panel = workspace(page).getByRole('complementary', { name: 'Drawing assistant' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Make a diagram from the shapes I selected', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, 'diagram-in-session')

    // Its task is the drawing's, by name, and opens from the panel.
    const openTask = panel.getByRole('button', { name: 'Open task' })
    await expect(openTask).toBeVisible({ timeout: 60_000 })
    const tasks = async () => ((await (await page.request.get('/api/tasks')).json()) as { tasks: Array<{ title: string }> }).tasks
    await expect.poll(async () => (await tasks()).filter((t) => t.title === 'Drawing: Order review sketch').length, { timeout: 30_000 }).toBe(1)

    // Text to diagram goes into the same conversation (no second task).
    await workspace(page).getByTestId('main-menu-trigger').click()
    await workspace(page).locator('.dropdown-menu').getByText('Text to diagram', { exact: true }).click()
    await workspace(page).getByRole('textbox', { name: 'Describe the diagram' }).fill('order service calls payment, then shipping')
    await workspace(page).getByRole('button', { name: 'Make diagram', exact: true }).click()
    await expect(workspace(page).getByRole('form', { name: 'Text to diagram' })).toHaveCount(0)
    await expect(panel.getByText('order service calls payment, then shipping', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    expect((await tasks()).filter((t) => t.title.startsWith('Drawing: Order review sketch')).length).toBe(1)
    expect(oneCall).toBe(0)
    await shot(page, 'text-diagram-in-session')
    expect(errors).toEqual([])
  })

  /**
   * The editor's Mermaid dialog is left out of the build (web/bundle-trim.ts), so its entry in the
   * extra-tools menu must not show: a click would open a dialog that can only fail. 2026-11-16: the
   * CSS rule that hides it lost the cascade to the editor's own item rule and the row stayed.
   */
  test('the extra-tools menu offers no Mermaid dialog and no Generate group', async ({ page }) => {
    await openDrawingApp(page)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    await expect(workspace(page).locator('canvas.excalidraw__canvas.interactive')).toBeVisible({ timeout: 60_000 })
    await workspace(page).locator('.App-toolbar__extra-tools-trigger').click()
    const menu = workspace(page).locator('.App-toolbar__extra-tools-dropdown')
    await expect(menu.getByTestId('toolbar-laser')).toBeVisible()
    await expect(menu.getByText('Mermaid to Excalidraw')).toBeHidden()
    await expect(menu.getByText('Generate', { exact: true })).toBeHidden()
    await shot(page, 'extra-tools-menu')
    await page.keyboard.press('Escape')
  })

  /**
   * 2026-11-16, the user: "can we add the ai assistant on the side panel, that we can talk to the
   * assistant to make changes". The App's Assistant button opens a chat beside the canvas; its first
   * question asks Walnut's own agent about THIS drawing (its path in the context), off the board.
   */
  test('the assistant opens beside the canvas and asks Walnut about this drawing, off the board', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openDrawingApp(page)
    await workspace(page).getByRole('button', { name: 'New drawing', exact: true }).first().click()
    await addText(page, 'Assistant check', 180, 230)
    const drawingPath = await workspace(page).getAttribute('data-drawing-path')
    expect(drawingPath).toBeTruthy()
    const toggle = workspace(page).getByRole('button', { name: 'Assistant', exact: true })
    // Shown or not is a kept view choice (an earlier test may have left it open): start from closed.
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    const panel = workspace(page).getByRole('complementary', { name: 'Drawing assistant' })
    await expect(panel).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // Beside the canvas, not over it: the canvas keeps its width minus the panel's.
    const [canvasBox, panelBox] = await Promise.all([workspace(page).locator('.drawing-workspace-canvas').boundingBox(), panel.boundingBox()])
    expect(panelBox!.x).toBeGreaterThanOrEqual(canvasBox!.x + canvasBox!.width - 1)
    expect(panelBox!.width).toBeGreaterThanOrEqual(300)
    const composer = panel.locator('textarea').first()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect(composer).toHaveAttribute('placeholder', /Ask for a change/)
    // Its own starter text, not Walnut's general asks ("Schedule my day" means nothing here).
    await expect(panel.getByText('Tell Walnut what to change in this drawing.', { exact: false })).toBeVisible()
    await expect(panel.getByText('Schedule my day')).toHaveCount(0)
    await shot(page, 'assistant-open')

    const context = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/hints/context')
    const launch = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
    await composer.fill('Make the label bigger')
    await composer.press('Enter')
    const body = (await launch).postDataJSON() as { agentId?: string; walnutAgent?: boolean; taskMeta?: { pinTier?: unknown }; hints?: unknown; message?: string }
    // Walnut's own agent: the general one (a launch names only another agent).
    expect(body.walnutAgent).toBe(true)
    expect(body.agentId ?? 'general').toBe('general')
    expect(body.taskMeta?.pinTier).toBeNull()
    expect(JSON.stringify(body)).toContain('Make the label bigger')
    // The drawing goes with the first question: its path and the tools that edit it, as an object context.
    const sent = (await context).postDataJSON() as { name?: string; text?: string }
    expect(sent.name).toBe('Drawing you are changing')
    expect(sent.text).toContain(`Drawing path: ${drawingPath}`)
    expect(sent.text).toContain('walnut_drawing_update')
    await expect(panel.getByText('Make the label bigger').first()).toBeVisible({ timeout: 30_000 })
    await shot(page, 'assistant-asked')

    // Closed and opened again: the same conversation comes back.
    await panel.getByRole('button', { name: 'Close assistant' }).click()
    await expect(panel).toBeHidden()
    await toggle.click()
    await expect(workspace(page).getByRole('complementary', { name: 'Drawing assistant' }).getByText('Make the label bigger').first()).toBeVisible({ timeout: 30_000 })

    // Renamed: the same drawing at a new path keeps its conversation.
    await workspace(page).getByRole('button', { name: /^Rename drawing:/ }).click()
    const name = workspace(page).getByRole('textbox', { name: 'Drawing name' })
    await name.fill('Assistant renamed')
    await name.press('Enter')
    await expect.poll(() => workspace(page).getAttribute('data-drawing-path'), { timeout: 30_000 }).not.toBe(drawingPath)
    await expect(workspace(page).getByRole('complementary', { name: 'Drawing assistant' }).getByText('Make the label bigger').first()).toBeVisible({ timeout: 30_000 })

    // Escape in the chat hands the keys back to the drawing: R then picks the rectangle.
    await workspace(page).getByRole('complementary', { name: 'Drawing assistant' }).locator('textarea').first().click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('r')
    await expect(workspace(page).locator('input[data-testid="toolbar-rectangle"]')).toBeChecked()
    expect(errors).toEqual([])
  })
})
