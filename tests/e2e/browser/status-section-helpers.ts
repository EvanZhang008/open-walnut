/**
 * Helpers for the home task panel's status sections and layout designs
 * (web/src/components/tasks/status-sections.ts, StatusSections.tsx, panel-design.ts).
 *
 * With the Status filter at its default and no search, the panel draws its tasks
 * under status headings. Flat (the default): Watching, Needs you (no heading), Working,
 * Waiting / snoozed and Completed, with no list. By project: Watching on top, the list
 * itself, and each project folding its own waiting and completed rows. These replaced the old footer ("N Waiting hidden", "N Complete hidden",
 * "N not available yet: show").
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

export type StatusSectionKey = 'watching' | 'needs' | 'working' | 'waiting' | 'done'
/** 'status' is Flat (the product default), 'project' By project (what every page's storage starts with). */
export type PanelDesign = 'status' | 'project'

/** Keys must match panel-design.ts / status-sections.ts. */
export const LS_PANEL_DESIGN_KEY = 'walnut-todo-panel-design'
export const LS_STATUS_SECTIONS_KEY = 'walnut-todo-status-sections'

/**
 * Pick the panel layout before the first render: call BEFORE `page.goto()`.
 * Every page's storage starts with 'project' (playwright.config.ts storageState; By project, the list with its rows in their
 * tiers and projects); a spec about Flat presets 'status'. Takes a context too, so a second page of the same
 * context (an observer tab) gets the same layout. The key is ui-prefs mirrored, so
 * pair this with `isolateUiPrefs` (or `isolateUiPrefsContext`) to keep the pick out
 * of the shared fixture's preferences.
 */
export async function presetPanelDesign(target: Page | BrowserContext, design: PanelDesign): Promise<void> {
  await target.addInitScript(([key, value]) => {
    try { localStorage.setItem(key, value) } catch { /* storage off */ }
  }, [LS_PANEL_DESIGN_KEY, design] as const)
}

/**
 * `isolateUiPrefs` for every page of a context: the boot GET answers the fixture's
 * one shared pref (the chat slot closed), and PUTs are dropped, so nothing this
 * context stores reaches another spec through the fixture server.
 */
export async function isolateUiPrefsContext(context: BrowserContext): Promise<void> {
  const prefs = { 'open-walnut-home-chat-visible': { v: 'false', ts: 1 } }
  await context.route('**/api/ui-prefs', async (route) => {
    const body = route.request().method() === 'GET' ? JSON.stringify({ prefs }) : '{"ok":true}'
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
}

/** The section's heading (a div holding the one toggle button). */
export const statusSection = (scope: Page | Locator, key: StatusSectionKey): Locator => scope.getByTestId(`status-section-${key}`).first()
/** The heading's toggle: a button with aria-expanded. */
export const statusSectionToggle = (scope: Page | Locator, key: StatusSectionKey): Locator => statusSection(scope, key).locator('button[aria-expanded]')
export const statusSectionCount = (scope: Page | Locator, key: StatusSectionKey): Locator => scope.getByTestId(`status-section-${key}-count`).first()
/** The rows of an open section. */
export const statusSectionRows = (scope: Page | Locator, key: StatusSectionKey): Locator => scope.getByTestId(`status-section-${key}-rows`).first()
/** One task's card inside an open section. */
export const statusSectionCard = (scope: Page | Locator, key: StatusSectionKey, taskId: string): Locator =>
  statusSectionRows(scope, key).locator(`[data-task-id="${taskId}"]`)

/** The number the section's heading shows (waits for the heading to be drawn). */
export async function statusSectionCountOf(scope: Page | Locator, key: StatusSectionKey, timeout = 15_000): Promise<number> {
  const count = statusSectionCount(scope, key)
  await expect(count).toBeVisible({ timeout })
  return Number(((await count.textContent()) ?? '').trim())
}

/** Open or fold one section through its heading, the way a user does. */
export async function setStatusSectionOpen(scope: Page | Locator, key: StatusSectionKey, open: boolean): Promise<void> {
  const toggle = statusSectionToggle(scope, key)
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', String(open))
}

/**
 * An open section draws its rows in batches of 30: click its "Show more" until the
 * task's card is drawn (the shared fixture board may hold many waiting or completed
 * tasks from other specs).
 */
export async function showSectionCard(scope: Page | Locator, key: StatusSectionKey, taskId: string, maxClicks = 40): Promise<Locator> {
  const card = statusSectionCard(scope, key, taskId)
  const more = scope.getByTestId(`status-section-${key}-more`).first()
  for (let i = 0; i < maxClicks && (await card.count()) === 0; i++) {
    if ((await more.count()) === 0) break
    if (await more.isDisabled()) { await expect(more).toBeEnabled({ timeout: 15_000 }).catch(() => undefined); continue }
    // The row can go between the check and the click (the archive it asked for has
    // arrived and every row is drawn): a short click that may miss, then look again.
    await more.click({ timeout: 3_000 }).catch(() => undefined)
    await card.waitFor({ state: 'attached', timeout: 1_000 }).catch(() => undefined)
  }
  await expect(card).toBeVisible({ timeout: 15_000 })
  return card
}

/**
 * Open a tier's inline "Add to <Tier>…" row from the tier's "+" → New task. A tier
 * that holds tasks no longer draws the standing ghost row; the "+" is the way in.
 * `heading` is the tier's heading: the solo tier view's `tier-view-bar`, or a tier
 * sub-heading in the All view. Handles both shapes of the control: a "+" that opens
 * a menu, a "···" heading menu, and a "+" with one verb that acts at once.
 */
export async function openTierInlineAdd(page: Page, heading: Locator): Promise<Locator> {
  const input = page.locator('.focus-inline-add input')
  await expect(async () => {
    await heading.hover()
    const plus = heading.locator('[data-testid="plus-menu-trigger"], .navigation-more').first()
    await plus.click({ timeout: 3_000 })
    if ((await input.count()) === 0) {
      const item = page.locator('[data-testid="plus-menu"] .task-kebab-item, [role="menuitem"]').filter({ hasText: /^\s*New task\s*$/ }).first()
      await item.click({ timeout: 3_000 })
    }
    await expect(input).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 20_000 })
  return input
}
