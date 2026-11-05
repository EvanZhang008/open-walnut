/**
 * An HTML file previewed in the Files panel runs in an origin of its own (src/web/untrusted-doc.ts):
 * it renders and runs its scripts, but a script in it cannot read Walnut's storage, where the
 * Passwords unlock and the device token live. Before, the frame had `allow-same-origin` and no CSP,
 * so an agent-written report could read `localStorage['walnut.vault.session']` of the console.
 */
import { test, expect, type Page, type Locator, type Frame } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/file-html-preview-isolation'

async function openExplorer(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

async function openReportFile(page: Page, explorer: Locator, name: string): Promise<void> {
  const folderRow = explorer.locator('.session-file-explorer-node', { has: page.locator('.sfe-name', { hasText: /^report$/ }) })
  await expect(folderRow.locator('.sfe-arrow')).toHaveText(/[▶▼]/, { timeout: 10_000 })
  if (/^\u25B6\uFE0E?$/.test((await folderRow.locator('.sfe-arrow').textContent())?.trim() ?? '')) await folderRow.click()
  const row = explorer.locator('.sfe-name', { hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
}

function previewFrame(page: Page, file: string): Frame {
  const f = page.frames().find((fr) => fr.url().includes('/file-raw/') && fr.url().endsWith(file))
  if (!f) throw new Error(`no preview frame for ${file}`)
  return f
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
    } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // What a Passwords window keeps here (fake), put in once the page settled.
  await page.evaluate(() => localStorage.setItem('walnut.vault.session', 'fake-unlock-token-for-the-test'))
})

test('the preview renders and runs its scripts, sent with the CSP sandbox', async ({ page }) => {
  const explorer = await openExplorer(page)
  const doc = page.waitForResponse((r) => r.url().includes('/file-raw/') && r.url().endsWith('styled.html'))
  await openReportFile(page, explorer, 'summary.html')
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  await openReportFile(page, explorer, 'styled.html')
  const res = await doc
  expect(res.headers()['content-security-policy']).toContain('sandbox allow-scripts')
  expect(res.headers()['content-security-policy']).not.toContain('allow-same-origin')
  const inner = page.frameLocator('iframe.fv-html-preview')
  await expect(inner.locator('h1')).toHaveText('Styled report', { timeout: 10_000 })
  // Its stylesheets apply and its classic script ran. A module script and fetch() are CORS
  // requests from its opaque origin, refused like any other site's (a known limit).
  await expect(inner.locator('h1')).toHaveCSS('color', 'rgb(200, 30, 90)')
  await expect(inner.locator('html')).toHaveAttribute('data-classic', 'ran')
  await page.waitForTimeout(500)
  await expect(inner.locator('html')).not.toHaveAttribute('data-module', 'ran')
  const reads = await previewFrame(page, 'styled.html').evaluate(async () => {
    const read = async (u: string) => { try { const r = await fetch(u); return r.ok ? (await r.text()).slice(0, 40) : `status:${r.status}` } catch (e) { return `blocked:${(e as Error).name}` } }
    return { own: await read('assets/report.css'), parent: await read('../contract.pdf'), api: await read('/api/tasks') }
  })
  expect(reads.own).toMatch(/^blocked:/)
  expect(reads.parent).toMatch(/^blocked:/)
  expect(reads.api).toMatch(/^blocked:/)
  await expect(page.locator('iframe.fv-html-preview')).not.toHaveAttribute('sandbox', /allow-same-origin/)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-styled.png` })
})

test('a script in the preview cannot read the console\'s storage or cookies', async ({ page }) => {
  const explorer = await openExplorer(page)
  await openReportFile(page, explorer, 'summary.html')
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  const frame = previewFrame(page, 'summary.html')
  const seen = await frame.evaluate(() => {
    const tryRead = (f: () => unknown) => { try { return String(f()) } catch (e) { return `blocked:${(e as Error).name}` } }
    return {
      parentStorage: tryRead(() => window.parent.localStorage.getItem('walnut.vault.session')),
      parentDocument: tryRead(() => window.parent.document.title),
      ownStorage: tryRead(() => localStorage.getItem('walnut.vault.session')),
      cookie: tryRead(() => document.cookie),
      origin: self.origin,
    }
  })
  expect(seen.parentStorage).toMatch(/^blocked:/)
  expect(seen.parentDocument).toMatch(/^blocked:/)
  expect(seen.ownStorage).toMatch(/^blocked:/)
  expect(seen.cookie).not.toContain('walnut')
  expect(seen.origin).toBe('null')
  // The console itself still has its unlock.
  expect(await page.evaluate(() => localStorage.getItem('walnut.vault.session'))).toBe('fake-unlock-token-for-the-test')
})

test('⌘F finds inside the preview\'s page, painted there', async ({ page }) => {
  const explorer = await openExplorer(page)
  await openReportFile(page, explorer, 'summary.html')
  const inner = page.frameLocator('iframe.fv-html-preview')
  await expect(inner.locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  // Pressed while the page has focus: the page hands it to the console's bar.
  await inner.locator('h1').click()
  await page.keyboard.press('ControlOrMeta+f')
  const bar = explorer.locator('.fv-search-bar')
  await expect(bar).toBeVisible()
  await bar.locator('input').first().fill('filler line 7')
  // filler line 7, 70..79
  await expect(bar.locator('.fv-search-count')).toHaveText('1/11', { timeout: 5_000 })
  const painted = () => inner.locator('body').evaluate(() => {
    const h = (window as unknown as { CSS: { highlights?: Map<string, Iterable<Range>> } }).CSS.highlights
    const all = h?.get('walnut-search'); const active = h?.get('walnut-search-active')
    return { all: all ? [...all].length : 0, active: active ? [...active].map((r) => r.toString()) : [] }
  })
  await expect.poll(painted).toEqual({ all: 11, active: ['filler line 7'] })
  await bar.locator('input').first().press('Enter')
  await expect(bar.locator('.fv-search-count')).toHaveText('2/11')
  await expect.poll(async () => (await painted()).active).toEqual(['filler line 7'])
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-find.png` })
  await bar.getByRole('button', { name: 'Close search' }).click()
  await expect.poll(painted).toEqual({ all: 0, active: [] })
})
