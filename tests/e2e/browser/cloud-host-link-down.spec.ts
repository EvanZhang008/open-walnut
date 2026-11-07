/**
 * A person writes to a session whose host Walnut cannot reach (2026-11-06: the Mac's sign-in
 * to a dev host expired, and his messages to tasks there read "Send failed: Not sent yet:
 * waiting for the connection to the session host", or a bare "Queued" after a reload, while
 * the panel said nothing about the host). Real clicks and typing, on the real-replica fixture
 * with the Mac-to-companion link cut on purpose (cloud-host-server.ts CLOUD_HOST_LINK_CONTROL=1,
 * drop-hold: every connection closed, new ones held silent):
 *
 *   1. send while the link is down: the panel says Cloud cannot be reached at once, the
 *      bubble says the message waits for Cloud with its next try (never "Send failed"), the
 *      task reads Waiting on its machine, and a reload keeps the bubble's words;
 *   2. the link comes back: the message is delivered by itself and its reply shows;
 *   3. a reply the session writes while the link is down shows once the link is back.
 *
 * One fixture, serial. PW_VIDEO=1 records one clip per scenario.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { draftComposer, draftCwdPill, draftPanel, draftSend, loadHome, openDraft, REAL_PANEL, seedColumns } from './draft-helpers'

const CLOUD = '__cloudbox__'
test.describe.configure({ mode: 'serial' })

interface Fixture { projects: string; linkControlPort: number; apiPort: number }
let sessionId: string | null = null
let taskId: string | null = null

async function fixture(): Promise<Fixture> {
  const port = new URL(String(test.info().project.use.baseURL)).port
  const file = path.join(os.tmpdir(), `walnut-cloudhost-pw-${port}.json`)
  for (let i = 0; i < 240 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Fixture
}
const setLink = async (fx: Fixture, m: 'pass' | 'drop-hold') =>
  (await fetch(`http://127.0.0.1:${fx.linkControlPort}/mode?m=${m}`)).json()

const column = (page: Page): Locator => page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
const composer = (page: Page): Locator => column(page).locator('textarea').first()

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.pressSequentially(text.slice(0, 12), { delay: 20 })
  await input.fill(text)
  await input.press('Enter')
}

/** The task's own status, as every surface reads it. */
async function userStatus(page: Page): Promise<{ state?: string; kind?: string; waitingOn?: string } | undefined> {
  const res = await page.request.get(`/api/v1/tasks/${taskId}`)
  const body = await res.json() as { task?: { user_status?: { state?: string; kind?: string; waitingOn?: string } }; user_status?: never }
  return body.task?.user_status ?? (body as { user_status?: { state?: string } }).user_status
}

test('1. sent while the link is down: it waits for Cloud, says when it tries again, and keeps saying so after a reload', async ({ page, browserName }) => {
  test.setTimeout(420_000)
  const fx = await fixture()
  await setLink(fx, 'pass')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // A session on Cloud, while the link is up.
  await loadHome(page)
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  const tab = picker.locator(`.sps-host-tab[data-host="${CLOUD}"]`)
  await expect(tab).toBeVisible({ timeout: 90_000 })
  await tab.click()
  const input = picker.locator('.sps-search-input')
  await input.fill(`${fx.projects}/alpha`)
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 120_000 })
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden({ timeout: 15_000 })
  await draftComposer(page).fill('snapshot-clean-turn:first reply while the link is up')
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
  await draftSend(draftPanel(page)).click()
  let res = await started
  if (res.status() === 409) {
    const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Start anyway' }).click()
    res = await again
  }
  expect(res.status(), await res.text()).toBe(200)
  const started2 = await res.json() as { sessionId: string; taskId?: string }
  sessionId = started2.sessionId
  taskId = started2.taskId ?? null
  await expect(column(page)).toBeVisible({ timeout: 60_000 })
  await expect(column(page).getByText('first reply while the link is up', { exact: true }).first()).toBeVisible({ timeout: 120_000 })
  await expect(column(page).getByText('Claude Code is working')).toHaveCount(0, { timeout: 60_000 })
  if (!taskId) {
    const s = await (await page.request.get(`/api/sessions/${sessionId}`)).json() as { session?: { taskId?: string }; taskId?: string }
    taskId = s.session?.taskId ?? s.taskId ?? null
  }

  // ── The link goes down ──
  await setLink(fx, 'drop-hold')
  const downAt = Date.now()
  // The panel says so at once, in the host's name, not after the five minutes the record takes.
  const notice = column(page).getByTestId('session-host-down')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(notice).toContainText('Cloud')
  await expect(notice).not.toContainText(CLOUD)
  await expect(notice).toContainText('Messages you send wait')
  console.log(`[link-down] panel notice after ${Date.now() - downAt} ms (${browserName})`)

  // He writes; the bubble says it waits for Cloud and when Walnut tries again.
  await send(page, 'snapshot-clean-turn:reply once the link is back')
  const note = column(page).locator('.session-msg-held-note').last()
  await expect(note).toBeVisible({ timeout: 30_000 })
  await expect(note).toContainText('Not sent yet: Walnut cannot reach Cloud right now')
  await expect(note).toContainText(/Next try at|Trying again now/)
  await expect(note.getByRole('button', { name: 'Send now' })).toBeVisible()
  await expect(column(page).getByText(/Send failed/)).toHaveCount(0)
  await page.waitForTimeout(1_500)

  // The task reads Waiting on its machine, naming Cloud (task rows, Org, the phone read this).
  if (taskId) {
    await expect.poll(async () => (await userStatus(page))?.kind, { timeout: 30_000 }).toBe('machine')
    expect((await userStatus(page))?.waitingOn ?? '').toContain('Cloud')
  }

  // A reload keeps the bubble's words.
  await page.reload()
  await expect(column(page)).toBeVisible({ timeout: 60_000 })
  const after = column(page).locator('.session-msg-held-note').last()
  await expect(after).toContainText('Not sent yet: Walnut cannot reach Cloud right now', { timeout: 30_000 })
  await expect(column(page).getByText(/Send failed/)).toHaveCount(0)
  await expect(column(page).getByTestId('session-host-down')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  expect(errors).toEqual([])
})

test('2. the link comes back: the waiting message is delivered by itself and its reply shows', async ({ page }) => {
  test.setTimeout(300_000)
  test.skip(!sessionId, 'needs the session of test 1')
  const fx = await fixture()
  // The column he had open (a new browser here: the same column, opened again).
  await seedColumns(page, [sessionId!])
  await loadHome(page)
  await expect(column(page)).toBeVisible({ timeout: 60_000 })
  await expect(column(page).locator('.session-msg-held-note').last()).toContainText('cannot reach Cloud', { timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await setLink(fx, 'pass')
  const upAt = Date.now()
  await expect(column(page).getByText('reply once the link is back', { exact: true }).first()).toBeVisible({ timeout: 180_000 })
  console.log(`[link-down] delivered and answered ${Date.now() - upAt} ms after the link came back`)
  await expect(column(page).locator('.session-msg-held-note')).toHaveCount(0, { timeout: 30_000 })
  await expect(column(page).getByTestId('session-host-down')).toHaveCount(0, { timeout: 30_000 })
  await expect(column(page).getByText(/Send failed/)).toHaveCount(0)
  if (taskId) await expect.poll(async () => (await userStatus(page))?.kind, { timeout: 30_000 }).not.toBe('machine')
  await page.waitForTimeout(1_500)
})

test('3. a reply written while the link is down shows once the link is back', async ({ page }) => {
  test.setTimeout(360_000)
  test.skip(!sessionId, 'needs the session of test 1')
  const fx = await fixture()
  await setLink(fx, 'pass')
  await seedColumns(page, [sessionId!])
  await loadHome(page)
  await expect(column(page)).toBeVisible({ timeout: 60_000 })
  // A turn that answers 20 s later; the link goes down while it runs.
  await send(page, 'snapshot-long-turn:20000')
  await expect(column(page).getByText('Claude Code is working').first()).toBeVisible({ timeout: 60_000 })
  await setLink(fx, 'drop-hold')
  await expect(column(page).getByTestId('session-host-down')).toBeVisible({ timeout: 30_000 })
  // The answer is written on Cloud meanwhile; nothing of it can reach this page yet, and the
  // panel keeps saying the host cannot be reached the whole time (a re-dial in flight included).
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5_000)
    await expect(column(page).getByTestId('session-host-down')).toBeVisible()
  }
  await expect(column(page).getByText(/Long turn \d+ ran to completion\./)).toHaveCount(0)
  await setLink(fx, 'pass')
  const upAt = Date.now()
  await expect(column(page).getByText(/Long turn \d+ ran to completion\./).first()).toBeVisible({ timeout: 120_000 })
  console.log(`[link-down] reply written while down showed ${Date.now() - upAt} ms after the link came back`)
  await expect(column(page).getByTestId('session-host-down')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(1_500)
})
