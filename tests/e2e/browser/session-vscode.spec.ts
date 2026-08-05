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
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Session idle', { exact: true }).click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}


test.beforeEach(async ({ page }) => {
  await installVscodeIntercept(page)
})

// Open in VS Code lives ONLY in the ⋮ kebab (2026-07-27): the header icon was a
// duplicate of this menu item and it was stealing width from the session title.
test('Open in VS Code is available from the session kebab, not the header', async ({ page }) => {
  const requestCount = await installEndpointStub(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const panel = await openHomepageSession(page)
  await expect(panel.locator('.session-panel-vscode')).toHaveCount(0)

  await panel.getByRole('button', { name: 'More actions' }).click()
  const menuItem = page.locator('.task-kebab-menu:visible').getByText('Open in VS Code', { exact: true })
  await expect(menuItem).toBeVisible()
  await menuItem.click()
  await expectCapturedUri(page)
  expect(requestCount()).toBe(1)
})

