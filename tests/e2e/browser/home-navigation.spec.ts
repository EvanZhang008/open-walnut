import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { activeView, chooseViewOption, closeViewMenu, homeToolbar, openHome, openViewMenu } from './home-navigation-helpers';

const SHOTS = '/tmp/walnut-home-navigation';
test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'default' });
test.setTimeout(120_000);

async function boot(page: Page, baseURL: string) {
  await isolateUiPrefs(page);
  await openHome(page, baseURL);
}
const navigation = (page: Page) => page.locator('#home-task-navigation');
const heading = (page: Page, id: string) => navigation(page).locator(`[data-navigation-id="${id}"]`);
const railApp = (page: Page, id: string) => page.getByTestId(`sidebar-core-app-${id}`);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const right = async (page: Page, selector: string) => page.locator(selector).first().evaluate(el => el.getBoundingClientRect().left);

test('rail, toolbar, menu-only filters, trailing chevrons and responsive layouts', async ({ page, baseURL }) => {
  const errors: string[] = [];
  // WebKit reports fetches cancelled by a reload as page errors; those are the browser's, not the app's.
  page.on('pageerror', error => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message); });
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`;
  const created = await page.request.post('/api/tasks', { data: { title: `Navigation needs action ${tag}`, project: `Navigation layout ${tag}`, source: 'local' } });
  expect(created.ok()).toBe(true);
  const taskId = (await created.json()).task.id;
  expect((await page.request.patch(`/api/tasks/${taskId}`, { data: { phase: 'AGENT_COMPLETE' } })).ok()).toBe(true);
  // New tasks are pinned by default; this one belongs to the Projects list.
  expect((await page.request.delete(`/api/focus/tasks/${taskId}`)).ok()).toBe(true);
  // An empty tier is hidden, so give Focus a card of its own for the Pinned checks below.
  const pinned = await page.request.post('/api/tasks', { data: { title: `Navigation focus pin ${tag}`, project: `Navigation layout ${tag}`, source: 'local' } });
  const pinnedId = (await pinned.json()).task.id;
  expect((await page.request.post(`/api/focus/tasks/${pinnedId}`)).ok()).toBe(true);
  expect((await page.request.put(`/api/focus/tasks/${pinnedId}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true);
  await boot(page, baseURL!);

  // The rail is always there, with no top bar above the page.
  await expect(page.locator('#primary-sidebar')).toBeVisible();
  await expect(page.locator('.app-topbar')).toHaveCount(0);
  await expect(page.locator('.todo-section-tabs, .task-view-row')).toHaveCount(0);
  await expect(page.getByTestId('tier-view-bar')).toHaveCount(0);
  expect(await homeToolbar(page).evaluate(bar => [...bar.children].map(child => child.className.split(' ')[0])))
    .toEqual(['todo-search-bar', 'new-launcher-btn', 'vd', 'todo-panel-hide']);
  await expect(homeToolbar(page).locator('.todo-search-input')).toBeVisible();
  // One base colour: the task column is the page background, not the grey secondary band.
  expect(await page.locator('.main-page-todo').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  // The rail header and the task toolbar share one top line; the create button keeps its label.
  const bottomOf = (selector: string) => page.locator(selector).first().evaluate(el => Math.round(el.getBoundingClientRect().bottom));
  expect(await bottomOf('.sidebar-header')).toBe(await bottomOf('#home-task-navigation .todo-panel-toolbar'));
  await expect(homeToolbar(page).locator('.new-launcher-label')).toBeVisible();

  // Default list is everything; the tiers are headings of one page (the empty ones are
  // covered by their own test below).
  expect(await activeView(page)).toBe('all');
  await expect(heading(page, 'focus')).toBeAttached();

  // No Panels section: the list opens on Pinned, and Notes / Calendar are reached from the rail.
  for (const id of ['panels', 'notes', 'calendar']) await expect(heading(page, id)).toHaveCount(0);
  expect(await navigation(page).locator('.navigation-heading').first().getAttribute('data-navigation-id')).toBe('pinned');

  // Chevrons trail the name, on section headings and on project headers.
  expect(await right(page, '#home-task-navigation [data-navigation-id="pinned"] .navigation-chevron'))
    .toBeGreaterThan(await right(page, '#home-task-navigation [data-navigation-id="pinned"] .navigation-label'));
  const project = navigation(page).locator('.todo-group-project-header').filter({ hasText: `Navigation layout ${tag}` });
  await project.scrollIntoViewIfNeeded();
  const nameX = await project.locator('.todo-group-name-btn').evaluate(el => el.getBoundingClientRect().left);
  expect(await project.locator('.collapse-chevron').evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThan(nameX);
  await expect(project.locator('.todo-group-project-icon')).toBeHidden();
  const row = navigation(page).locator(`[data-task-id="${taskId}"]`).first();
  if (!(await row.isVisible())) await project.locator('.todo-group-name-btn').click();
  await expect(row).toBeVisible();
  expect(await row.locator('.todo-row-pill').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // Headings and task circles share one left edge, and the status dot trails the row.
  const leftOf = (locator: ReturnType<Page['locator']>) => locator.evaluate(el => el.getBoundingClientRect().left);
  const circleX = await leftOf(row.locator('.task-phase-icon-btn'));
  expect(Math.abs(circleX - await leftOf(project.locator('.todo-group-name-btn')))).toBeLessThanOrEqual(4);
  expect(Math.abs(circleX - await leftOf(heading(page, 'pinned').locator('.navigation-label')))).toBeLessThanOrEqual(4);
  // Room to breathe, like Codex's sidebar: that column is 16px in from the panel edge, titles at 40px.
  const panelX = await leftOf(navigation(page));
  expect(Math.round(circleX - panelX)).toBe(16);
  const textLeft = await row.locator('.todo-item-title').evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0].left;
  });
  expect(Math.round(textLeft - panelX)).toBe(40);
  // Status dots trail the title: filled while the output is unread, hollow once it is
  // read but the task still needs you. The circle keeps its session colour either way.
  const titleX = await leftOf(row.locator('.todo-item-title'));
  const unreadDot = row.locator('.task-unread-dot:not(.task-attention-dot)');
  if (await unreadDot.count()) {
    expect(await leftOf(unreadDot)).toBeGreaterThan(titleX);
    expect((await page.request.patch(`/api/tasks/${taskId}`, { data: { unread: false } })).ok()).toBe(true);
  }
  await expect(row.locator('.task-attention-dot')).toBeVisible();
  await expect(unreadDot).toHaveCount(0);
  expect(await leftOf(row.locator('.task-attention-dot'))).toBeGreaterThan(titleX);
  await expect(row.locator('.task-phase-icon-btn')).toHaveClass(/task-circle-todo/);
  expect(await row.locator('.task-phase-icon-btn').evaluate(el => getComputedStyle(el).color)).not.toBe('rgb(255, 59, 48)');
  await project.locator('.collapse-chevron').click();
  await expect(row).toBeHidden();
  await project.locator('.todo-group-name-btn').click();
  await expect(row).toBeVisible();

  // The filter menu owns views, active filters and layout toggles. Like the New task
  // popover it starts at the task panel's left edge (never over the rail) and runs right
  // over the chat; its section list fits without scrolling.
  await openViewMenu(page);
  const panelLeft = await page.locator('#home-task-navigation').evaluate(el => el.getBoundingClientRect().left);
  expect(Math.round((await page.locator('.vd-panel').boundingBox())!.x)).toBe(Math.round(panelLeft + 8));
  expect(await page.locator('.vd-panel .vd-rail').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.locator('.vd-panel [data-rail-section="quick"]').click();
  await page.locator('.vd-panel [data-date-value="now"]').click();
  await page.locator('.vd-panel [data-rail-section="view"]').click();
  await expect(page.locator('.vd-panel [data-view-option="date"]')).toHaveText('Date: Now ×');
  await expect(homeToolbar(page).locator('.vd-dot')).toBeVisible();
  await page.locator('.vd-panel [data-view-option="date"]').click();
  await expect(page.locator('.vd-panel [data-view-option="date"]')).toHaveCount(0);
  await closeViewMenu(page);
  await chooseViewOption(page, 'wait');
  await expect(page.getByTestId('tier-view-bar')).toContainText('Wait');
  await expect(heading(page, 'focus')).toHaveCount(0);
  await chooseViewOption(page, 'tier-custom');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-tier-view-modes') ?? '{}').wait)).toBe('custom');
  await chooseViewOption(page, 'quick-views');
  await expect(page.locator('.todo-section-tabs')).toBeVisible();
  await chooseViewOption(page, 'quick-views');
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('tier-view-bar')).toContainText('Wait', { timeout: 30_000 });
  await chooseViewOption(page, 'all');
  await expect(heading(page, 'focus')).toBeAttached();

  // The task-panel toggle sits under Home in the rail, stays put, and brings you home.
  const toggle = page.locator('.sidebar-home-group .app-task-panel-toggle');
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(navigation(page)).toHaveAttribute('inert', '');
  expect(await toggle.boundingBox()).toEqual(before);
  await toggle.click();
  await expect(navigation(page)).not.toHaveAttribute('inert', '');
  const group = page.locator('.sidebar-home-group');
  // Only the current page is accent-coloured; a toggle that is on reads as plain text.
  const pageColor = await group.locator('> .sidebar-link').evaluate(el => getComputedStyle(el).color);
  expect(await toggle.evaluate(el => getComputedStyle(el).color)).not.toBe(pageColor);
  expect(await group.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
  await page.locator('.sidebar-collapse-btn').click();
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(0);
  expect(await page.locator('.sidebar-home-panels').evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe('1px');
  await expect(page.locator('.sidebar-home-panels .sidebar-link').first()).toContainText('Task panel');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-rail-expanded.png`, clip: { x: 0, y: 0, width: 520, height: 480 } });
  await page.locator('.sidebar-collapse-btn').click();
  await toggle.click();
  await expect(navigation(page)).toHaveAttribute('inert', '');
  await railApp(page, 'settings').click();
  await expect(page).toHaveURL(/\/settings/);
  await toggle.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(navigation(page)).not.toHaveAttribute('inert', '');

  // The day agenda opens from the rail's Home group and fits every width.
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 840 });
    expect(await overflow(page)).toBe(false);
    await page.getByTestId('sidebar-toggle-calendar').click();
    await expect(page.locator('[data-testid="cal-side-panel"]')).toBeVisible();
    const box = await page.locator('.home-companion').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.locator('.home-companion').locator('[title="Close calendar panel"]').click();
    await expect(page.locator('[data-testid="cal-side-panel"]')).toBeHidden();
  }
  await page.setViewportSize({ width: 390, height: 840 });
  expect(await overflow(page)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(navigation(page).locator('.todo-search-input')).toBeFocused();
  await navigation(page).locator('.todo-search-input').fill('no-match-navigation-4821');
  await expect(navigation(page)).toContainText(/No tasks match|No open tasks match/, { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(navigation(page).locator('.todo-search-input')).toHaveValue('');
  await expect(navigation(page).locator('.todo-search-input')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-navigation.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-navigation-dark.png` });
  expect(errors).toEqual([]);
});

test('empty tiers stay hidden, heading menus organize and fold, and the panel hides from its own toolbar', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message); });
  await isolateUiPrefs(page);
  // A known, tiny board: only Focus holds pins, so the other three tiers are empty. The
  // session-open card reuses the fixture's task/session pair.
  await page.addInitScript(() => sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-store-sync-session', locked: false }])));
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const task = (id: string, title: string, project: string, extra: Record<string, unknown> = {}) => ({
    id, title, project, status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: ago(5), updated_at: ago(5), description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  let pinning = true;
  const board = () => [
    task('pw-task-store-sync', 'Card with an open session', 'Orchard', { unread: true, session_ids: ['pw-store-sync-session'], ...(pinning ? { pinned: true, focus_tier: 'focus' } : {}) }),
    task('nav-empty-pin', 'Pinned focus card', 'Orchard', pinning ? { pinned: true, focus_tier: 'focus' } : {}),
    task('nav-list-alpha', 'List alpha', 'Orchard', { created_at: ago(3), updated_at: ago(1) }),
    task('nav-list-bravo', 'List bravo', 'Meadowlark', { priority: 'immediate', created_at: ago(2), updated_at: ago(3) }),
    task('nav-list-charlie', 'List charlie', 'Meadowlark', { created_at: ago(1), updated_at: ago(2) }),
  ];
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks: board() } });
  });
  await page.route('**/api/focus/tasks', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const pins = pinning ? ['pw-task-store-sync', 'nav-empty-pin'] : [];
    await route.fulfill({ json: { pinned_tasks: pins, focus_tasks: pins, satellite_tasks: [], backlog_tasks: [], wait_tasks: [], custom_tier_tasks: {} } });
  });
  // One custom tier while pinning, none after: other specs leave custom tiers on the shared fixture.
  await page.route('**/api/focus/tiers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { tiers: pinning ? [{ id: 'nav-custom-someday', label: 'Someday' }] : [] } });
  });
  await openHome(page, baseURL!);
  await expect(navigation(page).locator('[data-task-id="nav-empty-pin"]')).toBeVisible({ timeout: 30_000 });

  // Only the built-in tier holding cards is drawn. A custom tier draws even when empty:
  // the user made it on purpose and needs its add row for the first card.
  await expect(heading(page, 'focus')).toBeVisible();
  for (const tier of ['satellite', 'backlog', 'wait']) await expect(heading(page, tier)).toHaveCount(0);
  await expect(heading(page, 'nav-custom-someday')).toBeVisible();

  // An open session draws a chevron on the card's right edge; the unread dot sits left of it.
  const sessionCard = navigation(page).locator('.todo-pinned-card-session-open[data-task-id="pw-task-store-sync"]');
  await expect(sessionCard).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(0, 0);
  const dotRight = await sessionCard.locator('> .task-unread-dot').evaluate(el => el.getBoundingClientRect().right);
  const cardRight = await sessionCard.evaluate(el => el.getBoundingClientRect().right);
  const chevronLeft = await sessionCard.evaluate(el => {
    const after = getComputedStyle(el, '::after');
    // A 6px square rotated 45deg spans about 8.5px; `right` is where its box ends.
    return el.getBoundingClientRect().right - parseFloat(after.right) - 6 * Math.SQRT2;
  });
  expect(dotRight).toBeLessThanOrEqual(chevronLeft);
  expect(cardRight - dotRight).toBeGreaterThanOrEqual(18);

  // Pinned's menu folds every tier at once, and unfolds them again.
  const menuItem = (name: string) => page.locator('.wn-context-menu').getByRole('menuitem', { name, exact: true });
  await heading(page, 'pinned').hover();
  await heading(page, 'pinned').getByRole('button', { name: 'Pinned menu' }).click();
  await menuItem('Collapse all tiers').click();
  await expect(heading(page, 'focus').locator('.navigation-heading-open')).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation(page).locator('[data-task-id="nav-empty-pin"]')).toBeHidden();
  await heading(page, 'pinned').hover();
  await heading(page, 'pinned').getByRole('button', { name: 'Pinned menu' }).click();
  await menuItem('Expand all tiers').click();
  await expect(navigation(page).locator('[data-task-id="nav-empty-pin"]')).toBeVisible();

  // Projects start folded, and the Projects menu opens or folds them all.
  const projects = heading(page, 'tasks');
  const listRow = (id: string) => navigation(page).locator(`.todo-panel-list [data-task-id="${id}"]`);
  await expect(navigation(page).locator('.todo-group-project-header')).toHaveCount(2);
  await expect(listRow('nav-list-alpha')).toBeHidden();
  const openProjectsMenu = async () => {
    await projects.hover();
    await projects.getByRole('button', { name: 'Projects menu' }).click();
    await expect(page.locator('.wn-context-menu')).toBeVisible();
  };
  await openProjectsMenu();
  await menuItem('Expand all projects').click();
  for (const id of ['nav-list-alpha', 'nav-list-bravo', 'nav-list-charlie']) await expect(listRow(id)).toBeVisible();
  await openProjectsMenu();
  await menuItem('Collapse all projects').click();
  await expect(listRow('nav-list-alpha')).toBeHidden();

  // Organize and Sort by are pick-one groups, like Claude's sidebar menu.
  const radio = (name: string) => page.locator('.wn-context-menu').getByRole('menuitemradio', { name, exact: true });
  await openProjectsMenu();
  await expect(radio('By project')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('In one list')).toHaveAttribute('aria-checked', 'false');
  expect(await page.locator('.wn-context-menu [role="menuitemradio"][aria-checked="true"]').count()).toBe(2);
  await radio('In one list').click();
  await expect(navigation(page).locator('.todo-group-project-header')).toHaveCount(0);
  const listOrder = () => navigation(page).locator('.todo-panel-list [data-task-id^="nav-list-"]')
    .evaluateAll(rows => rows.map(row => row.getAttribute('data-task-id')));
  await expect.poll(listOrder).toHaveLength(3);
  await openProjectsMenu();
  await expect(menuItem('Collapse all projects')).toHaveCount(0);
  await radio('Priority').click();
  await expect.poll(async () => (await listOrder())[0]).toBe('nav-list-bravo');
  await openProjectsMenu();
  await radio('Created').click();
  await expect.poll(listOrder).toEqual(['nav-list-charlie', 'nav-list-bravo', 'nav-list-alpha']);
  await openProjectsMenu();
  await radio('Last updated').click();
  await expect.poll(listOrder).toEqual(['nav-list-alpha', 'nav-list-charlie', 'nav-list-bravo']);
  await openProjectsMenu();
  await expect(radio('Last updated')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Created')).toHaveAttribute('aria-checked', 'false');
  await radio('By project').click();
  await expect(navigation(page).locator('.todo-group-project-header')).toHaveCount(2);

  // The toolbar's own button hides the panel and hands focus to the rail toggle, which brings it back.
  const hide = homeToolbar(page).getByRole('button', { name: 'Hide task panel' });
  await hide.click();
  await expect(navigation(page)).toHaveAttribute('inert', '');
  await expect(page.locator('.app-task-panel-toggle')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(navigation(page)).not.toHaveAttribute('inert', '');
  await expect(hide).toBeVisible();

  // With nothing pinned, the Pinned heading goes too and the list opens on Projects.
  pinning = false;
  await page.reload();
  await expect(projects).toBeVisible({ timeout: 30_000 });
  await expect(navigation(page).locator('.todo-group-project-header')).toHaveCount(2, { timeout: 30_000 });
  await expect(heading(page, 'pinned')).toHaveCount(0);
  expect(await navigation(page).locator('.navigation-heading').first().getAttribute('data-navigation-id')).toBe('tasks');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-empty-tiers.png`, clip: { x: 0, y: 0, width: 640, height: 480 } });
  expect(errors).toEqual([]);
});

test('quick view tabs stay in sync across windows', async ({ page, context, baseURL }) => {
  await boot(page, baseURL!);
  const other = await context.newPage();
  await boot(other, baseURL!);
  await chooseViewOption(page, 'quick-views');
  await expect(other.locator('.todo-section-tabs')).toBeVisible();
  await chooseViewOption(other, 'quick-views');
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
  await other.close();
});

test('plain task creation needs no folder and retains the explicit AI launch path', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await navigation(page).getByRole('button', { name: 'New task', exact: true }).click();
  const draft = page.locator('.main-page-session-column .draft-session-panel').first();
  await expect(draft.locator('.draft-composer-bar')).toContainText('Choose folder');
  const title = `Navigation task ${test.info().project.name} ${Date.now()}`;
  await draft.locator('.chat-input-textarea').fill(`${title}\n\nKeep the description.`);
  await expect(draft.locator('.draft-later-btn')).toBeEnabled();
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/tasks' && res.request().method() === 'POST');
  await draft.locator('.draft-later-btn').click();
  const res = await response;
  expect(res.ok()).toBe(true);
  const task = (await res.json()).task;
  expect(task.title).toBe(title);
  const detail = (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task;
  expect(detail.description).toContain('Keep the description.');
  expect(detail.project).toBe('');
  expect(detail.session_id).toBeFalsy();
  await navigation(page).getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.locator('.main-page-session-column .draft-session-panel').first().locator('.draft-composer-bar')).toContainText('Choose folder');
});

test('a Notes tree failure offers Retry and recovers', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await page.route('**/api/notes-v2', route => route.fulfill({ status: 503, json: { error: 'Temporary notes tree failure' } }));
  await railApp(page, 'notes').click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await page.unroute('**/api/notes-v2');
  await retry.click();
  await expect(page.locator('.notes-tree-pane')).toBeVisible();
});

test('the calendar panel keeps an active draft and the homepage URL', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await navigation(page).getByRole('button', { name: 'New task', exact: true }).click();
  const draft = page.locator('.main-page-session-column .draft-session-panel').first();
  await expect(draft).toBeVisible();
  await draft.locator('.chat-input-textarea').fill('Keep this unsent conversation draft');
  const url = page.url();
  await page.getByTestId('sidebar-toggle-calendar').click();
  const calendar = page.locator('[data-testid="cal-side-panel"]');
  await expect(calendar).toBeVisible();
  await expect(draft.locator('.chat-input-textarea')).toHaveValue('Keep this unsent conversation draft');
  expect(page.url()).toBe(url);
  await calendar.locator('[title="Close calendar panel"]').click();
  await expect(calendar).toBeHidden();
  // Closing hands focus back to the rail toggle that opened it.
  await expect(page.getByTestId('sidebar-toggle-calendar')).toBeFocused();
  await page.getByTestId('sidebar-toggle-calendar').click();
  await expect(calendar).toBeVisible();
  await expect(draft.locator('.chat-input-textarea')).toHaveValue('Keep this unsent conversation draft');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-calendar-beside-draft.png` });
});
