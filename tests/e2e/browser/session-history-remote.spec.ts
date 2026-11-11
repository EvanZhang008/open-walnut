/**
 * A session whose history went to remote storage (src/providers/transcript-offload.ts) opens
 * like any other: the panel says it is loading from remote storage while the download runs
 * (the fake storage holds each download a few seconds), then shows the whole conversation,
 * and the transcript is plain on disk again (remote-history-fixture.ts seeds it offloaded).
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { ARCHIVED_LAST_ANSWER } from './archived-history-fixture'
import { REMOTE_IDS } from './remote-history-fixture'

test('a session kept in remote storage shows a loading line, then its whole history, and is plain on disk again', async ({ page }) => {
  const res = await page.request.get(`/api/sessions/${REMOTE_IDS.sid}`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { cwd?: string; session?: { cwd?: string } }
  const cwd = (body.cwd ?? body.session?.cwd)!
  const tmpBase = path.dirname(path.dirname(cwd))
  const dir = path.join(tmpBase, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const plain = path.join(dir, `${REMOTE_IDS.sid}.jsonl`)
  const manifest = path.join(dir, `${REMOTE_IDS.sid}.walnut-archive.json`)
  // Only the manifest is here: the archive files are in remote storage.
  expect(fs.existsSync(manifest), 'the fixture starts offloaded').toBe(true)
  expect(fs.existsSync(plain)).toBe(false)
  expect(fs.existsSync(`${plain}.gz`)).toBe(false)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(REMOTE_IDS.title)
  const row = page.locator(`.todo-panel-item[data-task-id="${REMOTE_IDS.task}"]`)
  await expect(row).toBeVisible()
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${REMOTE_IDS.sid}"]`)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history-loading-line')).toHaveText(/Still loading this conversation from remote storage/, { timeout: 15_000 })
  await expect(panel.getByText('The invoice export drops the last line item', { exact: false })).toBeVisible({ timeout: 45_000 })
  await expect(panel.getByText(ARCHIVED_LAST_ANSWER)).toBeVisible()
  await expect(panel.locator('.session-history-loading-line')).toHaveCount(0)

  expect(fs.existsSync(plain), 'opening it restored the transcript').toBe(true)
  expect(fs.existsSync(`${plain}.gz`)).toBe(false)
  expect(fs.existsSync(manifest)).toBe(false)
  expect(fs.readFileSync(path.join(dir, REMOTE_IDS.sid, 'subagents', 'agent-pw1.jsonl'), 'utf8')).toContain('checked page 119')
  await page.waitForTimeout(1500)
})

test('Settings shows the remote history storage and how much it holds', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-sessions').click()
  const group = page.locator('[data-testid="history-remote-group"]')
  await group.scrollIntoViewIfNeeded()
  await expect(group).toBeVisible()
  await expect(group.locator('#history-remote-bucket')).toHaveValue('walnut-fixture-history')
  await expect(group.getByTestId('history-remote-other')).toHaveAttribute('aria-checked', 'true')
  await expect(group.getByTestId('history-remote-status')).toContainText(/stored remotely/)
  await group.getByTestId('history-remote-test').click()
  await expect(group.getByTestId('history-remote-connection-row')).toContainText(/Works: wrote, read back and removed a test object/, { timeout: 30_000 })
})
