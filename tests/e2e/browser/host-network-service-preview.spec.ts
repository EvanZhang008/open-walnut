/** The unchanged preview UI still accepts links, typed addresses, retries and repeated opens. */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { openKebabGroup } from './kebab-group-helpers'

const shots = '/tmp/walnut-network-preview'
test('preview flow keeps working after the transport gains network port streams', async ({ page, baseURL }) => {
  fs.mkdirSync(shots, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  // Bootstrap by clicking a link, then every move stays within Walnut's real UI.
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill('pw-service-session')
  await page.locator('.todo-panel-item[data-task-id="pw-task-service"] .todo-item-title').click()
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-service-session"]')
  await expect(panel).toBeVisible()
  const report = panel.locator('.session-panel-chat-col a[href*="/report"]')
  const url = new URL((await report.getAttribute('href'))!)
  await report.click()
  const view = panel.locator('.session-web-panel')
  const address = view.locator('.session-web-address')
  const frame = panel.frameLocator('.session-web-iframe')
  await expect(frame.getByText('SERVICE_REPORT_MARKER')).toBeVisible()
  for (let i = 0; i < 2; i++) {
    await address.fill(`localhost:${url.port}/docs`)
    await address.press('Enter')
    await expect(frame.getByText('SERVICE_DOCS_MARKER')).toBeVisible()
    await report.click()
    await expect(frame.getByText('SERVICE_REPORT_MARKER')).toBeVisible()
  }
  await address.fill('invalid service address')
  await address.press('Enter')
  await expect(address).toHaveClass(/session-web-address-invalid/)
  await expect(frame.getByText('SERVICE_REPORT_MARKER')).toBeVisible()
  await report.click()
  await panel.getByRole('button', { name: 'More actions' }).click()
  const group = await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-open')
  await group.locator('.task-kebab-item').filter({ hasText: 'Web preview' }).click()
  await expect(view).toHaveCount(0)
  await panel.getByRole('button', { name: 'More actions' }).click()
  const reopened = await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-open')
  await reopened.locator('.task-kebab-item').filter({ hasText: 'Web preview' }).click()
  await expect(frame.getByText('SERVICE_REPORT_MARKER')).toBeVisible()
  await page.screenshot({ path: `${shots}/preview.png`, scale: 'css' })
})
