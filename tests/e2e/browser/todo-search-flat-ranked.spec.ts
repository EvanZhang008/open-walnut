/**
 * Home search is ONE flat ranked list whose literal hits never get replaced
 * (user report 2026-09-23): typing a short token showed the exact title match at
 * once, then the server pass arrived with ~24 loose semantic rows, the list was
 * regrouped by tier and project, and the one row the user wanted was buried.
 *
 * Contract pinned here, with the server lane answering LATE (held until the quick
 * state has been read, then released) so the reported timing actually happens:
 *   - literal hits lead, and the same DOM rows survive the server pass;
 *   - server hits whose snippet shows the query append after them; the rest
 *     (semantic look-alikes) fold into "Related (N)";
 *   - with no literal or evidenced hit, the loose hits are the answer and show directly;
 *   - no Pinned tiers or Projects heading in the All view; under each title, a pinned
 *     hit carries its tier pill and every row its project label;
 *   - the search box keeps the caret through all of it, including a task refetch
 *     pushed by the server mid-typing.
 */
import { expect, test } from './shortcut-test-fixture';
import { type APIRequestContext, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';

const PROJECT = 'Marina Dockside Operations';
const SERVER_DELAY_MS = 700;

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', { data: { title, source: 'local', project: PROJECT } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { task: { id: string } }).task.id;
}

async function pinTask(request: APIRequestContext, taskId: string, tier: 'focus' | 'wait'): Promise<void> {
  expect((await request.post(`/api/focus/tasks/${taskId}`)).ok()).toBe(true);
  expect((await request.put(`/api/focus/tasks/${taskId}/tier`, { data: { tier } })).ok()).toBe(true);
}

/** A server row; `snippet` carries (or not) the typed text as evidence. */
type Scored = { taskId: string; score: number; snippet?: string };

/**
 * Answer the server lane late, with the given ranked rows for this query only.
 * Returns a release(): until it is called the answer is held (after a real-looking
 * latency either way), so a loaded machine can never skip past the quick state.
 */
async function routeSearch(page: Page, byQuery: Record<string, Scored[]>, held = false): Promise<() => void> {
  let release!: () => void;
  const gate = held ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  if (!held) release = () => {};
  await page.route('**/api/search?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
    await gate;
    const rows = (byQuery[q] ?? []).map((r) => ({ type: 'task', title: '', snippet: '', matchField: 'title', ...r }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: rows }) }).catch(() => {});
  });
  return release;
}

const SEARCH = '#home-task-navigation .todo-search-input';
const rowIds = (page: Page) => page.locator('#home-task-navigation .todo-search-results .todo-panel-item')
  .evaluateAll((els) => els.map((el) => el.getAttribute('data-task-id')));
const searchFocused = (page: Page) => page.evaluate((sel) => document.activeElement === document.querySelector(sel), SEARCH);

test('literal hits lead and survive the server pass; loose hits fold into Related', async ({ page, request }) => {
  const token = `qx${Date.now().toString(36).slice(-5)}`;
  const literalPinned = await createTask(request, `Release gate ${token} review`);
  const literalPlain = await createTask(request, `${token} rollout notes`);
  const strong = [await createTask(request, 'Dock schedule loop'), await createTask(request, 'Verify the audit log later')];
  const weak = await Promise.all(Array.from({ length: 6 }, (_, i) => createTask(request, `Loosely related chore ${i} ${Date.now()}`)));
  await pinTask(request, literalPinned, 'wait');
  // New tasks land in Satellite; this one is left unpinned so a row without a pill is covered.
  expect((await request.delete(`/api/focus/tasks/${literalPlain}`)).ok()).toBe(true);
  // ...and it is a CHILD of a server-only hit: when its parent arrives it must not be
  // tucked under it (hidden behind a folded chevron) or moved out of the head.
  expect((await request.patch(`/api/tasks/${literalPlain}`, { data: { parent_task_id: strong[0] } })).ok()).toBe(true);

  await isolateUiPrefs(page);
  const releaseServer = await routeSearch(page, {
    [token]: [
      { taskId: strong[0], score: 0.73, snippet: `...the ${token} rollout waits for the gate...` },
      { taskId: literalPinned, score: 0.05 }, // a quick-lane hit leads whatever the server says
      { taskId: strong[1], score: 0.39, snippet: `...see ${token.toUpperCase()} in the audit...` },
      // Semantic look-alikes scoring ABOVE a real hit: evidence decides, not score.
      ...weak.map((taskId) => ({ taskId, score: 0.5, snippet: 'Loosely related chore' })),
    ],
  }, true);
  await page.goto('/');
  await expect(page.locator('#home-task-navigation .todo-panel')).toBeVisible();

  await page.locator(SEARCH).click();
  await page.keyboard.type(token, { delay: 40 });

  // Quick lane: the literal hits, before the server answers, in the panel's own
  // task order. Whatever that order is, it is the head from now on.
  await expect.poll(async () => [...(await rowIds(page))].sort()).toEqual([literalPinned, literalPlain].sort());
  const head = await rowIds(page);
  await page.locator('#home-task-navigation .todo-search-results .todo-panel-item')
    .evaluateAll((els) => els.forEach((el) => el.setAttribute('data-pw-first-paint', '1')));
  releaseServer();

  // Server lane: strong hits append, weak ones fold; the head never moves and its
  // rows are the same DOM nodes (not re-mounted under the cursor).
  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual([...head, strong[0], strong[1]]);
  await expect(page.locator('#home-task-navigation [data-pw-first-paint="1"]')).toHaveCount(2);
  const related = page.locator('#home-task-navigation .todo-search-related-toggle');
  await expect(related).toHaveText(/Related \(6\)/);
  await expect(page.locator('#home-task-navigation .todo-search-count')).toHaveText('4');
  expect(await searchFocused(page)).toBe(true);

  // Flat: no tier regions, no Projects heading; the pin is a pill, the project a label.
  await expect(page.locator('#home-task-navigation .todo-pinned-section')).toHaveCount(0);
  await expect(page.locator('#home-task-navigation .todo-tasks-header')).toHaveCount(0);
  const pinnedRow = page.locator(`.todo-search-results .todo-panel-item[data-task-id="${literalPinned}"]`);
  await expect(pinnedRow.locator('.todo-search-tier-pill')).toHaveText('Wait');
  await expect(page.locator(`.todo-search-results .todo-panel-item[data-task-id="${literalPlain}"] .todo-search-tier-pill`)).toHaveCount(0);
  const label = pinnedRow.locator('.todo-search-context-pill');
  await expect(label).toHaveAttribute('title', PROJECT);
  // Second line: the title keeps its whole line, and the tier pill + project label sit
  // under it, starting where the title text starts, inside the row.
  await expect(pinnedRow.locator('.todo-item-title-row .todo-search-tier-pill, .todo-item-title-row .todo-search-context-pill')).toHaveCount(0);
  const [titleBox, pillBox, box, rowBox] = await Promise.all([
    pinnedRow.locator('.todo-item-title').boundingBox(),
    pinnedRow.locator('.todo-search-tier-pill').boundingBox(),
    label.boundingBox(),
    pinnedRow.boundingBox(),
  ]);
  expect(pillBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
  expect(Math.abs(pillBox!.x - (titleBox!.x + 2))).toBeLessThan(2.5); // title has 2px inner padding
  expect(Math.abs((box!.y + box!.height / 2) - (pillBox!.y + pillBox!.height / 2))).toBeLessThan(2);
  expect(box!.x).toBeGreaterThan(pillBox!.x + pillBox!.width);
  expect(box!.x + box!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);

  // Related opens in place, after the strong rows, and folds again.
  await related.click();
  await expect.poll(() => rowIds(page)).toEqual([...head, strong[0], strong[1], ...weak]);
  await expect(page.locator('#home-task-navigation .todo-search-count')).toHaveText('10');
  await related.click();
  await expect.poll(() => rowIds(page)).toEqual([...head, strong[0], strong[1]]);

  // A server-pushed refetch mid-search (another writer renames a hit) keeps the caret and the head.
  await page.locator(SEARCH).click();
  await page.keyboard.press('End');
  expect((await request.patch(`/api/tasks/${strong[1]}`, { data: { title: 'Verify the audit log soon' } })).ok()).toBe(true);
  await expect(page.locator(`[data-task-id="${strong[1]}"] .todo-item-title`)).toHaveText('Verify the audit log soon', { timeout: 10_000 });
  expect(await searchFocused(page)).toBe(true);
  expect((await rowIds(page)).slice(0, 2)).toEqual(head);

  // Clearing restores the grouped panel.
  await page.locator('#home-task-navigation .todo-search-clear').click();
  await expect(page.locator('#home-task-navigation .todo-tasks-header')).toHaveCount(1);
});

test('with no literal or strong hit, the loose hits are the answer and show directly', async ({ page, request }) => {
  const token = `zv${Date.now().toString(36).slice(-5)}`;
  const onlyStrong = await createTask(request, `Anchorage paperwork ${Date.now()}`);
  const weak = await Promise.all(Array.from({ length: 3 }, (_, i) => createTask(request, `Faint echo ${i} ${Date.now()}`)));

  await isolateUiPrefs(page);
  await routeSearch(page, {
    [token]: weak.map((taskId) => ({ taskId, score: 0.3, snippet: 'Faint echo' })),
    [`${token}x`]: [
      { taskId: onlyStrong, score: 0.2, snippet: `...filed under ${token}x last week...` },
      ...weak.map((taskId) => ({ taskId, score: 0.3, snippet: 'Faint echo' })),
    ],
  });
  await page.goto('/');
  await expect(page.locator('#home-task-navigation .todo-panel')).toBeVisible();
  await page.locator(SEARCH).click();
  await page.keyboard.type(token, { delay: 40 });

  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual(weak);
  await expect(page.locator('#home-task-navigation .todo-search-related-toggle')).toHaveCount(0);

  // One more character: now there IS a strong hit, so the same loose rows fold.
  await page.keyboard.type('x');
  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual([onlyStrong]);
  await expect(page.locator('#home-task-navigation .todo-search-related-toggle')).toHaveText(/Related \(3\)/);
  expect(await searchFocused(page)).toBe(true);
});

test('focus taken by code while the user types comes back; a click or Tab away does not', async ({ page, request }) => {
  const token = `kf${Date.now().toString(36).slice(-5)}`;
  await createTask(request, `Keep focus ${token} target`);
  await isolateUiPrefs(page);
  await page.goto('/');
  await expect(page.locator('#home-task-navigation .todo-panel')).toBeVisible();
  await page.locator(SEARCH).click();
  await page.keyboard.type(token.slice(0, 3), { delay: 40 });

  // A background mount elsewhere grabs the caret mid-word (the reported symptom).
  await page.evaluate(() => {
    const thief = document.createElement('textarea');
    thief.className = 'pw-focus-thief';
    thief.style.cssText = 'position:fixed;right:24px;bottom:24px;width:160px;height:40px;z-index:2147483647';
    document.body.append(thief);
    thief.focus();
  });
  await expect.poll(() => searchFocused(page)).toBe(true);
  await page.keyboard.type(token.slice(3), { delay: 40 });
  await expect(page.locator(SEARCH)).toHaveValue(token);
  await expect(page.locator('.pw-focus-thief')).toHaveValue('');

  // The user clicking somewhere else is a decision, and sticks.
  await page.locator('.pw-focus-thief').click();
  await page.waitForTimeout(150);
  expect(await searchFocused(page)).toBe(false);

  // So is Tab out of the box.
  await page.locator(SEARCH).click();
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  expect(await searchFocused(page)).toBe(false);
});

test('a completed task is found by its own title: the three latest inline, the rest behind Completed', async ({ page, request }) => {
  // User report 2026-09-23: the query was a done task's exact title, and the list hid it
  // (open-only by default) with nothing on screen saying so. A broad word matches dozens
  // of done titles, though, so only the three most recently completed show inline.
  const token = `dn${Date.now().toString(36).slice(-5)}`;
  const openLiteral = await createTask(request, `${token} open plan`);
  const olderDone = [];
  for (let i = 0; i < 3; i++) olderDone.push(await createTask(request, `${token} old note ${i}`));
  const doneLiteral = await createTask(request, `${token} upgrade across the fleet`);
  const serverOpen = await createTask(request, `Fleet audit ${Date.now()}`);
  const serverDone = await createTask(request, `Fleet retro ${Date.now()}`);
  const looseDone = await createTask(request, `Unrelated chore ${Date.now()}`);
  // Completion order sets recency: olderDone[0] is the oldest, doneLiteral the newest.
  for (const id of [...olderDone, doneLiteral, serverDone, looseDone]) {
    expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
  }

  await isolateUiPrefs(page);
  const releaseServer = await routeSearch(page, {
    [token]: [
      { taskId: looseDone, score: 0.9, snippet: 'Unrelated chore' }, // no evidence: stays out
      { taskId: doneLiteral, score: 0.8 },
      { taskId: serverDone, score: 0.6, snippet: `...the ${token} retro notes...` },
      { taskId: serverOpen, score: 0.5, snippet: `...audit before ${token}...` },
    ],
  }, true);
  await page.goto('/');
  await expect(page.locator('#home-task-navigation .todo-panel')).toBeVisible();
  await page.locator(SEARCH).click();
  await page.keyboard.type(token, { delay: 40 });

  // Quick lane: the open title hit, then the newest three completed ones; the oldest waits.
  const inline = [openLiteral, doneLiteral, olderDone[2], olderDone[1]];
  await expect.poll(() => rowIds(page)).toEqual(inline);
  const doneRow = page.locator(`#home-task-navigation .todo-search-results .todo-panel-item[data-task-id="${doneLiteral}"]`);
  await expect(doneRow.locator('.task-phase-icon-btn')).toHaveAttribute('aria-label', 'Reopen (mark To Do)');
  const completed = page.locator('#home-task-navigation .todo-search-completed-toggle');
  await expect(completed).toHaveText(/Completed \(1\)/);
  releaseServer();

  // Server lane: the open server hit appends; the completed one with evidence joins the
  // fold; the loose completed hit shows nowhere; the literal rows did not move.
  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual([...inline, serverOpen]);
  await expect(completed).toHaveText(/Completed \(2\)/);
  await expect(page.locator('#home-task-navigation .todo-search-related-toggle')).toHaveCount(0);
  await expect(page.locator('#home-task-navigation .todo-search-count')).toHaveText('5');

  await completed.click();
  await expect.poll(() => rowIds(page)).toEqual([...inline, serverOpen, olderDone[0], serverDone]);
  await expect(page.locator('#home-task-navigation .todo-search-count')).toHaveText('7');
  expect(await rowIds(page)).not.toContain(looseDone);
});
