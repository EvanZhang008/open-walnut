import fs from 'node:fs/promises'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { loadApp } from './host-problems-fixture-helpers'
import { isolatePrefs } from './host-problems-helpers'
import { discoverBrowserFixture } from './codex-test-audit'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = '/tmp/mac-popout-full'

async function openPopout(page: Page, sessionId: string): Promise<{ child: Page; parent: Locator }> {
  await isolatePrefs(page)
  await loadApp(page)
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: id } })), sessionId)
  const parent = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`)
  await expect(parent).toBeVisible()
  const opened = page.context().waitForEvent('page')
  await parent.locator('.session-panel-popout').click()
  const child = await opened
  await expect(child.locator('.popout-session .session-panel-input textarea')).toBeVisible({ timeout: 30_000 })
  return { child, parent }
}

async function showInbox(child: Page): Promise<void> {
  await child.getByRole('button', { name: 'More actions', exact: true }).click()
  await child.locator('.task-kebab-menu:visible .task-kebab-item').filter({ hasText: 'Inbox' }).click()
  await expect(child.locator('.session-inbox-pane')).toBeVisible()
}

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test('a popped-out session sends through the real CLI and keeps Inbox beside the composer', async ({ page, request }) => {
  test.setTimeout(120_000)
  const { fixtureRoot } = await discoverBrowserFixture(PORT)
  const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' } })
  expect(started.ok(), await started.text()).toBe(true)
  const { sessionId } = await started.json()
  const letter = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': sessionId },
    data: { subject: 'Popout decision', type: 'action_required', markdown: 'Review the isolated update.', actions: [{ id: 'approve', label: 'Approve update' }] },
  })
  expect(letter.status(), await letter.text()).toBe(201)
  const { child, parent } = await openPopout(page, sessionId)
  const errors: string[] = []
  child.on('pageerror', error => errors.push(error.message))
  await child.setViewportSize({ width: 1200, height: 800 })
  await expect(child.locator('.sidebar')).toHaveCount(0)
  const input = child.locator('.session-panel-input textarea')
  await parent.locator('.session-panel-input textarea').fill('Keep the parent draft')
  await showInbox(child)
  await child.locator('.session-inbox-pane .hib-row').filter({ hasText: 'Popout decision' }).click()
  await expect(child.locator('.session-inbox-pane .hib-reader-subject')).toHaveText('Popout decision')
  if (!await input.isVisible()) await child.getByRole('button', { name: 'Show chat', exact: true }).click()
  const message = `Popout round trip ${Date.now()}`
  await input.fill(message)
  await child.locator('.session-panel-input .chat-send-btn-icon').click()
  await expect(input).toHaveValue('')
  await expect(child.locator('.session-history .session-msg-assistant').filter({ hasText: message }).first()).toBeVisible({ timeout: 60_000 })
  await expect(parent.locator('.session-panel-input textarea')).toHaveValue('Keep the parent draft')
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`draft:session:${id}`), sessionId)).toBe('Keep the parent draft')
  await page.reload()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"] textarea`)).toHaveValue('Keep the parent draft')
  await expect(child.locator('.session-inbox-pane .hib-reader-subject')).toHaveText('Popout decision')
  await child.screenshot({ path: `${SHOTS}/inbox-${test.info().project.name}.png` })
  await child.locator('.session-inbox-pane .hib-action-btn').filter({ hasText: 'Approve update' }).click()
  await expect(child.locator('.session-inbox-pane .hib-answered')).toContainText('Approve update')
  const saved = await request.get(`/api/v1/human-inbox/${(await letter.json()).id}`)
  expect(JSON.stringify(await saved.json())).toContain('approve')
  await child.getByRole('button', { name: 'Fork session into a child task' }).click()
  const fork = child.locator('.popout-session-fork')
  await expect(fork).toBeVisible()
  await fork.locator('textarea').fill('Continue in the isolated fork')
  await fork.locator('.chat-send-btn-icon').click()
  await expect(fork).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(() => new URL(child.url()).searchParams.get('id')).not.toBe(sessionId)
  await expect(child.locator('.session-panel-input textarea')).toBeVisible()
  await expect(child.locator('.session-history .session-msg-assistant').filter({ hasText: 'Continue in the isolated fork' }).first()).toBeVisible({ timeout: 60_000 })
  expect(errors).toEqual([])
  await child.close()
})

test('dense history, view tools, fork recovery and reopen retain a usable composer', async ({ page }) => {
  test.setTimeout(120_000)
  const { child } = await openPopout(page, 'pw-vscode-session')
  const errors: string[] = []
  child.on('pageerror', error => errors.push(error.message))
  await child.setViewportSize({ width: 1200, height: 800 })
  const panel = child.locator('.popout-session-interactive > .session-panel')
  const input = child.locator('.session-panel-input textarea')
  await input.fill('Keep this draft across views')
  for (const name of ['Changed', 'Files', 'Terminal']) {
    const button = panel.getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await button.click()
    await expect(panel).toHaveClass(/is-changed-open/)
    await panel.getByRole('button', { name: 'Collapse session', exact: true }).click()
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Keep this draft across views')
  }
  await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
  await panel.getByRole('button', { name: 'Fork session into a child task' }).click()
  const fork = child.locator('.popout-session-fork')
  await expect(fork).toBeVisible()
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  const originalBox = (await panel.boundingBox())!
  const forkBox = (await fork.boundingBox())!
  expect(forkBox.x).toBeGreaterThanOrEqual(originalBox.x + originalBox.width - 1)
  expect(forkBox.height).toBeGreaterThan(700)
  await fork.locator('.draft-model-select').click()
  await expect(child.locator('[title="A fork keeps the source session provider"]').first()).toBeDisabled()
  await child.keyboard.press('Escape')
  let attempts = 0
  await child.route('**/api/sessions/pw-vscode-session/fork', route => {
    attempts++
    return route.fulfill({ status: 503, json: { error: 'Temporary fork refusal' } })
  })
  const forkInput = fork.locator('textarea')
  await forkInput.fill('Retry this fork message')
  await fork.locator('.chat-send-btn-icon').click()
  await expect(forkInput).toHaveValue('Retry this fork message')
  await expect.poll(() => attempts).toBe(1)
  await fork.locator('.chat-send-btn-icon').click()
  await expect.poll(() => attempts).toBe(2)
  await forkInput.fill('')
  await fork.getByRole('button', { name: 'Discard draft session' }).click()
  await expect(fork).toHaveCount(0)
  await child.setViewportSize({ width: 560, height: 600 })
  await expect(input).toBeVisible()
  const box = (await input.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(600)
  await child.screenshot({ path: `${SHOTS}/narrow-${test.info().project.name}.png` })
  await child.getByRole('button', { name: 'Close session panel', exact: true }).click()
  await expect.poll(() => child.isClosed()).toBe(true)
  const opened = page.context().waitForEvent('page')
  await page.locator('.main-page-session-column .session-panel-popout').click()
  const reopened = await opened
  await expect(reopened.locator('.session-panel-input textarea')).toHaveValue('Keep this draft across views')
  expect(errors).toEqual([])
  await reopened.close()
})

test('a popped-out session remains interactive after its original tab closes', async ({ page }) => {
  const { child } = await openPopout(page, 'pw-close-a-session')
  await page.close()
  await child.setViewportSize({ width: 1200, height: 800 })
  const input = child.locator('.session-panel-input textarea')
  await input.fill('Independent child draft')
  const history = child.locator('.session-history')
  await expect.poll(() => history.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
  await history.hover()
  await child.mouse.wheel(0, -2000)
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeLessThan(await history.evaluate(el => el.scrollHeight - el.clientHeight - 100))
  const before = await history.evaluate(el => el.scrollTop)
  await child.mouse.wheel(0, 1000)
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeGreaterThan(before)
  await child.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
  await child.keyboard.press('Escape')
  await expect(input).toHaveValue('Independent child draft')
  await child.close()
})
