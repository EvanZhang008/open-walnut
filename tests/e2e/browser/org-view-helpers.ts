/**
 * The Org node's views since the side-bar redesign (2026-11-02): the chat is always on screen, and
 * the side bar's Tasks draws the node's work as All tasks or as its lead's Board (OrgTaskRail's
 * All tasks | Board, 2026-11-12; the Status tabs and the Team view it replaced are gone). All tasks
 * is one list of sections (Watching, Needs you, Working, Waiting / snoozed, Not started, Completed),
 * each folding on its heading; Waiting / snoozed, Not started and Completed start folded. Specs
 * reach them through these, not through the Chat / Team / Board tabs that are gone.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** A section of All tasks, by its tab (watching | needs | working | waiting | notstarted | done). */
export type OrgSectionTab = 'watching' | 'needs' | 'working' | 'waiting' | 'notstarted' | 'done'

/** The side bar on Tasks. A Main or lead node opens on its Threads (2026-11-04); a click that lands
 *  while the picked node is still coming in is tried again. */
export async function showTasks(scope: Page | Locator): Promise<void> {
  await expect(async () => {
    await scope.getByTestId('org-top-task').click()
    await expect(scope.getByTestId('org-top')).toHaveAttribute('data-view', 'task', { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

/** The side bar's Tasks, drawn as every task in one list or as the lead's Board. */
export async function openTasksBy(scope: Page | Locator, mode: 'all' | 'board'): Promise<void> {
  const toggle = scope.getByTestId('org-rail-toggle')
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click()
  await showTasks(scope)
  // A node with no Board draws no switch (All tasks is its only way); a Board is clicked to.
  await expect(async () => {
    const view = scope.getByTestId('org-task-view')
    if (await view.getAttribute('data-mode') !== mode) await scope.getByTestId(`org-task-mode-${mode}`).click({ timeout: 2_000 })
    await expect(view).toHaveAttribute('data-mode', mode, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

/** One section of All tasks (present only while it has something in it). */
export const taskSection = (scope: Page | Locator, tab: OrgSectionTab): Locator =>
  scope.locator(`[data-testid="org-task-section"][data-tab="${tab}"]`)

/** A section's count, read from its heading. */
export const sectionCount = (scope: Page | Locator, tab: OrgSectionTab): Locator =>
  taskSection(scope, tab).getByTestId('org-task-section-head').locator('.org-task-section-count')

/** Opens a section of All tasks (a click on its heading when it is folded). */
export async function openSection(scope: Page | Locator, tab: OrgSectionTab): Promise<void> {
  const section = taskSection(scope, tab)
  await expect(section).toBeVisible({ timeout: 30_000 })
  if (await section.getAttribute('data-open') === '0') await section.getByTestId('org-task-section-head').click()
  await expect(section).toHaveAttribute('data-open', '1')
}

/** Opens every section All tasks shows, so every task row is on screen. */
export async function openAllSections(scope: Page | Locator): Promise<void> {
  const sections = scope.getByTestId('org-task-section')
  await expect(sections.first()).toBeVisible({ timeout: 30_000 })
  for (const tab of await sections.evaluateAll((els) => els.map((el) => el.getAttribute('data-tab') ?? ''))) {
    await openSection(scope, tab as OrgSectionTab)
  }
}

/** A task's row in All tasks, in any section, or in the one named. */
export const taskRow = (scope: Page | Locator, taskId: string, tab?: OrgSectionTab): Locator =>
  (tab ? scope.locator(`[data-testid="org-task-list"][data-tab="${tab}"]`) : scope)
    .locator(`[data-testid="org-task-row"][data-task-id="${taskId}"]`)

/** What clicks a task in All tasks: its row, or the link on its card under Needs you (a task with
 *  an ask is drawn as a card, whatever else it is). */
export const taskOpener = (scope: Page | Locator, taskId: string): Locator =>
  scope.locator(`[data-testid="org-task-row"][data-task-id="${taskId}"], [data-testid="org-alert"][data-task-id="${taskId}"] [data-testid="org-alert-link"]`).first()

/** Clicks a task in the side bar's All tasks, wherever its state draws it (every section opened
 *  first). A task reference: it opens on Home (useOpenTask, 2026-11-13), so the Org page goes. */
export async function clickTaskInRail(page: Page, taskId: string): Promise<void> {
  await openTasksBy(page, 'all')
  await openAllSections(page)
  await taskOpener(page, taskId).click()
}

/** Opens a task (or a session) in the panel beside the Org page through the page's own place in
 *  the URL (`open=task:<id>` / `open=session:<sid>`), in-app as the router navigates, no reload.
 *  A task reference (a row, a chip) no longer opens there, it opens on Home (useOpenTask,
 *  2026-11-13); what still does is a letter's Answer, a session a chat names, a taskbar chip and a
 *  reload of the page, so a spec of the panel itself (its lock, its strip, its layout) opens it so. */
export async function openBeside(page: Page, target: `task:${string}` | `session:${string}`): Promise<void> {
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  await page.evaluate((t) => {
    const url = new URL(window.location.href)
    url.searchParams.set('open', t)
    window.history.pushState({}, '', `${url.pathname}${url.search}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, target)
  await expect(page.getByTestId('org-side').first()).toBeVisible({ timeout: 30_000 })
}

/** The node's chat (or the way to start one) is on screen. */
export async function expectChatShown(scope: Page | Locator): Promise<void> {
  await expect(scope.locator('[data-testid="org-chat"], [data-testid="org-chat-start"]').first()).toBeVisible({ timeout: 30_000 })
}
