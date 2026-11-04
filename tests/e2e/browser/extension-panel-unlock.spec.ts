/**
 * The in-page "Unlock" (packages/browser-extension/src/menu.ts → bg-fill.ts openUnlock), from the
 * first review: clicked on a locked vault, nothing seemed to open. A page screenshot never shows the
 * extension's popup, so this checks what the browser itself has open: the popup when Chrome opens
 * it, and the small unlock window when Chrome refuses.
 */
import { expect, test, type Frame, type Page } from '@playwright/test'
import { startPanelLab, sw, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'unlock')
})
test.afterAll(async () => { await lab?.close() })

async function menuFrame(page: Page): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes('/menu.html')); return !!f }, { timeout: 15_000 }).toBe(true)
  await page.waitForTimeout(650) // its buttons act once it has been on screen a moment (frame-guard.ts)
  return f!
}

/** The menu on the login field, showing the vault locked (or not connected: either offers the unlock). */
async function lockedMenu(): Promise<{ page: Page; button: ReturnType<Frame['getByRole']> }> {
  const page = await lab.ctx.newPage()
  await page.goto(lab.site('login.example.test', '/login'))
  await page.waitForTimeout(300)
  const field = page.locator('#user')
  await field.focus()
  const box = (await field.boundingBox())!
  await page.mouse.click(box.x + box.width - 15, box.y + box.height / 2)
  const menu = await menuFrame(page)
  const button = menu.getByRole('button', { name: /^(Unlock|Connect)$/ })
  await expect(button).toBeVisible({ timeout: 15_000 })
  return { page, button }
}

const opened = () => sw(lab).evaluate(async () => ({
  popups: (await chrome.runtime.getContexts({ contextTypes: ['POPUP' as chrome.runtime.ContextType] })).map((c) => c.documentUrl ?? ''),
  // The extension's own pages in a tab or window (tabs.query names no address without the tabs permission).
  windows: (await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] })).map((c) => c.documentUrl ?? '').filter((u) => u.includes('popup.html')),
}))

test('Unlock in the page opens the extension popup', async () => {
  test.setTimeout(90_000)
  const { page, button } = await lockedMenu()
  await button.click()
  await expect.poll(async () => { const o = await opened(); return o.popups.length + o.windows.length }, { timeout: 10_000 }).toBeGreaterThan(0)
  await page.close()
})

test('when Chrome refuses the popup, Unlock opens the small unlock window', async () => {
  test.setTimeout(90_000)
  // Close any popup the first test left, then make the browser refuse the next one.
  const refused = await sw(lab).evaluate(async () => {
    for (const c of await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] })) if ((c.documentUrl ?? '').includes('popup.html') && c.windowId >= 0) await chrome.windows.remove(c.windowId)
    const refuse = () => Promise.reject(new Error('Could not find an active browser window.'))
    Object.defineProperty(chrome.action, 'openPopup', { value: refuse, configurable: true, writable: true })
    return chrome.action.openPopup === refuse
  })
  expect(refused).toBe(true)
  const { page, button } = await lockedMenu()
  await button.click()
  await expect.poll(async () => (await opened()).windows.some((u) => u.includes('popup.html?window=1')), { timeout: 10_000 }).toBe(true)
  await page.close()
})
