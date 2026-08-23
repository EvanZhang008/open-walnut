/**
 * Helpers for the SURFACE-REACHABILITY specs — "is there a session route on this
 * surface, and can a user see it before they hover?"
 *
 * Separate module from ./draft-helpers (which owns the draft COLUMN: its pills,
 * picker, v4 layout, home-strip fixture kit) for two reasons: nothing here touches
 * a draft's internals, and folding it in pushed that file past this repo's ~500 LOC
 * ceiling. Specs import from both; the split is by subject, same convention the
 * three draft spec files follow.
 *
 * Used by tests/e2e/browser/draft-surface-plus.spec.ts.
 */

import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Preset the per-tier view mode ('project' = clustered with folder labels,
 * 'custom' = raw pin order) before the first render. Call BEFORE `page.goto`.
 *
 * Load-bearing for the same reason as `presetStickyTier`: the key rides
 * ui-prefs-sync (`walnut-todo-` prefix) on a SHARED fixture server, so another
 * spec's flip is merged back into a later page's localStorage at boot, and a locally
 * written value with no sync timestamp WINS that merge. Any spec asserting on the
 * by-project folder labels MUST pin this — in 'custom' mode those labels (and the
 * project "+" they carry) are not rendered at all, so an unpinned spec would fail
 * for someone else's reason.
 */
export async function presetTierViewModes(
  page: Page,
  modes: Record<string, 'project' | 'custom'>,
): Promise<void> {
  await page.addInitScript((m) => {
    try { localStorage.setItem('walnut-todo-tier-view-modes', JSON.stringify(m)) } catch { /* storage off */ }
  }, modes)
}

/**
 * The "+" on a task surface, whatever shape its host renders (R9).
 *
 * A host that can only launch a session (the /tasks table) keeps the direct
 * one-click button; a host that also offers "new task" and "add separator" (the
 * TODO panel's tier + project headers) renders the same button as a MENU trigger.
 * Specs address it by test id so a surface changing shape doesn't rewrite the
 * locator, and take the session branch through `openSessionFromPlus`.
 */
export function plusControl(scope: Locator): Locator {
  return scope.locator('[data-testid="plus-menu-trigger"]').first()
}

/** Is this "+" a menu trigger (multi-verb host) or the direct button? */
export async function plusIsMenu(scope: Locator): Promise<boolean> {
  return (await plusControl(scope).getAttribute('aria-expanded')) !== null
}

/** Click a "+" and land on its SESSION branch on either shape of host. */
export async function openSessionFromPlus(page: Page, scope: Locator): Promise<void> {
  await plusControl(scope).click()
  const item = page.getByTestId('plus-menu').locator('.task-kebab-item', { hasText: 'New task with session' }).first()
  const opened = await item.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false)
  if (opened) await item.click()
}

/** Click a "+" and take a named branch of its menu (multi-verb hosts only). */
export async function chooseFromPlus(page: Page, scope: Locator, label: string): Promise<void> {
  await plusControl(scope).click()
  const item = page.getByTestId('plus-menu').locator('.task-kebab-item', { hasText: label }).first()
  await item.waitFor({ state: 'visible', timeout: 5_000 })
  await item.click()
}

/**
 * Pin a task into a tier — TWO routes, deliberately.
 *
 * `POST /api/focus/tasks/:id` only pins (a fresh pin carries no `focus_tier`, which
 * the server reads as the Satellite default); the tier is a separate `PUT …/tier`.
 * There is no create-time `pinned_tier` field on `POST /api/tasks` — passing one is
 * silently ignored, and the resulting "card never appeared" looks like a product bug
 * from the spec's side. Both calls are asserted so a 4xx surfaces here instead.
 */
export async function pinToTier(page: Page, taskId: string, tier: string): Promise<void> {
  const pin = await page.request.post(`/api/focus/tasks/${taskId}`)
  expect(pin.ok(), await pin.text()).toBe(true)
  const set = await page.request.put(`/api/focus/tasks/${taskId}/tier`, { data: { tier } })
  expect(set.ok(), await set.text()).toBe(true)
}

/**
 * What a control looks like AT REST: its EFFECTIVE opacity (its own, multiplied
 * through every ancestor) plus whether the pointer is currently over it.
 *
 * The effective product is the honest measure — a button at `opacity: .45` inside a
 * wrapper at `opacity: 0` is invisible, and reading only the button's own value
 * would call that discoverable. `display:none` / `visibility:hidden` anywhere in the
 * chain short-circuits to 0 (that is how the hover-only kebab hides on the /tasks
 * group header). `hovered` is returned so a rest-state claim can PROVE it was
 * measured without a hover rather than assuming the mouse was elsewhere.
 *
 * WAITS FOR TRANSITIONS FIRST, and that is load-bearing rather than tidy: these
 * buttons carry `transition: opacity 0.15s`, and `getComputedStyle` reports the
 * INTERPOLATED value while a transition runs. A reading taken right after a hover
 * ended (or after any restyle) reports a number the control is on its way out of —
 * and it fails in the DANGEROUS direction, since a control fading 1 → 0 reads as
 * visible for ~150ms, which would let a reverted hover-only style pass. Found by a
 * mutation check: injecting `opacity: 0 !important` and reading immediately still
 * returned 0.45.
 */
export async function restVisibility(loc: Locator): Promise<{ opacity: number; hovered: boolean }> {
  // Settle every opacity transition on the element AND its ancestors (the reveal is
  // often driven by a wrapper), so the value read below is the resting one.
  await expect.poll(
    () => loc.evaluate((el) => {
      let node: Element | null = el
      let running = 0
      while (node && node !== document.documentElement) {
        running += node.getAnimations().length
        node = node.parentElement
      }
      return running
    }),
    { timeout: 5_000, message: 'the control never stopped transitioning' },
  ).toBe(0)

  return loc.evaluate((el) => {
    let node: Element | null = el
    let opacity = 1
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node)
      if (cs.display === 'none' || cs.visibility === 'hidden') return { opacity: 0, hovered: el.matches(':hover') }
      const own = Number.parseFloat(cs.opacity || '1')
      if (!Number.isNaN(own)) opacity *= own
      node = node.parentElement
    }
    return { opacity, hovered: el.matches(':hover') }
  })
}

/**
 * Navigate to /tasks the way a user does — through the UI, never `page.goto`.
 *
 * Top-level app-sidebar link. It briefly lived behind Settings while the sidebar was
 * decluttered, but the Tasks table is a daily surface, not configuration, so it came
 * back out. Same dance as tests/e2e/browser/codex-status-parity.spec.ts and
 * session-status-store.spec.ts; lifted here so a third copy can't drift.
 */
export async function navigateToTasksPage(page: Page): Promise<void> {
  const link = page.locator('.sidebar a[href="/tasks"]')
  await expect(link).toBeVisible({ timeout: 30_000 })
  await link.click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 30_000 })
}

/** The single-tier tabs' view-mode bar — where a solo tier's session "+" lives
 *  (those tabs render no sublabel row to host one). */
export function tierViewBar(page: Page): Locator {
  return page.locator('[data-testid="tier-view-bar"]')
}

/** One folder label inside a by-project tier ('' → the Inbox label). */
export function tierProjectLabel(page: Page, project: string): Locator {
  return page.locator('.tier-project-label').filter({
    has: page.locator('.tier-project-label-name').filter({ hasText: new RegExp(`^${project || 'Inbox'}$`) }),
  }).first()
}

/** A project group header on the /tasks table. */
export function tasksPageGroupHeader(page: Page, project: string): Locator {
  return page.locator('.tp-group-header').filter({
    has: page.locator('.tp-group-name').filter({ hasText: new RegExp(`^${project}$`) }),
  }).first()
}
