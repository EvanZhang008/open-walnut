/**
 * Draft column OUTCOME helpers — how a spec proves what a draft's launch meta did,
 * now that the column shows none of it.
 *
 * On 2026-09-15 the draft column lost its task-meta row (the Focus / Satellite /
 * Backlog / Wait segmented control and its More menu: the user found it
 * "complicated for people"). Every new task lands in Focus; a tier "+" seed still
 * lands in its own tier; the background parse may fill dates but never the tier.
 * None of that is readable off the column any more, so the assertions moved to
 * the OUTCOME: commit the draft, then read the created task's tier from the same
 * API the board renders from. These helpers are that idiom, in one place, next to
 * the wait that makes it sound (`awaitParse`).
 *
 * Kept apart from ./draft-helpers (locators + fixture kit) on purpose: that file
 * is already past the repo's ~500-line guideline, and nothing here is a locator.
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, draftProjectPill } from './draft-helpers'

/**
 * The tier a task is pinned in, read from the focus API — the SAME source the
 * board's tier sections render from. 'unpinned' when it is in none of them.
 */
export async function pinnedTierOf(page: Page, taskId: string): Promise<string> {
  const res = await page.request.get('/api/focus/tasks')
  if (!res.ok()) return `api-error-${res.status()}`
  const body = (await res.json()) as {
    focus_tasks?: string[]; satellite_tasks?: string[]; backlog_tasks?: string[]; wait_tasks?: string[]
    custom_tier_tasks?: Record<string, string[]>
  }
  if (body.focus_tasks?.includes(taskId)) return 'focus'
  if (body.satellite_tasks?.includes(taskId)) return 'satellite'
  if (body.backlog_tasks?.includes(taskId)) return 'backlog'
  if (body.wait_tasks?.includes(taskId)) return 'wait'
  for (const [tier, ids] of Object.entries(body.custom_tier_tasks ?? {})) {
    if (ids.includes(taskId)) return tier
  }
  return 'unpinned'
}

/**
 * "◌ Create task for later" on `panel`, returning the created task's id.
 *
 * The task exit is the cheapest way to COMMIT a draft's launch meta: it needs no
 * folder and spawns no CLI, and the id comes straight from the POST /api/tasks
 * response the click fires (`{ task }`, src/web/routes/tasks.ts), so the spec never
 * has to find the task by title. A non-2xx create fails HERE with the server's
 * body, instead of surfacing later as an unrelated timeout.
 *
 * Also pins the ATOMICITY of the tier: the tier the created task comes back in
 * must be the one the create request itself carried (`focus_tier`). A client that
 * pins first and sets the tier in a second request passes every outcome check yet
 * leaves the task in the server's pin default whenever the page dies in between —
 * which is exactly how this was found (a probe killed right after the POST).
 */
export async function createTaskForLater(page: Page, panel: Locator): Promise<string> {
  const created = page.waitForResponse((res) =>
    res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/tasks')
  await panel.locator('.draft-later-btn').click()
  const res = await created
  if (!res.ok()) throw new Error(`POST /api/tasks answered ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { task?: { id?: string; pinned?: boolean; focus_tier?: string } }
  if (!body.task?.id) throw new Error(`POST /api/tasks answered without a task id: ${JSON.stringify(body).slice(0, 200)}`)
  const sent = res.request().postDataJSON() as { pinned?: boolean; focus_tier?: string }
  expect(sent.pinned, 'the create itself pins the task').toBe(true)
  // Satellite is stored as "no focus_tier" (the pinned default), every other tier verbatim.
  expect(sent.focus_tier, 'the tier rides the create, not a follow-up write').toBe(body.task.focus_tier ?? 'satellite')
  return body.task.id
}

/**
 * The pin is a SECOND write after the create (optimistic pin → commitPin), so
 * "the task landed in tier X" is a poll, not a read. Intervals are explicit so a
 * slow fixture pays a few ticks, not Playwright's default ramp.
 */
export async function expectTaskInTier(page: Page, taskId: string, tier: string): Promise<void> {
  await expect.poll(() => pinnedTierOf(page, taskId), {
    timeout: 15_000,
    intervals: [200, 400, 800, 1500],
    message: `the task never reached the ${tier} tier`,
  }).toBe(tier)
}

/**
 * Wait until a quick-parse response has been APPLIED to the draft, not merely
 * received.
 *
 * Nothing in the column badges a parsed date or tier any more, so there is no DOM
 * signal to wait on; the response is the only handle. `finished()` covers the body
 * (the client applies the parse after reading it), and the double rAF is a
 * page-side barrier: the fetch resolution and the React commit it triggers are
 * already queued by then, so an assertion issued after this cannot run against
 * the pre-parse state. Register BEFORE typing — a spec that arms the wait after
 * the keystrokes can miss an eager (mid-typing) parse.
 */
export function armParse(page: Page, status = 200): () => Promise<void> {
  const response = page.waitForResponse((res) =>
    res.request().method() === 'POST'
    && new URL(res.url()).pathname === '/api/tasks/quick-parse'
    && res.status() === status)
  return async () => {
    await (await response).finished()
    await page.evaluate(() => new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()))
    }))
  }
}

/** Pick `name` for the draft's project through the real pill flyout, and check the
 *  pill took it as the user's own (no ✦ left on it). */
export async function pickDraftProject(page: Page, panel: Locator, name: string): Promise<void> {
  await draftProjectPill(panel).click()
  const flyout = page.locator('.task-kebab-project-flyout')
  await expect(flyout).toBeVisible({ timeout: 10_000 })
  await flyout.locator('.task-kebab-project-opt', { hasText: new RegExp(`^${name}$`) }).first().click()
  await expect(draftProjectPill(panel)).toHaveText(name)
  await expect(draftProjectPill(panel)).not.toHaveClass(/session-action-chip-ai/)
}

/** The seed-outcome epilogue every tier "+" spec ends with: type, commit through
 *  the task exit, and read the tier the task landed in. */
export async function expectSeededTierLands(page: Page, panel: Locator, tier: string, probe: string): Promise<void> {
  await draftComposer(page).fill(probe)
  const taskId = await createTaskForLater(page, panel)
  await expectTaskInTier(page, taskId, tier)
}
