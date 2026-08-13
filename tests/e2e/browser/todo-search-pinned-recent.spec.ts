/**
 * REGRESSION: "the search should also filter the task in pinned area or
 * recent, same as tasks" (user report 2026-08-12, screenshot showed a query
 * filtering the TASKS list to 44 rows while PINNED kept all 55 cards).
 *
 * Search must be ONE lens over the whole panel: when a query is active, the
 * Pinned tiers and the Recent feed show only matching cards, exactly like the
 * main Tasks list — and clearing the query restores every card.
 *
 * Real-user flow: no page.goto for navigation beyond the initial load, no
 * mocked search route (the fixture runs WALNUT_DISABLE_SEARCH=1, so the
 * client-side metadata pass serves the query — the same path production takes
 * while the semantic backend is still responding).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

async function createTask(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title, source: 'local', project: 'Pin Search Spec' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { task: { id: string } };
  return body.task.id;
}

async function pinTask(
  request: APIRequestContext,
  taskId: string,
  tier: 'focus' | 'satellite' | 'wait' = 'focus',
): Promise<void> {
  const pinRes = await request.post(`/api/focus/tasks/${taskId}`);
  expect(pinRes.ok()).toBe(true);
  const tierRes = await request.put(`/api/focus/tasks/${taskId}/tier`, {
    data: { tier },
  });
  expect(tierRes.ok()).toBe(true);
}

test('search filters the Pinned tiers and Recent feed like the Tasks list', async ({ page, request }) => {
  // Unique token so parallel workers' fixture data can never collide.
  const token = `pinsearch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const pinnedMatch = await createTask(request, `Pinned ${token} match`);
  const pinnedMiss = await createTask(request, `Pinned unrelated card ${Date.now()}`);
  const recentMatch = await createTask(request, `Recent ${token} match`);
  const recentMiss = await createTask(request, `Recent unrelated card ${Date.now()}`);
  await pinTask(request, pinnedMatch, 'focus');
  await pinTask(request, pinnedMiss, 'focus');

  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();

  // The stacked All view is the surface from the report — Pinned tiers, Recent,
  // and Tasks mounted together.
  await page.locator('.todo-section-tabs .todo-section-tab-all').click();

  const focusCard = (id: string) => page.locator(`.todo-focus-card[data-task-id="${id}"]`);
  const recentCard = (id: string) =>
    page.locator(`.todo-pinned-list-recent .todo-pinned-card[data-task-id="${id}"]`);

  // Precondition: everything visible before the query — otherwise "hidden after
  // search" proves nothing.
  await expect(focusCard(pinnedMatch)).toBeVisible({ timeout: 10_000 });
  await expect(focusCard(pinnedMiss)).toBeVisible();
  await expect(recentCard(recentMatch)).toBeVisible();
  await expect(recentCard(recentMiss)).toBeVisible();

  await page.locator('.todo-search-input').fill(token);

  // The report's bug: pinned cards ignored the query. Matching cards stay,
  // non-matching cards leave — in BOTH the Focus tier and the Recent feed.
  await expect(focusCard(pinnedMiss)).toHaveCount(0, { timeout: 5_000 });
  await expect(focusCard(pinnedMatch)).toBeVisible();
  await expect(recentCard(recentMiss)).toHaveCount(0);
  await expect(recentCard(recentMatch)).toBeVisible();

  // The main Tasks list agrees with the pinned area (same lens everywhere).
  await expect(page.locator(
    `.todo-search-results .todo-panel-item[data-task-id="${recentMatch}"]`,
  )).toBeVisible();
  await expect(page.locator(
    `.todo-search-results .todo-panel-item[data-task-id="${recentMiss}"]`,
  )).toHaveCount(0);

  // Clearing the query is a full restore — search filters the view, it must
  // never mutate pin membership or the feed.
  await page.locator('.todo-search-clear').click();
  await expect(focusCard(pinnedMiss)).toBeVisible({ timeout: 5_000 });
  await expect(focusCard(pinnedMatch)).toBeVisible();
  await expect(recentCard(recentMiss)).toBeVisible();
});
