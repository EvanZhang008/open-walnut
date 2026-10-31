import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'
import { REAL_PANEL, openDraftOnCwd } from './draft-helpers'

/**
 * The 2026-10-30 Codex report, end to end on the Homepage: Stop mid-turn (the
 * ACP worker is ended), the next send cold-starts a worker whose session/load
 * fails, and then the user sends again, fast. What must hold:
 *  - the transcript says, durably, that a new provider thread was started
 *    (it once went out as a live event on the session id the panel had left);
 *  - a message sent inside the composer's 300 ms draft debounce leaves the box
 *    empty and never comes back as the draft (it was shown again and resent);
 *  - each message is in the transcript once, before and after a reload.
 * Runs on WebKit too (PW_WEBKIT=1 --project webkit): the Mac app is WKWebView.
 */

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/codex-interrupt-send'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const BASE_PROMPT = 'interrupt baseline lifecycle-slow-mobile'
const NEW_THREAD_NOTICE = 'Could not resume the earlier conversation, so a new provider thread was started.'
const RESUMED_NOTICE = 'Resumed the earlier conversation in its own provider thread.'
const ROUNDS = [1, 2, 3].map((n) => `codex fast send round ${n}`)
const replyFor = (prompt: string) => `hello from mock-acp (you said: ${prompt})`

let fixtureRoot = ''
let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function openCodexQuickStart(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Codex' })
}

/**
 * System notes in a row fold into one "N errors ›" (or "N system messages ›" when
 * one is info) row; open it, then find the notice. When the turn-end self-report
 * took the failed load, the next send finds that new thread unused and restores
 * the earlier one (acp-thread-restore.ts), so "Resumed the earlier conversation"
 * may follow: the conversation is back, which is the point.
 */
async function expectNewThreadNotice(panel: Locator): Promise<void> {
  const group = panel.getByRole('button', { name: /^\d+ (errors?|system messages?)/ })
  await expect(group).toHaveCount(1, { timeout: 10_000 })
  await group.click()
  await expect(panel.getByText(NEW_THREAD_NOTICE, { exact: false })).toHaveCount(1, { timeout: 10_000 })
  expect(await panel.getByText(RESUMED_NOTICE, { exact: true }).count()).toBeLessThanOrEqual(1)
}

/**
 * The live ACP worker pid of the task's session (0: none), from the worker
 * registry of the fixture's MockDaemon (tests/helpers/mock-daemon.ts keeps it
 * in its own mkdtemp dir, so the one naming this runtime is it); a row is a pid or { pid }.
 */
async function workerPid(page: Page, taskId: string): Promise<number> {
  const response = await page.request.get(`/api/sessions/task/${taskId}`)
  const body = await response.json() as { sessions: Array<{ acpRuntimeId?: string }> }
  const runtimeId = body.sessions.find((s) => s.acpRuntimeId)?.acpRuntimeId
  if (!runtimeId) return 0
  for (const dir of await fs.readdir(os.tmpdir())) {
    if (!dir.startsWith('mock-daemon-')) continue
    try {
      const rows = JSON.parse(await fs.readFile(path.join(os.tmpdir(), dir, 'acp-workers.json'), 'utf-8')) as Record<string, number | { pid: number }>
      const row = rows[runtimeId]
      if (row !== undefined) return typeof row === 'number' ? row : row.pid
    } catch { /* not this daemon's */ }
  }
  return 0
}

async function processStatus(page: Page, taskId: string): Promise<string> {
  const response = await page.request.get(`/api/sessions/task/${taskId}`)
  const body = await response.json() as { sessions: Array<{ process_status: string; acpRuntimeId?: string }> }
  return body.sessions.find((s) => s.acpRuntimeId)?.process_status ?? ''
}

test('Stop, a failed reload, then fast sends: one notice, an empty box, each message once', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const failNextLoad = path.join(walnutHome, 'mock-acp-fail-next-load')
  await fs.rm(failNextLoad, { force: true })

  // A slow turn, stopped while it streams.
  const draft = await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await draft.locator('.chat-input-textarea').fill(BASE_PROMPT)
  await draft.locator('.chat-input-textarea').press('Enter')
  const { taskId } = await (await quickStartResponse).json() as { taskId: string }
  // The fixture may show other session columns: this one is the column holding its first prompt.
  const panel = page.locator(REAL_PANEL).filter({ hasText: BASE_PROMPT })
  await expect(panel.getByText('thinking...').first()).toBeVisible({ timeout: 20_000 })
  const firstWorker = await (async () => {
    let pid = 0
    await expect.poll(async () => (pid = await workerPid(page, taskId)), { timeout: 15_000 }).toBeGreaterThan(0)
    return pid
  })()
  // The next session/load fails once. Whichever start loads the thread first (the
  // turn-end self-report after the Stop, or the next send) gets the failure, and
  // Walnut falls back to a new provider thread, as Codex 0.166 made it do.
  await fs.writeFile(failNextLoad, '1')
  await panel.locator('.chat-stop-btn-icon').first().click()
  // Stop ends the worker (acpAbortTurn); a later start is a new worker that loads the thread.
  await expect.poll(() => workerPid(page, taskId), { timeout: 15_000 }).not.toBe(firstWorker)
  await expect(panel.locator('.chat-stop-btn-icon')).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => processStatus(page, taskId), { timeout: 20_000 }).not.toBe('running')

  const box = panel.locator('.chat-input-textarea')
  for (const [i, prompt] of ROUNDS.entries()) {
    const draftKey = await box.getAttribute('data-draft-key')
    expect(draftKey).toBeTruthy()
    await box.click()
    await box.fill(prompt)
    // Inside the 300 ms draft debounce, by the arrow, so focus leaves the box.
    await page.waitForTimeout(120)
    await panel.locator('.chat-send-btn-icon:not(.chat-stop-btn-icon)').first().click()
    await expect(panel.getByText(replyFor(prompt), { exact: true })).toHaveCount(1, { timeout: 30_000 })
    await expect(box).toHaveValue('')
    // The draft the box was typed under is gone, and so is any key the session moved to.
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:')))
    for (const key of keys) {
      expect(await page.evaluate((k) => localStorage.getItem(k), key), `draft ${key} after round ${i + 1}`).not.toBe(prompt)
    }
    if (i === 0) {
      await expect(fs.access(failNextLoad)).rejects.toThrow()   // the load really failed once
      await expectNewThreadNotice(panel)
    }
    await expect.poll(() => processStatus(page, taskId), { timeout: 20_000 }).not.toBe('running')
  }
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/${browserName}-before-reload.png` })

  await page.reload()
  await page.waitForLoadState('networkidle')
  const reloaded = page.locator(REAL_PANEL).filter({ hasText: BASE_PROMPT })
  await expect(reloaded.getByText(replyFor(ROUNDS[2]), { exact: true })).toHaveCount(1, { timeout: 30_000 })
  await expect(reloaded.locator('.chat-input-textarea')).toHaveValue('')
  await expectNewThreadNotice(reloaded)
  for (const prompt of ROUNDS) {
    await expect(reloaded.getByText(prompt, { exact: true })).toHaveCount(1)
    await expect(reloaded.getByText(replyFor(prompt), { exact: true })).toHaveCount(1)
  }
  await reloaded.screenshot({ path: `${SCREENSHOT_DIR}/${browserName}-after-reload.png` })
  await audit.assertClean()
})
