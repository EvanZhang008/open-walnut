import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { startPluginFixture, openPlugins, ensureSourceInstalled, expandSidebar, git, commitAll, type PluginFixture } from './plugin-update-fixture'

let fixture: PluginFixture
const evidence = '/tmp/walnut-plugin-hot-reload'
test.use({ viewport: { width: 1200, height: 850 } })
test.setTimeout(240_000)
test.beforeAll(async () => {
  await fs.mkdir(evidence, { recursive: true })
  fixture = process.env.PW_PLUGIN_RELEASE_PORT
    ? { port: Number(process.env.PW_PLUGIN_RELEASE_PORT), home: process.env.PW_PLUGIN_RELEASE_HOME!, stop: async () => {} }
    : await startPluginFixture()
})
test.afterAll(async () => { await fixture?.stop() })

test('reloads real plugin generations and recovers without a page reload', async ({ page }, info) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent(`<a href="http://127.0.0.1:${fixture.port}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await openPlugins(page)
  await ensureSourceInstalled(page, fixture.home)
  await expandSidebar(page)
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
  await page.getByTestId('plugin-demo-tab-lifecycle').click()
  await page.evaluate(() => { (window as any).__reloadPageIdentity = 'same-window' })
  const root = path.join(fixture.home, 'plugin-stores/native-plugin-repo/dist')
  const webFile = path.join(root, 'web.mjs')
  const serverFile = path.join(root, 'server.mjs')
  const originalWeb = await fs.readFile(webFile, 'utf8')
  const originalServer = await fs.readFile(serverFile, 'utf8')
  const endpoint = `/api/plugin-runtime/walnut-demo/reload`
  const reload = async () => {
    const response = page.waitForResponse(r => r.url().endsWith(endpoint) && r.request().method() === 'POST')
    await page.getByTestId('plugin-demo-action-reload').click()
    return response
  }
  try {
    for (let round = 1; round <= 3; round++) {
      await fs.writeFile(webFile, originalWeb.replace('Native plugin app', `Reload generation ${round}`))
      expect((await reload()).ok()).toBe(true)
      await expect(page.getByText(`Reload generation ${round}`, { exact: true })).toBeVisible()
      await expect(page.getByTestId('sidebar-app-walnut-demo:main')).toHaveCount(1)
      await expect(page.getByTestId('plugin-demo-action-reload')).toBeEnabled()
    }
    const stableWeb = await fs.readFile(webFile, 'utf8')
    await fs.writeFile(webFile, 'export function activate( {')
    expect((await reload()).ok()).toBe(false)
    await expect(page.getByTestId('plugin-demo-receipt-reload')).toHaveAttribute('data-ok', 'false')
    await expect(page.getByText('Reload generation 3', { exact: true })).toBeVisible()
    await fs.writeFile(webFile, stableWeb)
    await fs.writeFile(serverFile, 'export function activate() { throw new Error("candidate activation failed") }')
    const failed = await reload()
    expect(failed.ok()).toBe(false)
    expect(await failed.text()).toContain('previous version restored')
    await expect(page.getByText('Reload generation 3', { exact: true })).toBeVisible()
    const state = await page.request.get(`http://127.0.0.1:${fixture.port}/api/plugin-runtime`)
    expect(state.ok()).toBe(true)
    expect((await state.json()).plugins.find((p: any) => p.id === 'walnut-demo').state).toBe('active')
    await fs.writeFile(serverFile, originalServer)
    await fs.writeFile(webFile, 'export function activate() { throw new Error("web candidate activation failed") }')
    const webFailure = page.waitForEvent('console', message => message.text().includes('native Web Plugin activation failed'))
    expect((await reload()).ok()).toBe(true)
    await webFailure
    await expect(page.getByText('Reload generation 3', { exact: true })).toBeVisible()
    await fs.writeFile(webFile, stableWeb.replace('Reload generation 3', 'Reload generation 4'))
    expect((await reload()).ok()).toBe(true)
    await expect(page.getByText('Reload generation 4', { exact: true })).toBeVisible()
    await expect(page.getByTestId('plugin-demo-action-reload')).toBeEnabled()
    await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__reloadPageIdentity)).toBe('same-window')
    await page.screenshot({ path: path.join(evidence, `${info.project.name}-recovered-final.png`), scale: 'css' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
    expect(await page.getByTestId('plugin-demo-app').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 1200, height: 850 })
    await page.getByTestId('plugin-demo-tab-web').click()
    await expect(page.getByTestId('plugin-demo-section-web')).toBeVisible()

    await fs.writeFile(serverFile, originalServer)
    await fs.writeFile(webFile, originalWeb)
    await openPlugins(page)
    const publisher = path.join(fixture.home, 'native-plugin-repo')
    const publishedServer = path.join(publisher, 'dist/server.mjs')
    const goodServer = await fs.readFile(publishedServer, 'utf8')
    const updatePath = '/api/plugin-sources/native-plugin-repo/update'
    const update = async () => {
      const response = page.waitForResponse(r => r.url().endsWith(updatePath) && r.request().method() === 'POST')
      await page.getByTestId('plugin-update-walnut-demo').click()
      const result = await response
      expect(result.ok()).toBe(true)
      return result.json()
    }
    try {
      await fs.writeFile(publishedServer, 'export function activate() { throw new Error("source candidate failed") }')
      await commitAll(publisher, 'Publish a failing fixture update')
      await page.getByTestId('update-chip-walnut-demo').click()
      await expect(page.getByTestId('plugin-update-walnut-demo')).toBeVisible()
      expect((await update()).failed).toHaveLength(1)
      const feedback = page.getByTestId('plugin-update-feedback-walnut-demo')
      await expect(feedback).toHaveClass(/--error/)
      await expect(feedback).toContainText('new code is not running')
      await expect(page.getByTestId('plugin-row-walnut-demo')).toContainText('update not active')
      await page.getByTestId('sidebar-app-walnut-demo:main').click()
      await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
      await openPlugins(page)
      await expect(page.getByTestId('plugin-update-walnut-demo')).toBeVisible()
      const retried = await update()
      expect(retried.updated).toBe(false)
      expect(retried.failed).toHaveLength(1)
      await expect(feedback).toHaveClass(/--error/)
      await fs.writeFile(publishedServer, goodServer)
      await commitAll(publisher, 'Repair the fixture update')
      const repaired = await update()
      expect(repaired.reloaded).toEqual(['walnut-demo'])
      expect(repaired.failed).toEqual([])
      await expect(feedback).toHaveClass(/--ok/)
      await expect(feedback).toContainText('reloaded Walnut Plugin Demo')
      await expect(page.getByTestId('plugin-row-walnut-demo')).toHaveAttribute('data-plugin-status', 'active')
      const pluginRow = page.getByTestId('plugin-row-walnut-demo')
      await pluginRow.scrollIntoViewIfNeeded()
      await pluginRow.locator('..').screenshot({ path: path.join(evidence, `${info.project.name}-source-row-recovered.png`), scale: 'css' })
      await page.getByTestId('sidebar-app-walnut-demo:main').click()
      await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
    } finally {
      await fs.writeFile(publishedServer, goodServer)
      if ((await git(publisher, 'status', '--porcelain')).stdout.trim()) await commitAll(publisher, 'Restore the fixture source')
    }
    expect(pageErrors).toEqual([])
  } finally {
    await fs.writeFile(serverFile, originalServer)
    await fs.writeFile(webFile, originalWeb)
  }
})
