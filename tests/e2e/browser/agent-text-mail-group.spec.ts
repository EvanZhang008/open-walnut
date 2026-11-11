// The grouped inbox's model-written summary must open the path it names without toggling its group line.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { ALL_INBOXES, deliver, getGroups, groupLine, startGroupsFixture, waitLabeled } from './mail-grouping-helpers'
import { PANE, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'
import { click, closeFile, dragSelect, expectImage, expectViewerFillsPanel, openApp, seedAgentFiles, showPointer, tabTo, type AgentFiles } from './agent-text-entry-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: { mode: 'on', size: { width: 1280, height: 900 } } })

let server: MailFixtureServer
let fixture: MailFixture
let files: AgentFiles
let dir = ''
let groupId = ''

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  ;({ server, fixture } = await startGroupsFixture())
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mail-group-'))
  files = await seedAgentFiles('design', dir)
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
  const warm = await browser.newPage()
  try {
    await openApp(warm, `http://127.0.0.1:${fixture.port}/`, warm.locator('.sidebar'))
    await click(warm, warm.getByTestId('sidebar-core-app-mail'))
    await expect(warm.locator(PANE)).toBeVisible({ timeout: 90_000 })
  } finally { await warm.close() }
  // The newest mail of a group names the file; the summary takes its subject's first four words.
  await deliver(fixture, 1, { subject: `Design review of ${files.picture}` })
  await expect.poll(async () => {
    const groups = (await getGroups(fixture, ALL_INBOXES)).groups as Array<{ id: string; summary?: string }>
    groupId = groups.find((g) => (g.summary ?? '').includes(files.picture))?.id ?? ''
    return groupId
  }, { timeout: 120_000, message: 'a group summary that names the delivered path' }).not.toBe('')
})

test.afterAll(async () => {
  await server?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

test('a path in a group summary opens the file; the group line stays as it was', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await showPointer(page)
  await openApp(page, `http://127.0.0.1:${fixture.port}/`, page.locator('.sidebar'))
  await click(page, page.getByTestId('sidebar-core-app-mail'))
  await expect(page.locator(PANE)).toBeVisible({ timeout: 90_000 })
  await click(page, smartRow(page, 'inbox'))
  await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 60_000 })
  const line = groupLine(page, groupId)
  await expect(line).toBeVisible({ timeout: 60_000 })
  const summary = line.getByTestId('mail-group-summary')
  const words = summary.locator('[data-agent-text]')
  const link = words.locator(`a.file-link[data-file-path="${files.picture}"]`)
  await expect(link).toBeVisible()
  const expanded = await line.getAttribute('aria-expanded')
  const openGroups = await page.locator('[data-testid="mail-group"] [data-testid="mail-row"]').count()
  const untouched = async () => {
    await page.waitForTimeout(400)
    await expect(line).toHaveAttribute('aria-expanded', expanded ?? 'false')
    await expect(page.locator('[data-testid="mail-group"] [data-testid="mail-row"]')).toHaveCount(openGroups)
  }
  // One line, as before: only the CSS cuts it.
  expect((await summary.boundingBox())!.height).toBeLessThan(24)
  const failure = page.getByTestId('file-viewer-source-error')
  const remembered = page.getByTestId('file-viewer-remembered')
  // The first press reads nothing and asks which machine; the answer is the person's own.
  await click(page, link)
  await expect(failure).toContainText('No file was read')
  await expect(failure).toHaveAttribute('role', 'status')
  await click(page, page.getByTestId('file-source-local'))
  await expectImage(page)
  await expect(remembered).toHaveCount(0)
  await closeFile(page)
  await untouched()
  // The same path in the same tab opens on that machine at once, says whose choice it was, and
  // never asks again on every press: by pointer, by keyboard and after a resize.
  await click(page, link)
  await expectImage(page)
  await expect(remembered).toContainText('the machine you chose for this path before')
  await expectViewerFillsPanel(page)
  await expect(failure).toHaveCount(0)
  await closeFile(page)
  await untouched()
  await tabTo(page, smartRow(page, 'inbox'), link)
  await page.keyboard.press('Enter')
  await expectImage(page)
  await expect(remembered).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await untouched()
  await page.setViewportSize({ width: 1120, height: 720 })
  await click(page, link)
  await expectImage(page)
  await expect(remembered).toBeVisible()
  // One press undoes it: the question comes back and the choice is the person's to make again.
  await click(page, page.getByTestId('file-viewer-choose-another'))
  await expect(remembered).toHaveCount(0)
  await expect(failure).toContainText('No file was read')
  await click(page, page.getByTestId('file-source-local'))
  await expectImage(page)
  await closeFile(page)
  await untouched()
  // Selecting the summary must not toggle its group.
  expect((await dragSelect(page, words, 40)).length).toBeGreaterThan(0)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await untouched()
  const title = line.getByTestId('mail-group-name')
  await click(page, title)
  const toggled = expanded === 'true' ? 'false' : 'true'
  await expect(line).toHaveAttribute('aria-expanded', toggled)
  await click(page, title)
  await untouched()
  const from = await words.evaluate((el) => {
    const text = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!
    const range = el.ownerDocument.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 3)
    const r = range.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const to = (await title.boundingBox())!
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 20, from.y, { steps: 5 })
  await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  expect((await words.evaluate((el) => el.ownerDocument.getSelection()?.toString() ?? '')).length).toBeGreaterThan(0)
  await untouched()
  expect(errors, 'no page error').toEqual([])
})
