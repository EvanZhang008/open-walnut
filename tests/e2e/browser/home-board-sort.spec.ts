import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { discoverBrowserFixture } from './codex-test-audit';
import { kanbanApi, startSession } from './board-kanban-fixture';

// The board's Sort mode and its Move menu's snooze and done rows (2026-11-07, the user: "so many
// task ... not easy to quick sort"): every decision is one tap, writes the task, and can be undone.
const project = `Sort acceptance ${Date.now().toString(36)}`;
const other = `${project} beta`;
const made: string[] = [];
async function create(request: APIRequestContext, title: string, fields: Record<string, unknown> = {}) {
  const response = await request.post('/api/tasks', { data: { title, project, source: 'local', pinned: false, ...fields } });
  expect(response.ok(), await response.text()).toBe(true);
  const task = (await response.json()).task;
  made.push(task.id);
  return task.id as string;
}
const read = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/tasks/${id}`)).json()).task;
const tierOf = (t: { pinned?: boolean; focus_tier?: string }) => !t.pinned ? 'unpinned' : t.focus_tier ?? 'satellite';

/** Opens Sort on these tiers ([] = every tier); the filter is kept, so every test sets its own. */
async function open(page: Page, search: string, tiers: string[] = ['unpinned']) {
  await isolateUiPrefs(page);
  await page.setContent(`<a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click();
  // The first open of a run waits on Vite's cold transform of the whole app.
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await expect(page.getByTestId('home-board')).toBeVisible();
  await page.getByTestId('home-board').getByRole('button', { name: 'Sort', exact: true }).click();
  await expect(page.getByTestId('quick-sort')).toBeVisible();
  await setTiers(page, tiers);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(search);
}
async function setTiers(page: Page, tiers: string[]) {
  const filter = page.getByTestId('quick-sort-filter');
  await filter.locator('[data-sort-filter-tier=""]').click();
  for (const tier of tiers) await filter.locator(`[data-sort-filter-tier="${tier}"]`).click();
}
async function pickProject(page: Page, name: string) {
  await page.getByTestId('quick-sort-filter').locator('[data-sort-filter="project"]').click();
  await page.getByRole('listbox', { name: 'Sort which project' }).getByRole('option', { name, exact: true }).click();
}
const sortCard = (page: Page, id: string) => page.locator(`[data-sort-card="${id}"]`);

const ids = { old: '', lead: '', child: '', mid: '', young: '', pinned: '', b1: '', b2: '' };
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);
test.beforeAll(async ({ request }) => {
  // Created oldest first: the queue shows the least recently touched first.
  ids.old = await create(request, 'Sort oldest task');
  ids.lead = await create(request, 'Sort leader');
  ids.child = await create(request, 'Sort leader child', { parent_task_id: ids.lead });
  ids.mid = await create(request, 'Sort middle task');
  ids.young = await create(request, 'Sort newest task');
  ids.pinned = await create(request, 'Sort already pinned', { pinned: true, focus_tier: 'focus' });
  ids.b1 = await create(request, 'Sort beta one', { project: other });
  ids.b2 = await create(request, 'Sort beta two', { project: other });
});
test.afterAll(async ({ request }) => { for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`); });

test('three cards at a time; a tier tap, Undo, a snooze, done, skip and keys each write once', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, project);
  const sort = page.getByTestId('quick-sort');
  const cards = sort.locator('[data-sort-card]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute('data-sort-card', ids.old);
  await expect(cards.nth(1)).toHaveAttribute('data-sort-card', ids.lead);
  await expect(sortCard(page, ids.lead)).toContainText('1 subtask moves with it');
  await expect(sortCard(page, ids.child)).toHaveCount(0);
  await expect(sortCard(page, ids.pinned)).toHaveCount(0);
  await expect(page.getByTestId('quick-sort-left')).toHaveText('6 left');

  // A tier: the leader and its subtask move together; Undo puts both back.
  await sortCard(page, ids.lead).locator('[data-sort-tier="focus"]').click();
  await expect(sortCard(page, ids.lead)).toHaveCount(0);
  for (const id of [ids.lead, ids.child]) await expect.poll(async () => tierOf(await read(request, id))).toBe('focus');
  await expect(sort.locator('.quick-sort-toast')).toContainText('Moved "Sort leader" to Focus');
  await expect(sort).toContainText('1 sorted this round');
  await sort.getByRole('button', { name: 'Undo', exact: true }).click();
  for (const id of [ids.lead, ids.child]) await expect.poll(async () => tierOf(await read(request, id))).toBe('unpinned');
  await expect(sortCard(page, ids.lead)).toBeVisible();
  await expect(sort).toContainText('0 sorted this round');

  // Snooze a preset; Escape on the flyout closes it, not the board.
  await sortCard(page, ids.old).locator('[data-sort-action="snooze"]').click();
  const flyout = page.getByRole('dialog', { name: 'Snooze until', exact: true });
  await expect(flyout).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(flyout).toHaveCount(0);
  await expect(page.getByTestId('home-board')).toBeVisible();
  await sortCard(page, ids.old).locator('[data-sort-action="snooze"]').click();
  await flyout.locator('[data-snooze="tomorrow"]').click();
  await expect(sortCard(page, ids.old)).toHaveCount(0);
  await expect.poll(async () => Date.parse((await read(request, ids.old)).start_date ?? '') > Date.now()).toBe(true);

  // Snooze to a picked day: its own calendar flyout.
  await sortCard(page, ids.mid).locator('[data-sort-action="snooze"]').click();
  await flyout.locator('[data-snooze="pick"]').click();
  const calendar = page.getByRole('dialog', { name: 'Snooze until a date', exact: true });
  await expect(calendar).toBeVisible();
  const day = await calendar.locator('.dp-pill[data-date]').nth(2).getAttribute('data-date');
  await calendar.locator(`.dp-pill[data-date="${day}"]`).click();
  await expect(calendar).toHaveCount(0);
  await expect.poll(async () => (await read(request, ids.mid)).start_date).toBe(day);

  // Done, then Undo by key (⌘Z / Ctrl+Z) reopens it.
  await expect(page.getByTestId('quick-sort-left')).toHaveText('4 left');
  await sortCard(page, ids.young).locator('[data-sort-action="done"]').click();
  await expect(page.getByTestId('quick-sort-left')).toHaveText('3 left');
  await expect.poll(async () => (await read(request, ids.young)).phase).toBe('COMPLETE');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await read(request, ids.young)).phase).not.toBe('COMPLETE');
  // Back in the queue, now the most recently touched: fourth, under the three shown.
  await expect(page.getByTestId('quick-sort-left')).toHaveText('4 left');

  // Keys act on the highlighted card: the arrows pick it, a digit picks a tier, X skips.
  await page.getByTestId('quick-sort').locator('.quick-sort-progress-text').click();
  const first = await cards.nth(0).getAttribute('data-sort-card');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(cards.nth(0)).toHaveClass(/is-current/);
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toHaveClass(/is-current/);
  const second = await cards.nth(1).getAttribute('data-sort-card');
  await page.keyboard.press('2');
  await expect.poll(async () => tierOf(await read(request, second!))).toBe('satellite');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('x');
  await expect(sortCard(page, first!)).toHaveCount(0);
  expect(tierOf(await read(request, first!))).toBe('unpinned');
  await expect(sort.getByTestId('quick-sort-tally')).toContainText('Satellite 1');
  await expect(sort.getByTestId('quick-sort-tally')).toContainText('Snoozed 2');

  // On another page the board's keys are off: a digit there moves nothing.
  const still = await cards.nth(0).getAttribute('data-sort-card');
  await page.getByTestId('sidebar-org').click();
  await expect(page.getByTestId('home-board')).toBeHidden();
  await page.keyboard.press('1');
  await page.getByTestId('sidebar-core-app-home').click();
  await expect(page.getByTestId('quick-sort')).toBeVisible();
  expect(tierOf(await read(request, still!))).toBe('unpinned');
});

test('projects: a whole project to one tier, its own queue, and the view is kept across a reload', async ({ page, request }) => {
  const before = { b1: tierOf(await read(request, ids.b1)), b2: tierOf(await read(request, ids.b2)) };
  await open(page, other);
  const sort = page.getByTestId('quick-sort');
  await sort.getByRole('button', { name: 'Projects', exact: true }).click();
  const card = page.locator(`[data-sort-project="${other.toLowerCase()}"]`);
  await expect(card).toContainText('Project · 2 open');
  await expect(card).toContainText('Sort beta one');
  await card.locator('[data-sort-tier="wait"]').click();
  for (const id of [ids.b1, ids.b2]) await expect.poll(async () => tierOf(await read(request, id))).toBe('wait');
  // Undo puts each task back in the tier it had, which differ (the first test moved one).
  await sort.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => tierOf(await read(request, ids.b1))).toBe(before.b1);
  await expect.poll(async () => tierOf(await read(request, ids.b2))).toBe(before.b2);
  await card.locator('[data-sort-action="tasks"]').click();
  await expect(sort).toHaveAttribute('data-view', 'tasks');
  const projectPick = sort.locator('[data-sort-filter="project"]');
  await expect(projectPick).toHaveText(`${other} ▾`);
  // A project's own tasks, every tier of it.
  await expect(sort.locator('[data-sort-filter-tier=""]')).toHaveAttribute('aria-pressed', 'true');
  await expect(sort.locator('[data-sort-card]')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('home-board')).toHaveAttribute('data-mode', 'sort');
  await expect(page.getByTestId('quick-sort').locator('[data-sort-filter="project"]')).toHaveText(`${other} ▾`);
  await pickProject(page, 'All projects');
  await expect(page.getByTestId('quick-sort').locator('[data-sort-filter="project"]')).toHaveText('All projects ▾');
});

test('the pin board Move menu snoozes, clears a snooze and marks done', async ({ page, request }) => {
  const id = await create(request, 'Sort move menu task', { pinned: true, focus_tier: 'satellite' });
  await open(page, 'Sort move menu task');
  await page.getByTestId('home-board').getByRole('button', { name: 'By pin', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move Sort move menu task to pin tier', exact: true });
  await move.click();
  const menu = page.getByRole('listbox', { name: 'Move to pin tier' });
  await menu.locator('[data-snooze="next-week"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => Date.parse((await read(request, id)).start_date ?? '') > Date.now()).toBe(true);
  await expect(page.locator(`[data-board-task="${id}"] [data-board-snoozed]`)).toContainText('until');
  expect(tierOf(await read(request, id))).toBe('satellite');
  await move.click();
  await menu.locator('[data-snooze="clear"]').click();
  await expect.poll(async () => (await read(request, id)).start_date ?? '').toBe('');
  await expect(page.locator(`[data-board-task="${id}"] [data-board-snoozed]`)).toHaveCount(0);
  await move.click();
  await menu.locator('[data-board-done]').click();
  await expect.poll(async () => (await read(request, id)).phase).toBe('COMPLETE');
  await expect(page.locator(`[data-board-task="${id}"]`)).toHaveCount(0);
});

test('a refused tier write brings the card back with the error, and nothing counts as sorted', async ({ page, request }) => {
  const id = await create(request, 'Sort refused write task');
  await open(page, 'Sort refused write task');
  await page.route('**/api/focus/batch', route => route.fulfill({ status: 500, json: { error: 'Disk is full' } }));
  await sortCard(page, id).locator('[data-sort-tier="focus"]').click();
  const sort = page.getByTestId('quick-sort');
  await expect(sort.getByRole('alert')).toBeVisible();
  await expect(sortCard(page, id)).toBeVisible();
  await expect(sort).toContainText('0 sorted this round');
  await expect(sort.locator('.quick-sort-toast')).toHaveCount(0);
  await page.unroute('**/api/focus/batch');
  expect(tierOf(await read(request, id))).toBe('unpinned');
  await sortCard(page, id).locator('[data-sort-tier="focus"]').click();
  await expect.poll(async () => tierOf(await read(request, id))).toBe('focus');
});

// The review's class: a decision's write and its Undo must end with what the user saw last, whatever
// order the server answers in, and a refused write never counts as sorted.
test('Undo while the snooze write is still out lands after it: the task ends unsnoozed', async ({ page, request }) => {
  const id = await create(request, 'Sort held snooze task');
  await open(page, 'Sort held snooze task');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() === 'PATCH' && first) { first = false; await held; }
    await route.continue();
  });
  await sortCard(page, id).locator('[data-sort-action="snooze"]').click();
  await page.getByRole('dialog', { name: 'Snooze until', exact: true }).locator('[data-snooze="tomorrow"]').click();
  await page.getByTestId('quick-sort').getByRole('button', { name: 'Undo', exact: true }).click();
  release();
  await expect.poll(async () => (await read(request, id)).start_date ?? '', { timeout: 15_000 }).toBe('');
  await expect(sortCard(page, id)).toBeVisible();
  await page.waitForTimeout(1000);
  expect((await read(request, id)).start_date ?? '').toBe('');
});

test('a refused snooze or done brings the card back and counts nothing', async ({ page, request }) => {
  const id = await create(request, 'Sort refused patch task');
  await open(page, 'Sort refused patch task');
  await page.route(`**/api/tasks/${id}`, route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 400, json: { error: 'Refused for the test' } }) : route.continue());
  const sort = page.getByTestId('quick-sort');
  await sortCard(page, id).locator('[data-sort-action="snooze"]').click();
  await page.getByRole('dialog', { name: 'Snooze until', exact: true }).locator('[data-snooze="tomorrow"]').click();
  await expect(sortCard(page, id)).toBeVisible();
  await expect(sort).toContainText('0 sorted this round');
  await sortCard(page, id).locator('[data-sort-action="done"]').click();
  await expect(sortCard(page, id)).toBeVisible();
  await expect(sort).toContainText('0 sorted this round');
  await expect(sort.locator('.quick-sort-toast')).toHaveCount(0);
  const task = await read(request, id);
  expect([task.start_date ?? '', task.phase]).toEqual(['', 'TODO']);
});

test('a tier write refused for a subtask keeps the leader sorted, and Undo moves back only what moved', async ({ page, request }) => {
  const lead = await create(request, 'Sort partial leader');
  const child = await create(request, 'Sort partial child', { parent_task_id: lead });
  await open(page, 'Sort partial');
  await page.route('**/api/focus/batch', async route => {
    const body = route.request().postDataJSON();
    if (body.tier !== 'focus') return route.continue();
    const response = await route.fetch({ postData: JSON.stringify({ ...body, task_ids: body.task_ids.filter((x: string) => x !== child) }) });
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, failed: [...(json.failed ?? []), { id: child, error: 'Refused for the test' }] } });
  });
  await sortCard(page, lead).locator('[data-sort-tier="focus"]').click();
  await expect.poll(async () => tierOf(await read(request, lead))).toBe('focus');
  expect(tierOf(await read(request, child))).toBe('unpinned');
  const sort = page.getByTestId('quick-sort');
  await expect(sort).toContainText('1 sorted this round');
  await expect(sortCard(page, child)).toBeVisible();
  await sort.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => tierOf(await read(request, lead))).toBe('unpinned');
  expect(tierOf(await read(request, child))).toBe('unpinned');
});

test('the Inbox project card sorts the Inbox tasks, pinned ones included', async ({ page, request }) => {
  const id = await create(request, 'Sort inbox pinned task', { project: '', pinned: true, focus_tier: 'focus' });
  await open(page, '', []);
  const sort = page.getByTestId('quick-sort');
  await sort.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('Sort inbox pinned task');
  await page.locator('[data-sort-project=""] [data-sort-action="tasks"]').click();
  await expect(sort.locator('[data-sort-filter="project"]')).toHaveText('Inbox ▾');
  await expect(sortCard(page, id)).toBeVisible();
  await pickProject(page, 'All projects');
});

test('each board card has Snooze and Done right on it, and Done can be undone', async ({ page, request }) => {
  const id = await create(request, 'Sort card buttons task', { pinned: true, focus_tier: 'focus' });
  await open(page, 'Sort card buttons task');
  const board = page.getByTestId('home-board');
  await board.getByRole('button', { name: 'By pin', exact: true }).click();
  await board.getByRole('button', { name: 'Snooze Sort card buttons task', exact: true }).click();
  const flyout = page.getByRole('dialog', { name: 'Snooze until', exact: true });
  await flyout.locator('[data-snooze="next-month"]').click();
  await expect(flyout).toHaveCount(0);
  await expect(page.locator(`[data-board-task="${id}"] [data-board-snoozed]`)).toContainText('until');
  await board.getByRole('button', { name: 'Snooze Sort card buttons task', exact: true }).click();
  await flyout.locator('[data-snooze="clear"]').click();
  await expect.poll(async () => (await read(request, id)).start_date ?? '').toBe('');
  await board.getByRole('button', { name: 'Mark Sort card buttons task done', exact: true }).click();
  await expect.poll(async () => (await read(request, id)).phase).toBe('COMPLETE');
  await expect(page.locator(`[data-board-task="${id}"]`)).toHaveCount(0);
  await board.locator('.home-board-done-note').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await read(request, id)).phase).not.toBe('COMPLETE');
  await expect(page.locator(`[data-board-task="${id}"]`)).toBeVisible();
  await board.getByRole('button', { name: 'By status', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Snooze Sort card buttons task', exact: true })).toBeVisible();
});

// 2026-11-07, the user: Sort must not walk every task on the board; it opens on a filter he can see and
// change (a tier, a project, a folder, how long nothing happened), each card says how long it has sat,
// and a Reply sends his words to the task, after which the card leaves the deck.
test('the deck opens on Focus and follows the tier, project, folder and no-action filters', async ({ page, request }) => {
  const tag = `Sortfilter ${Date.now().toString(36)}`;
  const focusId = await create(request, `${tag} focus`, { pinned: true, focus_tier: 'focus' });
  const looseId = await create(request, `${tag} loose`);
  const betaId = await create(request, `${tag} beta`, { project: other, pinned: true, focus_tier: 'focus' });
  const folder = await (await request.post('/api/tasks/folders', { data: { label: `${tag} folder`, project } })).json();
  const sub = await (await request.post('/api/tasks/folders', { data: { label: `${tag} subfolder`, project, parent_id: folder.group_id } })).json();
  expect((await request.post(`/api/tasks/groups/${sub.group_id}/add`, { data: { task_ids: [looseId] } })).ok()).toBe(true);
  await page.addInitScript(() => { for (const k of Object.keys(localStorage)) if (k.includes('sortFilter')) localStorage.removeItem(k); });
  await isolateUiPrefs(page);
  await page.setContent(`<a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click();
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await page.getByTestId('home-board').getByRole('button', { name: 'Sort', exact: true }).click();
  const sort = page.getByTestId('quick-sort');
  const filter = page.getByTestId('quick-sort-filter');
  // The default: Focus only, on screen.
  await expect(filter.locator('[data-sort-filter-tier="focus"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(filter.locator('[data-sort-filter-tier="unpinned"]')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(tag);
  await expect(sort.locator('[data-sort-card]')).toHaveCount(2);
  await expect(sortCard(page, looseId)).toHaveCount(0);
  // A second tier adds to it; Every tier takes them all.
  await filter.locator('[data-sort-filter-tier="unpinned"]').click();
  await expect(sort.locator('[data-sort-card]')).toHaveCount(3);
  await filter.locator('[data-sort-filter-tier="focus"]').click();
  await expect(sort.locator('[data-sort-card]')).toHaveCount(1);
  await setTiers(page, []);
  await expect(sort.locator('[data-sort-card]')).toHaveCount(3);
  // A project.
  await pickProject(page, other);
  await expect(sort.locator('[data-sort-card]')).toHaveCount(1);
  await expect(sortCard(page, betaId)).toBeVisible();
  await pickProject(page, project);
  // A folder takes its subfolders.
  await filter.locator('[data-sort-filter="folder"]').click();
  await page.getByRole('listbox', { name: 'Sort which folder' }).getByRole('option', { name: `${tag} folder`, exact: true }).click();
  await expect(sort.locator('[data-sort-card]')).toHaveCount(1);
  await expect(sortCard(page, looseId)).toBeVisible();
  // Escape closes the menu, not the board.
  await filter.locator('[data-sort-filter="folder"]').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Sort which folder' })).toHaveCount(0);
  await expect(page.getByTestId('home-board')).toBeVisible();
  // Nothing made today has gone 7 days with no action.
  await filter.locator('[data-sort-filter-idle="7"]').click();
  await expect(page.getByTestId('quick-sort-empty')).toContainText('No open task left under this filter');
  await page.getByTestId('quick-sort-empty').getByRole('button', { name: 'Sort every open task' }).click();
  await expect(filter.locator('[data-sort-filter-tier=""]')).toHaveAttribute('aria-pressed', 'true');
  await expect(filter.locator('[data-sort-filter-idle="0"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(sort.locator('[data-sort-card]')).toHaveCount(3);
  // A fresh task has sat less than a day: no age tags.
  await expect(sortCard(page, focusId).locator('[data-sort-age]')).toHaveCount(0);
});

test('Reply sends his words to the task\'s session and the card leaves; a task with no session starts with them', async ({ page, request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(Number(process.env.PW_TEST_PORT ?? 3457));
  const api = kanbanApi(Number(process.env.PW_TEST_PORT ?? 3457), fixtureRoot);
  const withSession = await create(request, 'Sort reply live task');
  const sessionId = await startSession(api, withSession, 'hello from the test');
  await expect.poll(async () => (await read(request, withSession)).session_id).toBe(sessionId);
  const fresh = await create(request, 'Sort reply fresh task');
  await open(page, 'Sort reply', []);
  const sort = page.getByTestId('quick-sort');
  const words = `Please wrap this up ${Date.now().toString(36)}`;
  await sortCard(page, withSession).locator('[data-sort-action="reply"]').click();
  const box = sortCard(page, withSession).getByRole('textbox', { name: 'Reply to Sort reply live task' });
  await expect(box).toBeFocused();
  // Escape closes the reply, keeps the card and the board.
  await box.fill('draft words');
  await page.keyboard.press('Escape');
  await expect(sortCard(page, withSession).getByTestId('quick-sort-reply')).toHaveCount(0);
  await expect(page.getByTestId('home-board')).toBeVisible();
  // R opens it again with the words kept (they are the session's draft).
  await sortCard(page, withSession).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await expect(box).toHaveValue('draft words');
  await box.fill(words);
  await page.keyboard.press('Enter');
  await expect(sortCard(page, withSession)).toHaveCount(0);
  await expect(sort.locator('.quick-sort-toast')).toContainText('Sent your reply to "Sort reply live task"');
  await expect(sort.locator('.quick-sort-toast').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(sort.getByTestId('quick-sort-tally')).toContainText('Replied 1');
  await expect.poll(async () => JSON.stringify(await (await request.get(`/api/sessions/${sessionId}/history`)).json()), { timeout: 30_000 }).toContain(words);

  // No session yet: the start carries his words as its first message.
  let startBody: unknown = null;
  await page.route(`**/api/v1/tasks/${fresh}/start`, async route => { startBody = route.request().postDataJSON(); await route.fulfill({ status: 202, json: { taskId: fresh, started: true } }); });
  await sortCard(page, fresh).locator('[data-sort-action="reply"]').click();
  await sortCard(page, fresh).getByRole('textbox', { name: 'Reply to Sort reply fresh task' }).fill('Start on the draft');
  await sortCard(page, fresh).locator('[data-sort-reply-send]').click();
  await expect(sortCard(page, fresh)).toHaveCount(0);
  expect(startBody).toEqual({ message: 'Start on the draft' });
});

test('a reply the task did not take keeps the card and the words, with the reason', async ({ page, request }) => {
  const id = await create(request, 'Sort reply refused task');
  await open(page, 'Sort reply refused task');
  await page.route(`**/api/v1/tasks/${id}/start`, route => route.fulfill({ status: 409, json: { error: 'No host can run it now' } }));
  await sortCard(page, id).locator('[data-sort-action="reply"]').click();
  const box = sortCard(page, id).getByRole('textbox', { name: 'Reply to Sort reply refused task' });
  await box.fill('Keep these words');
  await page.keyboard.press('Enter');
  await expect(sortCard(page, id).getByRole('alert')).toContainText("Couldn't send");
  await expect(box).toHaveValue('Keep these words');
  await expect(page.getByTestId('quick-sort')).toContainText('0 sorted this round');
});

// Review round 2: a reply leaves the deck only once the words are known to be with the task.
test('a send retried after a lost answer is the same message, and a start that fails later keeps the words', async ({ page, request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(Number(process.env.PW_TEST_PORT ?? 3457));
  const api = kanbanApi(Number(process.env.PW_TEST_PORT ?? 3457), fixtureRoot);
  const live = await create(request, 'Sort retry live task');
  const sessionId = await startSession(api, live, 'hello again');
  await expect.poll(async () => (await read(request, live)).session_id).toBe(sessionId);
  const late = await create(request, 'Sort retry late start task');
  await open(page, 'Sort retry', []);
  const ids: string[] = [];
  let lose = true;
  await page.route(`**/api/v1/sessions/${sessionId}/messages`, async route => {
    ids.push(route.request().postDataJSON().messageId);
    // The first one reaches the server, its answer is lost.
    if (lose) { lose = false; await route.fetch(); await route.abort('connectionreset'); return; }
    await route.continue();
  });
  await sortCard(page, live).locator('[data-sort-action="reply"]').click();
  await sortCard(page, live).getByRole('textbox', { name: 'Reply to Sort retry live task' }).fill('Only once please');
  await page.keyboard.press('Enter');
  await expect(sortCard(page, live).getByRole('alert')).toContainText("Couldn't send");
  await sortCard(page, live).locator('[data-sort-reply-send]').click();
  await expect(sortCard(page, live)).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^qm-/);
  expect(ids[1]).toBe(ids[0]);
  // The same id is the server's resend of that message: it goes out under the line uuid it went in,
  // which Claude Code skips when it already ran it (core/session-queue-lines.ts; the mock CLI does
  // not skip, so the transcript is not the check here).

  // A start the server answered early, whose record then says it failed.
  await page.route(`**/api/v1/tasks/${late}/start`, route => route.fulfill({ status: 202, json: { taskId: late, started: false, starting: true } }));
  await page.route(`**/api/tasks/${late}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, task: { ...json.task, last_start: { id: 'a', at: new Date().toISOString(), state: 'failed', error: 'No host can run it' } } } });
  });
  await sortCard(page, late).locator('[data-sort-action="reply"]').click();
  const box = sortCard(page, late).getByRole('textbox', { name: 'Reply to Sort retry late start task' });
  await box.fill('Start when you can');
  await page.keyboard.press('Enter');
  await expect(sortCard(page, late).getByRole('alert')).toContainText('No host can run it');
  await expect(box).toHaveValue('Start when you can');
  await expect(sortCard(page, late)).toBeVisible();
});
