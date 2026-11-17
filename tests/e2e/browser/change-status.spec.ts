/**
 * Change status in link tags (experiment `change_status`; web ChangePill.tsx, ChangeCard.tsx):
 *   - off, a change link pill is the plain link it always was;
 *   - on (switched while the page is open), the session header's change pill reads its status
 *     after the name, a dot in its tone (`CR-1001 · prod-w1 baking`); a GitHub pull request stays
 *     the plain link, since its own pull request pill on the title row shows it;
 *   - a click opens the card under the tags list instead of the link: the review, what to read
 *     first (where it stands and who moves next), the track and the stages that ask for a look,
 *     the runs of deployed and not-reached stages folded into rows that open on a click, the way
 *     out, when it was read;
 *   - a click on a stage, or on its segment of the track, reads its steps and blockers (the stage
 *     route is stubbed: the fixture has no provider for the review service), and Escape closes the
 *     card first, then the tags list.
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
  await expect(prPill).toHaveText('app#41')
  expect(await prPill.evaluate((el) => el.tagName)).toBe('A')
  await expect(prPill.locator('[data-testid="change-pill-status"]')).toHaveCount(0)
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
  await expect(card.locator('[data-testid="change-card-facts"]')).toContainText('4 checks passed')
  await expect(card.locator('[data-testid="change-card-now"]')).toContainText('Baking at prod-w1')
  await expect(card.locator('[data-testid="change-card-next"]')).toHaveText('Moves on by itself')
  await expect(card.locator('[data-testid="change-deploy-count"]')).toHaveText('2 of 12 deployed')
  await expect(card.locator('[data-testid="change-track"] button')).toHaveCount(12)
  const stages = card.locator('[data-testid="change-stage"]')
  await expect(stages).toHaveCount(2)
  await expect(stages.first()).toContainText('Baking')
  await expect(stages.first().locator('button')).toHaveAttribute('title', 'Bake Time: 6 hours 59 minutes left')
  const fold = card.locator('[data-testid="change-stage-fold"]')
  await expect(fold).toHaveCount(2)
  await expect(fold.first()).toContainText('2 deployed')
  await expect(fold.last()).toContainText('8 not reached')
  await expect(card.locator('[data-testid="change-card-open"]')).toHaveAttribute('href', 'https://review.acme.dev/CR-1001')
  await expect(card.locator('[data-testid="change-card-open-pipeline"]')).toHaveAttribute('href', 'https://pipelines.acme.dev/acme-deployer')
  await expect(card.locator('[data-testid="change-card-read"]')).toHaveText('Read 2 min ago')
  // A full commit hash (what a provider stores) reads short, the whole one on hover.
  await expect(card.locator('.change-card-commit')).toHaveText('a1b2c3d')
  await expect(card.locator('.change-card-commit')).toHaveAttribute('title', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
  // Under the tags list (never over its other pills), inside the window.
  const box = (await card.boundingBox())!
  const list = (await flyout.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(list.y + list.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(900)
  await shot(page, 'card', card)

  // The folds open on a click.
  await fold.first().click()
  await expect(fold).toHaveCount(1)
  await fold.first().click()
  await expect(fold).toHaveCount(0)
  await expect(stages).toHaveCount(12)
  // An opened run folds again from its first row.
  await card.locator('[data-testid="change-stage-hide"]').first().click()
  await expect(fold).toHaveCount(1)
  await expect(stages).toHaveCount(10)

  // A stage opens its steps and blockers, read live.
  await card.locator('[data-stage="prod-w1"] > button').click()
  const detail = card.locator('[data-stage="prod-w1"] [data-testid="change-stage-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-testid="change-stage-step"]')).toHaveCount(2)
  await expect(detail.locator('[data-testid="change-stage-step"]').first()).toContainText('Integration Test prod-c01')
  await expect(detail.locator('[data-testid="change-stage-step"] .change-card-step-name').first()).toHaveAttribute('title', 'https://tests.acme.dev/run/1')
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

  // A segment of the track opens its stage; a press outside closes the card, not the list.
  await openHeaderLabels(panel)
  await crPill.click()
  await expect(card).toBeVisible()
  await card.locator('[data-testid="change-track"] button').nth(6).click()
  await expect(card.locator('[data-stage="prod-w5"] [data-testid="change-stage-detail"]')).toBeVisible()
  expect(stageAsks.at(-1)).toBe('https://review.acme.dev/CR-1001|prod-w5')
  await flyout.click({ position: { x: 3, y: 3 } })
  await expect(card).toHaveCount(0)
  await expect(flyout).toHaveCount(1)

  expect(errors).toEqual([])
})

// 2026-11-17: a CR merged 12 days earlier showed only "Merged" and "Read 3 h ago". Its pipeline
// read failed, and the plugin dropped why; the watcher had read it minutes before, but the task
// keeps the snapshot as last written (a read with no news writes nothing). The card now takes the
// watcher's own last answer when it opens, and says why a merged change shows no deploy.
test('the card shows the watcher\'s latest read, and why a merged change has no deploy', async ({ page, request }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  restore ??= await setFlag(request, true)
  await setFlag(request, true)
  await page.setViewportSize({ width: 1280, height: 900 })
  const asks: string[] = []
  await page.route('**/api/tasks/*/changes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    asks.push(route.request().url())
    await route.fulfill({
      json: {
        enabled: true,
        changes: [{
          provider: 'acme:reviews', url: 'https://review.acme.dev/CR-1001', label: 'CR-1001',
          title: 'Move the controller onto the new instance type',
          review: { state: 'merged', revision: 1, approvals: { got: 1, need: 1 }, checks: { passed: 4, failed: 0, pending: 0 } },
          deployIssue: { code: 'failed', message: 'the pipeline did not answer' },
          checkedAt: new Date(Date.now() - 5_000).toISOString(),
        }],
      },
    })
  })

  const panel = await openSession(page)
  const flyout = openLabelsFlyout(panel)
  const crPill = flyout.locator(`[data-tag="${CR}"]`)
  await expect(panel.locator('[data-testid="pr-pill"]')).toBeVisible({ timeout: 20_000 })
  await expect(async () => {
    await openHeaderLabels(panel)
    await expect(crPill.locator('[data-testid="change-pill-status"]')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await crPill.click()
  const card = page.locator('[data-testid="change-card"]')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="change-card-now"]')).toContainText('Merged')
  await expect(card.locator('[data-testid="change-card-now-detail"]')).toHaveText('Could not read the deploy: the pipeline did not answer')
  await expect(card.locator('[data-testid="change-card-read"]')).not.toHaveText('Read 2 min ago')
  await expect(card.locator('[data-testid="change-card-read"]')).not.toHaveAttribute('data-stale', 'true')
  expect(asks.length).toBeGreaterThan(0)
  await shot(page, 'deploy-issue', card)
  expect(errors).toEqual([])
})
