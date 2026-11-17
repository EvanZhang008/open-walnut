/**
 * Change status in link tags (experiment `change_status`; web ChangePill.tsx, ChangeCard.tsx):
 *   - off, a change link pill is the plain link it always was;
 *   - on (switched while the page is open), the session header's change pills read their status
 *     after the name, a dot in its tone (`CR-1001 · prod-w1 baking`, `app#41 · In review 0/1`);
 *   - a click opens the card instead of the link: the review, every stage of the pipeline with
 *     the long run not reached folded into one row that opens on a click, Open review and Open
 *     pipeline, when it was read;
 *   - a click on a stage reads its steps and blockers (the stage route is stubbed: the fixture has
 *     no provider for the review service), and Escape closes the card first, then the tags list.
 *
 * The fixture task `pw-task-changes` (test-server.ts) holds the links and the watcher's snapshots.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { headerLabelsButton, openHeaderLabels, openLabelsFlyout } from './session-header-labels-helpers'

const SHOT_DIR = process.env.CHANGE_STATUS_SHOTS ?? (process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '')
const TASK = 'pw-task-changes'
const SESSION = 'pw-changes-session'
const CR = 'cr:https://review.acme.dev/CR-1001'
const PR = 'pr:https://github.com/acme/app/pull/41'

test.describe.configure({ mode: 'serial' })

async function shot(page: Page, name: string, clip?: Locator): Promise<void> {
  if (!SHOT_DIR) return
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `change-status-${name}.png`)
  if (clip) await clip.screenshot({ path: file })
  else await page.screenshot({ path: file })
}

/** Turns the experiment on or off server-wide; returns the flags to put back. */
async function setFlag(request: APIRequestContext, on: boolean): Promise<Record<string, boolean>> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const before = { ...(cfg.config?.experimental ?? {}) }
  const res = await request.put('/api/config', { data: { experimental: { ...before, change_status: on } } })
  expect(res.ok(), await res.text()).toBe(true)
  return before
}

async function openSession(page: Page): Promise<Locator> {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await page.locator('.todo-search-input').fill('Change status fixture')
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION}"]`)
  await expect(panel).toBeVisible()
  return panel
}

let restore: Record<string, boolean> | null = null

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterAll(async ({ request }) => {
  if (restore) await request.put('/api/config', { data: { experimental: restore } })
})

test('change link pills read their status, and the card opens a stage', async ({ page, request }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  restore = await setFlag(request, false)
  await page.setViewportSize({ width: 1280, height: 900 })

  // The provider's live read of one stage (the fixture server knows no review service).
  const stageAsks: string[] = []
  await page.route('**/api/tasks/*/changes/stage?*', async (route) => {
    const url = new URL(route.request().url())
    stageAsks.push(`${url.searchParams.get('url')}|${url.searchParams.get('stage')}`)
    await route.fulfill({
      json: {
        detail: {
          stage: url.searchParams.get('stage'),
          steps: [
            { name: 'Integration Test prod-c01', status: 'done', note: '6 tests, 0 failed', url: 'https://tests.acme.dev/run/1' },
            { name: 'Bake Time', status: 'waiting', note: 'fixed 12 hours' },
          ],
          blockers: [{ kind: 'bake', text: '6 hours 59 minutes left' }],
        },
      },
    })
  })

  const panel = await openSession(page)
  const flyout = openLabelsFlyout(panel)
  const crPill = flyout.locator(`[data-tag="${CR}"]`)
  const prPill = flyout.locator(`[data-tag="${PR}"]`)
  // The header settles first (the pull request pill joins the title row once it is read, and the
  // row is drawn again): the tags list opened before that closes with its button.
  await expect(panel.locator('[data-testid="pr-pill"]')).toBeVisible({ timeout: 20_000 })
  await expect(async () => {
    await openHeaderLabels(panel)
    await expect(crPill).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })

  // Off: the plain links they always were.
  await expect(crPill).toHaveText('CR-1001')
  expect(await crPill.evaluate((el) => el.tagName)).toBe('A')
  await expect(crPill.locator('[data-testid="change-pill-status"]')).toHaveCount(0)

  // On, while the page is open: the status arrives in the same pills.
  await setFlag(request, true)
  await expect(crPill.locator('[data-testid="change-pill-status"]')).toBeVisible({ timeout: 15_000 })
  await expect(crPill).toHaveText('CR-1001 · prod-w1 baking')
  await expect(crPill).toHaveAttribute('data-tone', 'waiting')
  await expect(crPill).toHaveAttribute('role', 'button')
  await expect(prPill).toHaveText('app#41 · In review 0/1')
  await expect(prPill).toHaveAttribute('data-tone', 'running')
  await shot(page, 'pills', flyout)

  // A click opens the card, not the link.
  await crPill.click()
  const card = page.locator('[data-testid="change-card"]')
  await expect(card).toBeVisible()
  await expect(crPill).toHaveAttribute('aria-expanded', 'true')
  expect(page.url()).not.toContain('review.acme.dev')
  await expect(card.locator('[data-testid="change-card-state"]')).toHaveText('Merged')
  await expect(card.locator('[data-testid="change-card-title"]')).toHaveText('Move the controller onto the new instance type')
  await expect(card.locator('[data-testid="change-card-facts"]')).toContainText('1/1 approvals')
  await expect(card.locator('[data-testid="change-card-facts"]')).toContainText('Checks: 4 passed')
  const stages = card.locator('[data-testid="change-stage"]')
  await expect(stages).toHaveCount(4)
  await expect(stages.nth(2)).toContainText('Bake Time: 6 hours 59 minutes left')
  const fold = card.locator('[data-testid="change-stage-fold"]')
  await expect(fold).toContainText('8 more stages')
  await expect(card.locator('[data-testid="change-card-open"]')).toHaveAttribute('href', 'https://review.acme.dev/CR-1001')
  await expect(card.locator('[data-testid="change-card-open-pipeline"]')).toHaveAttribute('href', 'https://pipelines.acme.dev/acme-deployer')
  await expect(card.locator('[data-testid="change-card-read"]')).toHaveText('read 2 min ago')
  // Inside the window, never over its edge.
  const box = (await card.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(900)
  await shot(page, 'card', card)

  // The fold opens on a click.
  await fold.click()
  await expect(fold).toHaveCount(0)
  await expect(stages).toHaveCount(12)

  // A stage opens its steps and blockers, read live.
  await card.locator('[data-stage="prod-w1"] > button').click()
  const detail = card.locator('[data-stage="prod-w1"] [data-testid="change-stage-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-testid="change-stage-step"]')).toHaveCount(2)
  await expect(detail.locator('[data-testid="change-stage-step"]').first()).toContainText('Integration Test prod-c01')
  await expect(detail.locator('[data-testid="change-stage-step"]').first().locator('a')).toHaveAttribute('href', 'https://tests.acme.dev/run/1')
  await expect(detail.locator('.change-card-blocker')).toContainText('6 hours 59 minutes left')
  expect(stageAsks).toEqual(['https://review.acme.dev/CR-1001|prod-w1'])
  await shot(page, 'stage', card)

  // A press inside the card keeps it and the tags list open.
  await card.locator('.change-card-head').click()
  await expect(card).toBeVisible()
  await expect(flyout).toHaveCount(1)

  // Escape closes the card first, then the tags list.
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(flyout).toHaveCount(1)
  await expect(crPill).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape')
  await expect(openLabelsFlyout(panel)).toHaveCount(0)
  await expect(headerLabelsButton(panel)).toHaveAttribute('aria-expanded', 'false')

  // The other pill's card, closed by a press outside.
  await openHeaderLabels(panel)
  await prPill.click()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="change-card-state"]')).toHaveText('In review')
  await expect(card.locator('[data-testid="change-card-waiting"]')).toHaveText('Waiting on team approval needs 1')
  await expect(card).toContainText('Deploy starts once it is merged.')
  await flyout.click({ position: { x: 3, y: 3 } })
  await expect(card).toHaveCount(0)
  await expect(flyout).toHaveCount(1)

  expect(errors).toEqual([])
})
