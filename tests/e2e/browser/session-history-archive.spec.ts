/**
 * A session whose history the archive compressed (src/providers/transcript-archive.ts)
 * opens like any other: its messages show, and the transcript is back on disk
 * plain, byte for byte as the archive's manifest recorded it
 * (archived-history-fixture.ts seeds it already compressed).
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { ARCHIVED_LAST_ANSWER, ARCHIVED_SESSION, ARCHIVED_TASK, ARCHIVED_TITLE } from './archived-history-fixture'

test('an archived session opens with its whole history and is plain on disk again', async ({ page }) => {
  const res = await page.request.get(`/api/sessions/${ARCHIVED_SESSION}`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { cwd?: string; session?: { cwd?: string } }
  const cwd = (body.cwd ?? body.session?.cwd)!
  const tmpBase = path.dirname(path.dirname(cwd))
  const dir = path.join(tmpBase, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const plain = path.join(dir, `${ARCHIVED_SESSION}.jsonl`)
  // Nothing read it yet: only the archive is there (the session record read above names no file).
  expect(fs.existsSync(`${plain}.gz`), 'the fixture starts archived').toBe(true)
  expect(fs.existsSync(plain)).toBe(false)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(ARCHIVED_TITLE)
  const row = page.locator(`.todo-panel-item[data-task-id="${ARCHIVED_TASK}"]`)
  await expect(row).toBeVisible()
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${ARCHIVED_SESSION}"]`)
  await expect(panel).toBeVisible()
  await expect(panel.getByText('The invoice export drops the last line item', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByText(ARCHIVED_LAST_ANSWER)).toBeVisible()

  expect(fs.existsSync(plain), 'opening it restored the transcript').toBe(true)
  expect(fs.existsSync(`${plain}.gz`)).toBe(false)
  expect(fs.existsSync(path.join(dir, `${ARCHIVED_SESSION}.walnut-archive.json`))).toBe(false)
  expect(fs.readFileSync(path.join(dir, ARCHIVED_SESSION, 'subagents', 'agent-pw1.jsonl'), 'utf8')).toContain('checked page 119')
  await page.waitForTimeout(1500)
})
