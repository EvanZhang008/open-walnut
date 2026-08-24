/**
 * REGRESSION: "the search in the task doesn't include the future task,
 * but I think the search should ignore all the filters." (user report 2026-08-09)
 *
 * The Date filter DEFAULTS to "Now", which hides any task whose start_date is
 * still in the future. Search used to intersect its results with that filter,
 * so a deferred task was unfindable by its exact title — the panel answered
 * "No tasks match" for a task that plainly exists.
 *
 * Pinned here, as a real user would see it (no page.goto for navigation, no
 * mocked search route — the fixture runs with WALNUT_DISABLE_SEARCH=1 so the
 * client-side metadata pass is what serves these queries, exactly like the
 * server-down path in production):
 *   1. a future-start task is findable while Date = Now (the reported bug),
 *   2. a completed task is findable too (search ignores "Show completed"),
 *   3. the OPEN hit ranks before the completed one (rankOpenTasksFirst), so a
 *      history-heavy store can't push live work past the 40-row render cap,
 *   4. clearing the query restores the filtered view — search must not leak
 *      its filter bypass into the normal list.
 */
import { expect, test } from '@playwright/test';

const DEFERRED = '.todo-search-results .todo-panel-item[data-task-id="pw-task-deferred"]';
const DONE = '.todo-search-results .todo-panel-item[data-task-id="pw-task-done-marmalade"]';

test('search finds a future-start task that the Now date filter hides', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();

  // Put the panel in the state the bug needs: Date = Now (the shipped default,
  // but localStorage may carry another value between runs), completed hidden.
  await page.locator('.vd-trigger').click();
  const datePanel = page.locator('.vd-panel');
  await expect(datePanel).toBeVisible();
  // The Date filter renders as direct All/Now buttons in the "Quick filters"
  // rail section (the panel's landing section).
  await datePanel.locator('.vd-rail-btn[data-rail-section="quick"]').click();
  await datePanel.locator('.vd-seg-btn[data-date-value="now"]').click();
  const showCompleted = datePanel.locator('.vd-check input[type="checkbox"]');
  if (await showCompleted.isChecked()) await showCompleted.uncheck();
  await page.keyboard.press('Escape');
  await expect(datePanel).toBeHidden();

  // Precondition: the deferred task is genuinely NOT in the plain list. If this
  // fails the fixture stopped being deferred and the rest proves nothing.
  await expect(page.locator('.todo-panel-item[data-task-id="pw-task-deferred"]')).toHaveCount(0);

  await page.locator('.todo-search-input').fill('marmalade');

  // The bug: this was 0 results.
  await expect(page.locator(DEFERRED)).toBeVisible({ timeout: 5_000 });
  // Search also ignores "Show completed".
  await expect(page.locator(DONE)).toBeVisible();

  // Open before done — otherwise history buries live work past the render cap.
  const orderedIds = await page.locator('.todo-search-results .todo-panel-item')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-id')));
  expect(orderedIds.indexOf('pw-task-deferred'))
    .toBeLessThan(orderedIds.indexOf('pw-task-done-marmalade'));

  // The row explains itself: the deferred-start pill says WHY it isn't in the list.
  await expect(page.locator(`${DEFERRED} .todo-item-start-pill`)).toBeVisible();

  // Clearing the query must restore the filtered view — the bypass is
  // search-scoped, not a permanent filter reset.
  await page.locator('.todo-search-clear').click();
  await expect(page.locator('.todo-panel-item[data-task-id="pw-task-deferred"]')).toHaveCount(0);
  await expect(page.locator('.todo-panel-item[data-task-id="pw-task-done-marmalade"]')).toHaveCount(0);
});

test('search ignores the phase filter too', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();

  // 'Local only task' is TODO; filter Phase to Complete so it is excluded from
  // the list. Same class of bug as the date filter. (This leg used the Priority
  // then Tag selects until 2026-08-23, when both were retired from Quick
  // filters — Phase is the remaining legacy control of that class.)
  await page.locator('.vd-trigger').click();
  const panel = page.locator('.vd-panel');
  await expect(panel).toBeVisible();
  // Legacy controls render as buttons in the "Quick filters" rail section.
  await panel.locator('.vd-rail-btn[data-rail-section="quick"]').click();
  await panel.locator('.vd-seg-btn[data-phase-value="COMPLETE"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await expect(page.locator('.todo-panel-item[data-task-id="pw-task-local"]')).toHaveCount(0);

  await page.locator('.todo-search-input').fill('Local only task');
  await expect(page.locator(
    '.todo-search-results .todo-panel-item[data-task-id="pw-task-local"]',
  )).toBeVisible({ timeout: 5_000 });
});
