/**
 * Search and the filter chips (spec 5.7, D11; checklist C21, C56).
 *
 * REGRESSION origin: "the search in the task doesn't include the future task"
 * (user report 2026-08-09). The Date filter DEFAULTS to Available now, which
 * hides any task whose start date is still in the future, so a deferred task
 * was unfindable by its exact title.
 *
 * The rule now: search honors every chip the user ADDED and bypasses only the
 * defaults nobody chose (Status open, Date Available now). The filter row stays
 * fully opaque while searching, says `Search uses these filters`, counts the
 * search hits, and carries `Include Complete (N)` while Status is the default.
 *
 * The fixture runs with WALNUT_DISABLE_SEARCH=1, so the client-side metadata
 * pass serves these queries (the server-down path in production).
 */
import { expect, test, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { openHome } from './home-navigation-helpers';
import { addFilter, filterChip, filterRow, removeFilterChip, setStatus, displayButton } from './filter-bar-helpers';
import { stubBoard, type Seed } from './filter-bar-fixtures';

const hit = (page: Page, id: string) => page.locator(`.todo-search-results .todo-panel-item[data-task-id="${id}"]`);
const DEFERRED = 'pw-task-deferred';
const DONE = 'pw-task-done-marmalade';
const LOCAL = 'pw-task-local';
const STALE = 'pw-tq-other-project-stale';

test.setTimeout(120_000);

/** `wide`: a panel wide enough that the filter row never folds a chip behind `+N`. */
async function boot(page: Page, baseURL: string, quickViews = true, wide = false): Promise<void> {
  await isolateUiPrefs(page);
  await page.addInitScript(([qv, w]) => {
    try {
      if (sessionStorage.getItem('pw-search-seeded')) return;
      sessionStorage.setItem('pw-search-seeded', '1');
      localStorage.setItem('walnut-todo-quick-views-visible', qv ? 'true' : 'false');
      if (w) localStorage.setItem('open-walnut-todo-width', '45');
    } catch { /* ignore */ }
  }, [quickViews, wide] as const);
  await openHome(page, baseURL, 90_000);
  await expect(displayButton(page)).toBeVisible();
}

async function search(page: Page, text: string): Promise<void> {
  await page.locator('.todo-search-input').fill(text);
}

test('search finds a future-start task that the Now date filter hides', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  // Precondition: the default Date hides the deferred task from the plain list.
  await expect(page.locator(`.todo-panel-item[data-task-id="${DEFERRED}"]`)).toHaveCount(0);
  await search(page, 'marmalade');
  await expect(hit(page, DEFERRED)).toBeVisible({ timeout: 10_000 });
  // The typed text keeps room beside Filter and Display: on a narrow toolbar the
  // field's own count folds away (the filter row carries it) and so does the
  // New task label, until the query is cleared.
  expect((await page.locator('.todo-search-input').boundingBox())?.width ?? 0).toBeGreaterThan(40);
  await page.locator('.todo-panel-toolbar').screenshot({ path: `/tmp/filterbar/shots/search-narrow-toolbar-${test.info().project.name}.png` });
  await expect(page.getByTestId('filter-count')).toBeVisible();
  // The default Status is bypassed too: a completed title hit is findable.
  await expect(hit(page, DONE)).toBeVisible();
  await expect(page.locator(`.todo-search-results .todo-panel-item[data-task-id="${DEFERRED}"] .todo-item-start-pill`)).toBeVisible();
  // Clearing the query restores the filtered view: the bypass is search-scoped.
  await page.locator('.todo-search-clear').click();
  await expect(page.locator(`.todo-panel-item[data-task-id="${DEFERRED}"]`)).toHaveCount(0);
  await expect(page.locator(`.todo-panel-item[data-task-id="${DONE}"]`)).toHaveCount(0);
  // An empty query gives New task its label back.
  await expect(page.locator('.todo-panel-toolbar .new-launcher-label')).toBeVisible();
});

test('search honors a Status chip the user added', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await setStatus(page, ['Complete']);
  await search(page, 'marmalade');
  await expect(hit(page, DONE)).toBeVisible({ timeout: 10_000 });
  await expect(hit(page, DEFERRED)).toHaveCount(0);
  // The row says so, stays opaque, and counts the search hits.
  const rowEl = filterRow(page);
  await expect(rowEl).toContainText('Search uses these filters');
  expect(await rowEl.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const shown = await page.locator('.todo-search-results .todo-panel-item[data-task-id]').count();
  await expect(page.getByTestId('filter-count')).toHaveText(`${shown} ${shown === 1 ? 'task' : 'tasks'}`);
  // No Include Complete toggle while a Status chip decides.
  await expect(rowEl.getByRole('button', { name: /^Include Complete/ })).toHaveCount(0);
});

/** The fixture board has one source, so the Source case runs on a stubbed board of two. */
const SOURCE_BOARD: Seed[] = [
  { id: 'sf-quince-local', title: 'Quince jam local', project: 'Pantry' },
  { id: 'sf-quince-synced', title: 'Quince jam synced', project: 'Pantry', source: 'ms-todo' },
]

/** One test per chip kind: the chip the user added still narrows the search. */
const CHIP_CASES: { name: string; dim: Parameters<typeof addFilter>[1]; value: string; query: string; hidden: string; kept?: { query: string; id: string }; stub?: Seed[] }[] = [
  { name: 'Project', dim: 'project', value: 'Meadow', query: 'Local only task', hidden: LOCAL, kept: { query: 'tq other project stale', id: STALE } },
  { name: 'Source', dim: 'source', value: 'Local', query: 'Quince jam synced', hidden: 'sf-quince-synced', kept: { query: 'Quince jam local', id: 'sf-quince-local' }, stub: SOURCE_BOARD },
  { name: 'Tag', dim: 'tags', value: 'oncall', query: 'Local only task', hidden: LOCAL },
  { name: 'Blocked', dim: 'blocked', value: 'Blocked', query: 'Local only task', hidden: LOCAL },
  { name: 'Time window', dim: 'time', value: '7d', query: 'tq other project stale', hidden: STALE, kept: { query: 'Local only task', id: LOCAL } },
  { name: 'Date: Overdue', dim: 'date', value: 'overdue', query: 'Local only task', hidden: LOCAL },
];

for (const c of CHIP_CASES) {
  test(`search honors a ${c.name} chip the user added`, async ({ page, baseURL }) => {
    if (c.stub) await stubBoard(page, c.stub);
    await boot(page, baseURL!, true, true);
    // Without the chip the task is findable (the precondition).
    await search(page, c.query);
    await expect(hit(page, c.hidden)).toBeVisible({ timeout: 10_000 });
    await page.locator('.todo-search-clear').click();
    await addFilter(page, c.dim, c.value);
    await expect(filterChip(page, c.dim === 'tags' ? 'tags' : c.dim)).toHaveCount(1);
    await search(page, c.query);
    if (c.kept) {
      await page.locator('.todo-search-input').fill(c.kept.query);
      await expect(hit(page, c.kept.id)).toBeVisible({ timeout: 10_000 });
      await page.locator('.todo-search-input').fill(c.query);
    }
    // The search answered (hits, or its own empty state), and the hidden task is not in it.
    await expect(page.locator('.todo-search-results, .empty-state:has-text("match")').first()).toBeVisible({ timeout: 10_000 });
    await expect(hit(page, c.hidden)).toHaveCount(0);
    await expect(filterRow(page)).toContainText('Search uses these filters');
    // Removing the chip brings it back inside the same search.
    await removeFilterChip(page, c.dim);
    await expect(hit(page, c.hidden)).toBeVisible({ timeout: 10_000 });
  });
}

test('with the tab bar hidden, Include Complete lives in the filter row (C56)', async ({ page, baseURL }) => {
  await boot(page, baseURL!, false);
  await search(page, 'marmalade');
  await expect(hit(page, DEFERRED)).toBeVisible({ timeout: 10_000 });
  const toggle = filterRow(page).getByRole('button', { name: /^Include Complete/ });
  // The inline window shows a done title hit already; the toggle reveals the rest.
  if (await toggle.count()) {
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(hit(page, DONE)).toBeVisible();
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
});
