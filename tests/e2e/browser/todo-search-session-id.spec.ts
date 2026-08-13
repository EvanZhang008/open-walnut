import { expect, test } from '@playwright/test';

const TARGET_TASK_ID = 'pw-task-001';

test('reciprocal-rank semantic results are not labeled less relevant', async ({ page }) => {
  const query = 'reciprocal rank results';
  await page.route('**/api/search?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== query) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            type: 'task',
            taskId: TARGET_TASK_ID,
            title: 'Playwright test task',
            snippet: query,
            score: 1,
            matchField: 'task',
          },
          {
            type: 'task',
            taskId: 'pw-task-local',
            title: 'Local only task',
            snippet: query,
            score: 0.5,
            matchField: 'task',
          },
          {
            type: 'task',
            taskId: 'pw-task-in-progress',
            title: 'In-progress task',
            snippet: query,
            score: 1 / 3,
            matchField: 'task',
          },
        ],
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();
  await page.locator('.todo-search-input').fill(query);

  await expect(page.locator(
    '.todo-search-results .todo-panel-item[data-task-id="pw-task-in-progress"]',
  )).toBeVisible({ timeout: 3_000 });
  await expect(page.locator('.todo-search-spinner')).toBeHidden();
  await expect(page.locator('.search-relevance-divider')).toHaveCount(0);
  await expect(page.getByText('Less relevant', { exact: true })).toHaveCount(0);
  await expect(page.locator('.todo-search-score-pill')).toHaveCount(0);
});

test('a stale semantic response cannot replace a newer query', async ({ page }) => {
  const firstQuery = 'first semantic query';
  const secondQuery = 'second semantic query';

  // Fault injection: make cancellation ineffective. Both the fetch and the
  // controller's `signal.aborted` check stay false, so only the generation
  // guard can reject the stale first response.
  await page.addInitScript(() => {
    const NativeAbortController = window.AbortController;
    window.AbortController = class extends NativeAbortController {
      override abort(): void {
        // Deliberately ignored for stale-response fault injection.
      }
    };
  });

  await page.route('**/api/search?**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query !== firstQuery && query !== secondQuery) {
      await route.continue();
      return;
    }

    // The old response lands inside the new query's 500ms request-debounce
    // window. Generation invalidation must happen on the keystroke, not when
    // the second HTTP request eventually starts.
    await new Promise((resolve) =>
      setTimeout(resolve, query === firstQuery ? 250 : 50));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [{
          type: 'task',
          taskId: query === firstQuery ? TARGET_TASK_ID : 'pw-task-local',
          title: query === firstQuery
            ? 'Playwright test task'
            : 'Local only task',
          snippet: query,
          score: 0.8,
          matchField: 'task',
        }],
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();

  const searchInput = page.locator('.todo-search-input');
  const firstRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/search'
      && url.searchParams.get('q') === firstQuery;
  });
  await searchInput.fill(firstQuery);
  await firstRequest;

  await searchInput.fill(secondQuery);
  await page.waitForTimeout(350);
  await expect(page.locator(
    `.todo-search-results .todo-panel-item[data-task-id="${TARGET_TASK_ID}"]`,
  )).toBeHidden();
  await expect(searchInput).toHaveValue(secondQuery);

  const newerResult = page.locator(
    '.todo-search-results .todo-panel-item[data-task-id="pw-task-local"]',
  );
  await expect(newerResult).toBeVisible({ timeout: 3_000 });

  // The older route resolves last. It must not overwrite the second result.
  await page.waitForTimeout(300);
  await expect(newerResult).toBeVisible();
  await expect(page.locator(
    `.todo-search-results .todo-panel-item[data-task-id="${TARGET_TASK_ID}"]`,
  )).toBeHidden();
  await expect(searchInput).toHaveValue(secondQuery);

  await newerResult.getByRole('button', { name: 'More actions' }).click();
  // The kebab dropdown portals to <body> (escapes clipping ancestors), so the
  // Details entry is NOT inside the row's subtree — locate it via the menu.
  await page.locator('.task-kebab-menu').getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.locator('.task-detail-modal .todo-detail-title'))
    .toHaveText('Local only task');
  await expect(searchInput).toHaveValue(secondQuery);
});
