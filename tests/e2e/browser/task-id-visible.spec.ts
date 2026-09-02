/**
 * Both halves of "which card is mtjpcnzl-d230?":
 *
 *   1. the task detail view SHOWS the id, copyable by click and selectable as
 *      text (people paste ids into terminals, so a copy button alone is not it);
 *   2. that same id, typed back into search, returns that task as the top hit —
 *      including the decorated forms an id actually arrives in.
 *
 * Nothing is stubbed: the real server's id lane answers these. The task is
 * created through the API so the id under test is a REAL generated one
 * (`<base36 ms>-<4 hex>`), not a hand-written fixture string.
 *
 * The fixture runs with WALNUT_DISABLE_SEARCH=1, so the ranked legs here are the
 * in-process BM25 fallback — which is why the BACKTICKED query is the
 * load-bearing case: BM25 scores the whole decorated string as one term and
 * matches nothing, so a hit there can only come from the id lane.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const SHOTS = '/tmp/task-id-visible';

/** `animations: 'disabled'` — the modal fades in, and an un-frozen shot catches
 *  it half-transparent, which is unreviewable. */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title, project: 'Task Id Visibility', source: 'local' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { task: { id: string } };
  return body.task.id;
}

/**
 * The ✦ AI search lane is unavailable in the fixture (503) and its error toast
 * would sit on top of every screenshot. Off before first paint; the instant lane
 * under test is a different component.
 */
async function openHome(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('open-walnut-agent-search', '0'));
  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();
}

/**
 * Open a task's detail modal the way a user does: find the row (by TITLE, so
 * the id half is not assumed), then row kebab → Details.
 */
async function openDetail(page: Page, title: string): Promise<void> {
  await search(page, title);
  const row = page.locator('.todo-search-results .todo-panel-item').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: 'More actions' }).click();
  // The kebab dropdown portals to <body>, so it is not inside the row subtree.
  await page.locator('.task-kebab-menu')
    .getByRole('button', { name: 'Details', exact: true })
    .click();
  await expect(page.locator('.task-detail-modal .todo-detail-title')).toHaveText(title);
}

async function search(page: Page, query: string): Promise<void> {
  const input = page.locator('.todo-search-input');
  await input.fill('');
  await input.fill(query);
  // The server lane is debounced 500ms; wait for the request it produces.
  await page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/search' && url.searchParams.get('q') === query;
  }, { timeout: 15_000 });
  await expect(page.locator('.todo-search-spinner')).toBeHidden({ timeout: 20_000 });
}

function resultRows(page: Page) {
  return page.locator('.todo-search-results .todo-panel-item');
}

test('the detail view shows the task id, copyable by click and selectable as text', async ({ page, context, request }) => {
  const title = `Id chip task ${Date.now()}`;
  const taskId = await createTask(request, title);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await openHome(page);
  await openDetail(page, title);

  const chip = page.locator('.task-detail-modal [data-testid="copyable-id"]');
  const value = chip.locator('.copyable-id-value');
  await expect(chip).toBeVisible();
  // The id is READ OFF THE SCREEN and must be the real, whole id.
  await expect(value).toHaveText(taskId);
  await shot(page, '01-detail-shows-id');

  await value.click();
  await expect(chip.locator('.copyable-id-status')).toHaveText('Copied');
  await shot(page, '02-copied-confirmation');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(taskId);

  // Selectable text, not only a button: the click also selects the whole id
  // (user-select: all), so Cmd+C works for a terminal paste.
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(taskId);

  // The confirmation is transient — it must not become permanent chrome.
  await expect(chip.locator('.copyable-id-status')).toHaveText('', { timeout: 5_000 });
});

test('the id read off the detail view finds that task as the top search hit', async ({ page, request }) => {
  const title = `Id search task ${Date.now()}`;
  const taskId = await createTask(request, title);

  await openHome(page);
  await openDetail(page, title);
  const shownId = (await page.locator(
    '.task-detail-modal [data-testid="copyable-id"] .copyable-id-value',
  ).innerText()).trim();
  expect(shownId).toBe(taskId);
  await page.keyboard.press('Escape');
  await expect(page.locator('.task-detail-modal')).toHaveCount(0);

  // 1. the whole id
  await search(page, shownId);
  await expect(resultRows(page).first()).toHaveAttribute('data-task-id', shownId);
  await expect(resultRows(page)).toHaveCount(1);
  await shot(page, '03-search-by-id');

  // 2. the same id wearing backticks — the form an agent's message writes
  await search(page, `\`${shownId}\``);
  await expect(resultRows(page).first()).toHaveAttribute('data-task-id', shownId);
  await shot(page, '04-search-backticked-id');

  // 3. the base36-clock prefix (8 chars), which is all a human remembers
  await search(page, shownId.split('-')[0]);
  await expect(resultRows(page).first()).toHaveAttribute('data-task-id', shownId);
  await shot(page, '05-search-id-prefix');
});

test('an ambiguous prefix returns every match rather than guessing one', async ({ page }) => {
  await openHome(page);

  // 'pw-task-p' prefixes five fixture tasks. Showing all of them is the rule:
  // a confident wrong answer is worse than a list.
  await search(page, 'pw-task-p');
  const ids = await resultRows(page).evaluateAll(
    (rows) => rows.map((r) => r.getAttribute('data-task-id')),
  );
  expect(ids.length).toBeGreaterThan(1);
  expect(ids.every((id) => id?.startsWith('pw-task-p'))).toBe(true);
  await shot(page, '06-ambiguous-prefix');
});
