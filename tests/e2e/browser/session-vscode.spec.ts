import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const EXPECTED_URI = 'vscode://file/test/editor-fixture'

async function installVscodeIntercept(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as Window & {
      __openVscodeUriForTest?: (uri: string) => void
      __capturedVscodeUri?: string
    }
    state.__openVscodeUriForTest = (uri) => { state.__capturedVscodeUri = uri }
  })
}

async function installEndpointStub(page: Page): Promise<() => number> {
  let requests = 0
  await page.route(`**/api/sessions/${SESSION_ID}/vscode-uri`, async (route) => {
    requests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ uri: EXPECTED_URI }),
    })
  })
  return () => requests
}

async function expectCapturedUri(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __capturedVscodeUri?: string }
  ).__capturedVscodeUri)).toBe(EXPECTED_URI)
}

async function openHomepageSession(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}


test.beforeEach(async ({ page }) => {
  await installVscodeIntercept(page)
})

async function openHome(page: Page): Promise<void> {
  const preferences = page.waitForResponse((response) => response.url().endsWith('/api/ui-prefs'))
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await preferences
  await expect(page.locator('.main-page')).toBeVisible()
  await page.getByRole('tab', { name: 'All', exact: true }).click()
}

test('Code and Inbox are menu actions, never persistent header chips', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page)
  const panel = await openHomepageSession(page)
  const chips = panel.locator('.session-action-chip')
  await expect(chips.filter({ hasText: /^(Code|Inbox)/ })).toHaveCount(0)
  for (const name of ['Changed', 'Files', 'Terminal']) {
    await expect(chips.filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible()
  }
  await panel.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu.getByRole('button', { name: 'Code', exact: true })).toBeVisible()
  await expect(menu.locator('.task-kebab-item').filter({ hasText: /^Inbox/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Open in VS Code', exact: true })).toBeVisible()
  await fs.mkdir('/tmp/session-tools-menu', { recursive: true })
  await page.screenshot({ animations: 'disabled', scale: 'css', path: `/tmp/session-tools-menu/${testInfo.project.name}-menu.png` })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', scale: 'css', path: `/tmp/session-tools-menu/${testInfo.project.name}-header.png` })
})
for (const width of [1280, 820]) {
  test(`menu views toggle and switch without losing the editor or draft at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: 800 })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const ensureRequests: string[] = []
    await page.route(`**/api/sessions/${SESSION_ID}/vscode-embed*`, async (route) => {
      ensureRequests.push(route.request().url())
      await route.fulfill({ json: {
        url: `${testInfo.project.use.baseURL}/pw-embedded-editor`, token: 'fixture',
        open: { path: '/test/editor-fixture', kind: 'folder' },
      } })
    })
    await page.route('**/pw-embedded-editor', (route) => route.fulfill({
      contentType: 'text/html', body: '<label>Editor draft<textarea aria-label="Editor draft"></textarea></label>',
    }))
    await openHome(page)
    const panel = await openHomepageSession(page)
    const draft = panel.getByPlaceholder('Send a message to this session...')
    await draft.fill('Keep this unsent message')
    const menu = page.locator('.task-kebab-menu:visible')
    const openMenu = async () => {
      await panel.getByRole('button', { name: 'More actions' }).click()
      await expect(menu).toBeVisible()
      const box = (await menu.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(box.y + box.height).toBeLessThanOrEqual(800)
    }
    await openMenu()
    const code = menu.getByRole('button', { name: 'Code', exact: true })
    const inbox = menu.locator('.task-kebab-item').filter({ hasText: /^Inbox/ })
    await expect(code).toHaveAttribute('aria-pressed', 'false')
    await code.click()
    await expect(menu).toHaveCount(0)
    await expect(panel.locator('.session-code-panel')).toBeVisible()
    const editor = panel.frameLocator('.session-code-iframe').getByRole('textbox', { name: 'Editor draft' })
    await editor.fill('Editor buffer survives view switches')
    await expect(draft).toHaveValue('Keep this unsent message')

    for (let round = 0; round < 2; round++) {
      await openMenu()
      await expect(code).toHaveAttribute('aria-pressed', 'true')
      await inbox.click()
      await expect(menu).toHaveCount(0)
      await expect(panel.locator('.session-inbox-pane')).toBeVisible()
      await expect(panel.locator('.session-code-panel')).toBeHidden()
      if (width < 900) await expect(panel.locator('.session-panel-chat-col')).toBeHidden()
      await openMenu()
      await expect(inbox).toHaveAttribute('aria-pressed', 'true')
      await expect(code).toHaveAttribute('aria-pressed', 'false')
      await code.click()
      await expect(editor).toHaveValue('Editor buffer survives view switches')
      await expect(draft).toBeVisible()
      await expect(draft).toHaveValue('Keep this unsent message')
    }
    await fs.mkdir('/tmp/session-tools-menu', { recursive: true })
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `/tmp/session-tools-menu/${testInfo.project.name}-code-${width}.png` })
    await openMenu()
    await code.click()
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(panel.locator('.session-code-panel')).toBeHidden()
    await openMenu()
    await inbox.click()
    await expect(panel.locator('.session-inbox-pane')).toBeVisible()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `/tmp/session-tools-menu/${testInfo.project.name}-inbox-${width}.png` })
    await openMenu()
    await inbox.click()
    await expect(panel.locator('.session-inbox-pane')).toHaveCount(0)
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(draft).toHaveValue('Keep this unsent message')
    await expect(panel.locator('.session-action-chip').filter({ hasText: /^(Code|Inbox)/ })).toHaveCount(0)
    expect(ensureRequests).toHaveLength(1)
    expect(pageErrors).toEqual([])
  })
}

test('Code prefetch is cancelled with the menu and a failed open can retry', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  let requests = 0
  let fail = true
  await page.route(`**/api/sessions/${SESSION_ID}/vscode-embed*`, async (route) => {
    requests++
    if (fail) {
      await route.fulfill({ status: 502, json: { error: 'Editor unavailable' } })
    } else {
      await route.fulfill({ json: {
        url: `${testInfo.project.use.baseURL}/pw-embedded-editor`, token: 'retry-fixture',
        open: { path: '/test/editor-fixture', kind: 'folder' },
      } })
    }
  })
  await page.route('**/pw-embedded-editor', (route) => route.fulfill({
    contentType: 'text/html', body: '<p>Recovered editor</p>',
  }))
  await openHome(page)
  const panel = await openHomepageSession(page)
  await panel.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await menu.getByRole('button', { name: 'Code', exact: true }).hover()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.waitForTimeout(600)
  expect(requests).toBe(0)
  await panel.getByRole('button', { name: 'More actions' }).click()
  await menu.getByRole('button', { name: 'Code', exact: true }).click()
  const codePanel = panel.locator('.session-code-panel')
  await expect(codePanel.locator('.session-code-error-body')).toHaveText('Editor unavailable')
  fail = false
  await codePanel.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(panel.frameLocator('.session-code-iframe').locator('body')).toHaveText('Recovered editor')
  expect(requests).toBe(2)
})

test('Open in VS Code is available from the session kebab, not the header', async ({ page }) => {
  const requestCount = await installEndpointStub(page)
  await openHome(page)

  const panel = await openHomepageSession(page)
  await expect(panel.locator('.session-panel-vscode')).toHaveCount(0)

  await panel.getByRole('button', { name: 'More actions' }).click()
  const menuItem = page.locator('.task-kebab-menu:visible').getByText('Open in VS Code', { exact: true })
  await expect(menuItem).toBeVisible()
  await menuItem.click()
  await expectCapturedUri(page)
  expect(requestCount()).toBe(1)
})

