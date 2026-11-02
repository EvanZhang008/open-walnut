/**
 * The session header's title row: the title, ONE folded labels control and the kebab
 * (2026-11-02, the user: "idle and running don't need to show ... the tag still noisy,
 * all collapse, user can click, and because it is collapsed so have more room to have
 * good name"). SessionHeaderLabels.tsx holds every label; the run status is not in the
 * header at all.
 *
 *   - the title row holds nothing beside the title but the labels control, the kebab and
 *     (only while there are questions) the thread mode switch: any new pill fails here,
 *     whatever its class (the source half is tests/web/session-header-labels-guard.test.ts);
 *   - no Running / Idle / Stopped word anywhere in the header;
 *   - the control counts the labels, opens them all in a flyout inside the window (a wide
 *     and a narrow column), each pill still opens what it opens, and a pill's own flyout
 *     opened from there keeps the labels open; Escape and an outside click close it, and it
 *     opens again;
 *   - the title takes the room the labels gave back.
 *
 * Fixtures: `pw-task-links` (test-server.ts) carries link tags; `pw-task-model-switch`
 * gets two subtasks here so its header has a Leader pill.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL } from './draft-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = '/tmp/session-header-labels'
const litter: string[] = []

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`create ${title} failed: ${res.status} ${await res.text()}`)
  const { task } = await res.json() as { task: { id: string } }
  litter.push(task.id)
  return task.id
}

async function openHome(page: Page) {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function openTaskSession(page: Page, taskId: string, sessionId: string, search: string): Promise<Locator> {
  await page.locator('.todo-search-input').fill(search)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 45_000 })
  await expect(panel.locator('.session-panel-title-meta .task-kebab-btn')).toBeVisible()
  return panel
}

/** What the title row holds besides the title area, by kind; anything unknown is named. */
async function titleRowParts(panel: Locator): Promise<string[]> {
  return panel.locator('.session-panel-header-top').evaluate((row) => {
    const kinds: string[] = []
    for (const el of Array.from(row.children) as HTMLElement[]) {
      if (el.classList.contains('session-panel-title-area')) continue
      if (el.classList.contains('session-panel-header-leading')) { kinds.push('leading'); continue }
      if (el.classList.contains('thread-mode-pill-slot')) { kinds.push('thread-mode'); continue }
      if (el.classList.contains('session-panel-title-meta')) {
        for (const c of Array.from(el.children) as HTMLElement[]) {
          if (c.matches('[data-testid="session-header-labels"]')) kinds.push('labels')
          else if (c.querySelector('.task-kebab-btn') || c.classList.contains('task-kebab-btn')) kinds.push('kebab')
          else kinds.push(`UNKNOWN:${c.className || c.tagName}`)
        }
        continue
      }
      kinds.push(`UNKNOWN:${el.className || el.tagName}`)
    }
    // The title area holds the unread dot, the phase circle and the title, nothing else.
    const area = row.querySelector(':scope > .session-panel-title-area')
    for (const c of Array.from(area?.children ?? []) as HTMLElement[]) {
      const ok = c.classList.contains('session-panel-title') || c.classList.contains('session-panel-title-input')
        || c.classList.contains('task-unread-dot') || c.classList.contains('task-quick-actions')
      if (!ok) kinds.push(`UNKNOWN-in-title-area:${c.className || c.tagName}`)
    }
    return kinds
  })
}

const STATUS_WORDS = /\b(Running|Idle|Stopped|Not available)\b/

async function expectNoStatus(panel: Locator) {
  const text = await panel.locator('.session-panel-header').innerText()
  expect(text).not.toMatch(STATUS_WORDS)
}

async function expectInViewport(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
}

test.beforeEach(async ({ page }) => {
  litter.length = 0
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of [...litter].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

for (const width of [1440, 900]) {
  test(`the title row folds every label into one control at ${width}px`, async ({ page, browserName }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 860 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openHome(page)
    const panel = await openTaskSession(page, 'pw-task-links', 'pw-links-session', 'Linked plans fixture')

    const labels = panel.locator('[data-testid="session-header-labels"]')
    await expect(labels).toBeVisible()
    expect(await titleRowParts(panel)).toEqual(['labels', 'kebab'])
    await expectNoStatus(panel)
    // No label is drawn in the panel itself: they all live in the control.
    await expect(panel.locator('.session-panel-header .task-tag-pills, .session-panel-header .task-trigger-pill, .session-panel-header .task-team-pill, .session-panel-header .session-cron-pill, .session-panel-header .task-waiting-chip')).toHaveCount(0)

    // The title has the row: everything but the control, the kebab and their gaps.
    const row = (await panel.locator('.session-panel-header-top').boundingBox())!
    const meta = (await panel.locator('.session-panel-title-meta').boundingBox())!
    expect(meta.width).toBeLessThan(90)
    expect(row.width - meta.width).toBeGreaterThan(row.width * 0.6)

    await fs.mkdir(SHOT_DIR, { recursive: true })
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-${width}-closed.png`, animations: 'disabled' })

    // The count is the labels the flyout lists.
    const count = Number(await labels.locator('.session-header-labels-count').innerText())
    expect(count).toBeGreaterThan(1)
    await labels.click()
    const flyout = page.locator('[data-testid="session-header-labels-flyout"]:visible')
    await expect(flyout).toHaveCount(1)
    await expect(labels).toHaveAttribute('aria-expanded', 'true')
    await expect(flyout.locator('.tag-chip')).toHaveCount(count)
    await expectInViewport(page, flyout)
    // Every tag is whole there: the names the session gave, not a clipped head.
    await expect(flyout).toContainText('Test matrix r5')
    await page.screenshot({ path: `${SHOT_DIR}/${browserName}-${width}-open.png`, animations: 'disabled' })

    // Escape closes, a click on the control opens again, an outside click closes.
    await page.keyboard.press('Escape')
    await expect(flyout).toHaveCount(0)
    await expect(labels).toHaveAttribute('aria-expanded', 'false')
    for (let round = 0; round < 3; round++) {
      await labels.click()
      await expect(flyout).toHaveCount(1)
      await page.mouse.click(5, 855)
      await expect(flyout).toHaveCount(0)
    }

    // A link in the list still opens what it opens (a file opens in Files).
    await labels.click()
    await flyout.locator('.tag-chip', { hasText: 'Test matrix r5' }).first().click()
    await expect(panel.locator('.session-action-chip-active', { hasText: 'Files' }).or(panel.locator('[data-header-id="files"].session-action-chip-active'))).toHaveCount(1, { timeout: 10_000 })
    expect(errors).toEqual([])
  })
}

test('a pill opened from the labels keeps them open, and still leads where it leads', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const parent = 'pw-task-model-switch'
  const near = await createTask(`Header labels note ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: parent })
  await createTask(`Header labels ops ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: parent })
  await openHome(page)
  // Searched first, so the row holds still while the board loads around it (a click on a
  // row the list then moved landed on its neighbour).
  const panel = await openTaskSession(page, parent, 'pw-model-switch-session', 'Model switch test task')
  // The whole board again, so the subtask's row is there to be located at the end.
  await page.locator('.todo-search-input').fill('')
  const labels = panel.locator('[data-testid="session-header-labels"]')
  // The record loaded (its "Loading..." placeholder gone) and the labels read.
  await expect(labels).toBeVisible({ timeout: 15_000 })
  expect(await titleRowParts(panel)).toEqual(['labels', 'kebab'])
  await expectNoStatus(panel)

  await expect(labels).toHaveAttribute('title', /Leader · \d+/)
  await labels.click()
  const flyout = page.locator('[data-testid="session-header-labels-flyout"]:visible')
  const leader = flyout.locator('[data-testid="leader-pill"]')
  await expect(leader).toHaveText(/^Leader · \d+$/)
  await leader.click()
  const subs = page.locator('[data-testid="leader-subtasks-flyout"]')
  await expect(subs).toBeVisible()
  await expectInViewport(page, subs)
  // Its own flyout is a portal of its own: a click in it is not "outside" the labels.
  await subs.locator('.leader-subtasks-head, [data-testid="leader-sub-row"]').first().hover()
  await expect(flyout).toHaveCount(1)
  await page.screenshot({ path: `${SHOT_DIR}/${browserName}-leader-from-labels.png`, animations: 'disabled' })
  // Escape closes one layer: the subtasks first, then the labels.
  await page.keyboard.press('Escape')
  await expect(subs).toHaveCount(0)
  await expect(flyout).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
  // From the keyboard the focus goes into the list, so every label is reachable.
  await labels.focus()
  await page.keyboard.press('Enter')
  await expect(flyout).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="session-header-labels-flyout"]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
  // A press on the control while a pill's flyout is open closes both at once.
  await labels.click()
  await leader.click()
  await expect(subs).toBeVisible()
  await labels.click()
  await expect(flyout).toHaveCount(0)
  await expect(subs).toHaveCount(0, { timeout: 2_000 })
  await labels.click()
  await leader.click()
  await subs.locator(`[data-testid="leader-sub-row"][data-task-id="${near}"]`).click()
  await expect(page.locator(`.todo-panel-item[data-task-id="${near}"]`)).toHaveClass(/task-focused/, { timeout: 10_000 })
})

test('the Ask Walnut slot header shows no run status and no loose label', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 860 })
  await openHome(page)
  const panel = await openTaskSession(page, 'pw-task-links', 'pw-links-session', 'Linked plans fixture')
  await expectNoStatus(panel)
  // Every session panel on the page, the slot's included, keeps the same row.
  const panels = page.locator('.session-panel[data-session-id]:visible')
  const n = await panels.count()
  for (let i = 0; i < n; i++) {
    const p = panels.nth(i)
    if (await p.locator('.session-panel-header-top').count() === 0) continue
    const parts = await titleRowParts(p)
    expect(parts.filter((k) => k.startsWith('UNKNOWN'))).toEqual([])
    await expectNoStatus(p)
  }
})
