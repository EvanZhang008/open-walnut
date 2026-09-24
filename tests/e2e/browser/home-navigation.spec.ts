import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs, openListProject } from './todo-panel-helpers';
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
/** The home session columns' sessions, left to right. */
const sessionColumnOrder = (page: Page) => page.locator('.main-page-session-column').evaluateAll(cols =>
  cols.map(col => col.querySelector('[data-session-id]')?.getAttribute('data-session-id') ?? null));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const right = async (page: Page, selector: string) => page.locator(selector).first().evaluate(el => el.getBoundingClientRect().left);
// Pinned cards these tests make leave the shared Focus tier when the test ends: left there, they push
// later specs' drag targets below the window (project-collapse-menu's drags failed that way).
const unpinAfter: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of unpinAfter.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {});
    await request.delete(`/api/tasks/${id}`).catch(() => {});
  }
});

test('rail, toolbar, menu-only filters, trailing chevrons and responsive layouts', async ({ page, baseURL }) => {
  const errors: string[] = [];
  // WebKit reports fetches cancelled by a reload as page errors; those are the browser's, not the app's.
  page.on('pageerror', error => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message); });
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`;
  const created = await page.request.post('/api/tasks', { data: { title: `Navigation needs action ${tag}`, project: `Navigation layout ${tag}`, source: 'local' } });
  expect(created.ok()).toBe(true);
  const taskId = (await created.json()).task.id;
  expect((await page.request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true);
  // New tasks are pinned by default; this one belongs to the Projects list.
  expect((await page.request.delete(`/api/focus/tasks/${taskId}`)).ok()).toBe(true);
  // A folder in the same project, for the folder row's place on the grid (a folder needs two tasks).
  const memberIds: string[] = [];
  for (const n of [1, 2]) {
    const member = await page.request.post('/api/tasks', { data: { title: `Navigation folder member ${n} ${tag}`, project: `Navigation layout ${tag}`, source: 'local' } });
    const memberId = (await member.json()).task.id;
    expect((await page.request.delete(`/api/focus/tasks/${memberId}`)).ok()).toBe(true);
    memberIds.push(memberId);
  }
  expect((await page.request.post('/api/tasks/groups', { data: { task_ids: memberIds, label: `Navigation folder ${tag}` } })).ok()).toBe(true);
  // An empty tier is hidden, so give Focus a card of its own for the Pinned checks below.
  const pinned = await page.request.post('/api/tasks', { data: { title: `Navigation focus pin ${tag}`, project: `Navigation layout ${tag}`, source: 'local' } });
  const pinnedId = (await pinned.json()).task.id;
  unpinAfter.push(pinnedId);
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
  // One quiet toolbar, no accent colour: New task wears the search field's outline, and the
  // filter icon is the same grey glyph as the hide button.
  const look = (selector: string) => homeToolbar(page).locator(selector).first().evaluate(el => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopColor}`, color: s.color };
  });
  const [searchLook, createLook, filterLook, hideLook] = await Promise.all(
    ['.todo-search-bar', '.new-launcher-btn', '.vd-trigger-icon', '.todo-panel-hide'].map(look));
  expect(createLook.background).toBe(searchLook.background);
  expect(createLook.border).toBe(searchLook.border);
  expect(createLook.color).toBe('rgb(29, 29, 31)');
  expect(filterLook.color).toBe(hideLook.color);

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
  const row = navigation(page).locator(`[data-task-id="${taskId}"]`).first();
  if (!(await row.isVisible())) await project.locator('.todo-group-name-btn').click();
  await expect(row).toBeVisible();
  expect(await row.locator('.todo-row-pill').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // One grid: heading text, group icons and the status dots share the column 12px in
  // from the panel edge (where the search field starts), circles sit at 22px with or
  // without a dot, titles at 46px.
  const leftOf = (locator: ReturnType<Page['locator']>) => locator.evaluate(el => el.getBoundingClientRect().left);
  const circleX = await leftOf(row.locator('.task-phase-icon-btn'));
  const panelX = await leftOf(navigation(page));
  const textColumn = await heading(page, 'pinned').locator('.navigation-label').evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0].left;
  });
  expect(Math.round(textColumn - panelX)).toBe(12);
  expect(Math.round(await leftOf(project.locator('.todo-group-name-btn')) - panelX)).toBe(12);
  expect(Math.round(await leftOf(homeToolbar(page).locator('.todo-search-bar')) - panelX)).toBe(12);
  expect(Math.round(circleX - panelX)).toBe(22);
  // A tier heading carries its coloured icon on that column and its name at 32px; a project
  // is its name alone (no folder icon), with air above it. A folder sits one step in, its
  // icon on the circle column. Section headings (Pinned, Projects) stay plain text.
  const textStart = (locator: ReturnType<Page['locator']>) => locator.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0].left;
  });
  await expect(heading(page, 'pinned').locator('.navigation-icon')).toHaveCount(0);
  const focusHeading = heading(page, 'focus');
  expect(Math.round(await leftOf(focusHeading.locator('.navigation-icon')) - panelX)).toBe(12);
  expect(Math.round(await textStart(focusHeading.locator('.navigation-label')) - panelX)).toBe(32);
  expect(await focusHeading.locator('.todo-tier-icon-focus').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 122, 255)');
  await expect(project.locator('.todo-group-project-icon')).toBeHidden();
  expect(Math.round(await textStart(project.locator('.todo-group-project-name')) - panelX)).toBe(12);
  expect(await project.evaluate(el => getComputedStyle(el).marginTop)).toBe('12px');
  const folder = navigation(page).locator('.todo-group-project .task-group-chip').filter({ hasText: `Navigation folder ${tag}` });
  await expect(folder).toBeVisible();
  expect(Math.round(await leftOf(folder.locator('.task-group-chip-icon')) - panelX)).toBe(22);
  expect(Math.round(await textStart(folder.locator('.task-group-chip-label')) - panelX)).toBe(42);
  const textLeft = await row.locator('.todo-item-title').evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0].left;
  });
  expect(Math.round(textLeft - panelX)).toBe(46);
  // Status dots sit on that text column, left of the circle: filled while the output is
  // unread, hollow once it is read but the task still needs you. The circle keeps its
  // session colour either way, and the dot never moves it.
  const dotBox = (dot: ReturnType<Page['locator']>) => dot.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { left: box.left, right: box.right, painted: hit === el };
  });
  const unreadDot = row.locator('.task-unread-dot:not(.task-attention-dot)');
  if (await unreadDot.count()) {
    const dot = await dotBox(unreadDot);
    expect(Math.round(dot.left - textColumn)).toBe(0);
    expect(dot.right).toBeLessThanOrEqual(circleX - 3);
    expect((await page.request.patch(`/api/tasks/${taskId}`, { data: { unread: false } })).ok()).toBe(true);
  }
  await expect(row.locator('.task-attention-dot')).toBeVisible();
  await expect(unreadDot).toHaveCount(0);
  const ring = await dotBox(row.locator('.task-attention-dot'));
  expect(Math.round(ring.left - textColumn)).toBe(0);
  expect(ring.right).toBeLessThanOrEqual(circleX - 3);
  expect(ring.painted).toBe(true);
  expect(Math.round(await leftOf(row.locator('.task-phase-icon-btn')) - panelX)).toBe(22);
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
  // A toggle whose panel is open looks like the current page (the rail's active blue);
  // one whose panel is shut is a plain grey icon. The pointer leaves the rail first, since
  // hover tints every link, and the poll waits out the colour transition.
  const railLook = (locator: ReturnType<Page['locator']>) => locator.evaluate(el => {
    const style = getComputedStyle(el);
    return `${style.color} / ${style.backgroundColor}`;
  });
  const agenda = page.getByTestId('sidebar-toggle-calendar');
  await page.mouse.move(900, 500);
  const pageLook = await railLook(group.locator('> .sidebar-link'));
  await expect(toggle).toHaveClass(/\bactive\b/);
  await expect.poll(() => railLook(toggle)).toBe(pageLook);
  await expect(agenda).not.toHaveClass(/\bactive\b/);
  expect(await railLook(agenda)).not.toBe(pageLook);
  await toggle.click();
  await page.mouse.move(900, 500);
  await expect(toggle).not.toHaveClass(/\bactive\b/);
  await expect.poll(async () => await railLook(toggle) === await railLook(agenda)).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveClass(/\bactive\b/);
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
  // Fold records from earlier builds: one marked every project opened. Both are retired,
  // so the list still starts folded.
  await page.addInitScript(() => {
    localStorage.setItem('walnut-todo-list-open-projs', JSON.stringify(['Orchard', 'Meadowlark']));
    localStorage.setItem('walnut-todo-list-collapsed-projs', '[]');
  });
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const task = (id: string, title: string, project: string, extra: Record<string, unknown> = {}) => ({
    id, title, project, status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: ago(5), updated_at: ago(5), description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  let pinning = true;
  const board = () => [
    task('pw-task-store-sync', 'Card with an open session', 'Orchard', { unread: true, session_ids: ['pw-store-sync-session'], ...(pinning ? { pinned: true, focus_tier: 'focus' } : {}) }),
    task('nav-empty-pin', 'Pinned focus card', 'Orchard', pinning ? { pinned: true, focus_tier: 'focus' } : {}),
    // A second project in Focus, so the tier draws its project labels.
    task('nav-pin-other', 'Pinned card elsewhere', 'Meadowlark', pinning ? { pinned: true, focus_tier: 'focus' } : {}),
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
    const pins = pinning ? ['pw-task-store-sync', 'nav-empty-pin', 'nav-pin-other'] : [];
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

  // The unread dot sits on the heading text column, left of the circle, so it never meets
  // the chevron an open session draws on the card's right edge, and it stays put on hover.
  const sessionCard = navigation(page).locator('.todo-pinned-card-session-open[data-task-id="pw-task-store-sync"]');
  await expect(sessionCard).toBeVisible({ timeout: 20_000 });
  const panelLeft = await navigation(page).evaluate(el => el.getBoundingClientRect().left);
  const gutterDot = () => sessionCard.evaluate(card => {
    const dot = card.querySelector(':scope > .task-unread-dot')!;
    const box = dot.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { left: box.left, right: box.right, circle: card.querySelector('.task-phase-icon-btn')!.getBoundingClientRect().left, painted: hit === dot, opacity: getComputedStyle(dot).opacity };
  });
  await page.mouse.move(0, 0);
  const atRest = await gutterDot();
  const textColumn = await heading(page, 'pinned').locator('.navigation-label').evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects()[0].left;
  });
  expect(Math.round(atRest.left - textColumn)).toBe(0);
  expect(Math.round(atRest.circle - panelLeft)).toBe(22);
  expect(atRest.right).toBeLessThanOrEqual(atRest.circle - 3);
  expect(atRest.painted).toBe(true);
  await sessionCard.hover();
  await expect.poll(async () => (await gutterDot()).opacity).toBe('1');

  // One look per level, wherever it appears: sections (Pinned, Projects) lead, a project
  // label under a tier matches one under Projects, and each project shows its task count.
  const font = (locator: ReturnType<Page['locator']>) => locator.first().evaluate(el => {
    const style = getComputedStyle(el);
    return `${style.fontSize}/${style.fontWeight}/${style.color}`;
  });
  expect(await font(heading(page, 'pinned').locator('.navigation-heading-open'))).toBe('13px/600/rgb(29, 29, 31)');
  expect(await font(heading(page, 'tasks').locator('.navigation-heading-open'))).toBe('13px/600/rgb(29, 29, 31)');
  expect(await heading(page, 'tasks').evaluate(el => getComputedStyle(el).borderBottomWidth)).toBe('0px');
  const tierProject = navigation(page).locator('.tier-project-label').filter({ hasText: 'Orchard' });
  const listProject = navigation(page).locator('.todo-group-project-header').filter({ hasText: 'Meadowlark' });
  expect(await font(tierProject)).toBe(await font(listProject.locator('.todo-group-name-btn')));
  await expect(tierProject.locator('.tier-project-label-count')).toHaveText('2');
  await expect(listProject.locator('.todo-group-count')).toHaveText('2');
  // The count sits between the name and the chevron.
  for (const [label, count] of [[tierProject, '.tier-project-label-count'], [listProject, '.todo-group-count']] as const) {
    const countX = await label.locator(count).evaluate(el => el.getBoundingClientRect().left);
    expect(countX).toBeGreaterThan(await label.locator('.tier-project-label-name, .todo-group-name-btn').first().evaluate(el => el.getBoundingClientRect().left));
    expect(countX).toBeLessThan(await label.locator('.collapse-chevron').first().evaluate(el => el.getBoundingClientRect().left));
  }

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
  expect(await page.evaluate(() => [localStorage.getItem('walnut-todo-list-open-projs'), localStorage.getItem('walnut-todo-list-collapsed-projs')])).toEqual([null, null]);
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

test('a single tier, Recent and the Projects list draw on the same grid as All', async ({ page, baseURL }) => {
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`;
  // Two projects pinned in Focus, so the tier draws project labels, and one task that needs you.
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const created = await page.request.post('/api/tasks', { data: { title: `Grid card ${n} ${tag}`, project: `Grid ${n} ${tag}`, source: 'local' } });
    const id = (await created.json()).task.id;
    unpinAfter.push(id);
    expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true);
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true);
    ids.push(id);
  }
  expect((await page.request.patch(`/api/tasks/${ids[0]}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true);
  // A folder in Focus whose first member needs you: its dot steps in with it.
  const members: string[] = [];
  for (const n of [1, 2]) {
    const created = await page.request.post('/api/tasks', { data: { title: `Grid member ${n} ${tag}`, project: `Grid 1 ${tag}`, source: 'local' } });
    const id = (await created.json()).task.id;
    unpinAfter.push(id);
    expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true);
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true);
    members.push(id);
  }
  expect((await page.request.post('/api/tasks/groups', { data: { task_ids: members, label: `Grid folder ${tag}` } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${members[0]}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true);
  await boot(page, baseURL!);
  const grid = (selectors: Record<string, [string, 'box' | 'text']>) => navigation(page).evaluate((nav, selectors) => {
    const x0 = nav.getBoundingClientRect().left;
    const out: Record<string, number | null> = {};
    for (const [key, [selector, kind]] of Object.entries(selectors)) {
      const el = [...nav.querySelectorAll(selector)].find(e => e.getBoundingClientRect().width > 0);
      if (!el) { out[key] = null; continue; }
      if (kind === 'box') { out[key] = Math.round(el.getBoundingClientRect().left - x0); continue; }
      const range = document.createRange();
      range.selectNodeContents(el);
      out[key] = Math.round(range.getClientRects()[0].left - x0);
    }
    return out;
  }, selectors);
  const card = `[data-task-id="${ids[0]}"]`;
  const row = { circle: [`${card} .task-phase-icon-btn`, 'box'], dot: [`${card} .task-unread-dot`, 'box'] } as const;
  const member = `[data-task-id="${members[0]}"]`;
  // A folder member's dot is 10px left of its own circle, like every other row's (it used to
  // stay on the 12px column while the member stepped in to 38).
  const memberRow = { memberCircle: [`${member} .task-phase-icon-btn`, 'box'], memberDot: [`${member} .task-unread-dot`, 'box'] } as const;

  // In All, the second section stands clearly apart: 28px above Projects, 12px between tiers.
  const gapAbove = (selector: string) => navigation(page).evaluate((nav, selector) => {
    const target = nav.querySelector(selector)!;
    const top = target.getBoundingClientRect().top;
    const above = [...nav.querySelectorAll('[data-task-id], .navigation-heading, .tier-project-label, .task-group-chip, .todo-show-more')]
      .filter(el => !target.contains(el) && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().bottom <= top + 0.5)
      .map(el => el.getBoundingClientRect().bottom);
    return Math.round(top - Math.max(...above));
  }, selector);
  await expect(heading(page, 'tasks')).toBeVisible();
  await expect(navigation(page).locator(member)).toBeVisible();
  expect(await gapAbove('[data-navigation-id="tasks"]')).toBe(28);
  if (await heading(page, 'satellite').count()) expect(await gapAbove('[data-navigation-id="satellite"]')).toBe(12);

  await chooseViewOption(page, 'focus');
  await expect(page.getByTestId('tier-view-bar')).toContainText('Focus');
  await expect(navigation(page).locator(card)).toBeVisible();
  expect(await grid({
    icon: ['.tier-solo-heading .navigation-icon', 'box'], heading: ['.tier-solo-heading-label', 'text'],
    project: ['.tier-project-label-name', 'text'], ...row, ...memberRow,
  })).toEqual({ icon: 12, heading: 32, project: 12, circle: 22, dot: 12, memberCircle: 38, memberDot: 28 });
  // The selected task (what Locate lands on) is the one filled row, in the rail's active blue.
  const fill = (selector: string) => navigation(page).locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
  await navigation(page).locator(`${member} .todo-pinned-title`).click();
  await expect(navigation(page).locator(member)).toHaveClass(/todo-pinned-card-active/);
  await page.mouse.move(900, 500);
  expect(await fill(member)).toBe('rgba(0, 122, 255, 0.08)');
  expect(await fill(`[data-task-id="${members[1]}"]`)).not.toBe('rgba(0, 122, 255, 0.08)');
  // Escape with a task selected closes an open menu, and only the menu: the selection stays.
  await navigation(page).locator('.tier-project-label', { hasText: `Grid 1 ${tag}` }).locator('.tier-project-label-name').click({ button: 'right' });
  const cardMenu = page.locator('.wn-context-menu');
  await expect(cardMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cardMenu).toHaveCount(0);
  await expect(navigation(page).locator(member)).toHaveClass(/todo-pinned-card-active/);

  await chooseViewOption(page, 'recent');
  await expect(navigation(page).locator(card)).toBeVisible();
  expect(await grid(row)).toEqual({ circle: 22, dot: 12 });

  await chooseViewOption(page, 'tasks');
  await openListProject(page, `Grid 1 ${tag}`);
  await expect(navigation(page).locator(card)).toBeVisible();
  expect(await grid({ project: ['.todo-group-project-header .todo-group-project-name', 'text'], ...row, ...memberRow }))
    .toEqual({ project: 12, circle: 22, dot: 12, memberCircle: 38, memberDot: 28 });
  // In the list the selected row fills the same blue.
  await page.mouse.move(900, 500);
  // (Closing the filter menu with Escape on the way here must not have dropped the selection.)
  await expect(navigation(page).locator(`.todo-panel-item${member}`)).toHaveClass(/task-focused/);
  expect(await navigation(page).locator(`.todo-panel-item${member} .todo-row-pill`).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 122, 255, 0.08)');
  await chooseViewOption(page, 'all');
});

test('each project sorts its own tasks from its right-click menu, newest update first by default', async ({ page, baseURL }) => {
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`;
  const make = async (title: string, project: string) => {
    const created = await page.request.post('/api/tasks', { data: { title: `${title} ${tag}`, project, source: 'local' } });
    const id = (await created.json()).task.id as string;
    expect((await page.request.delete(`/api/focus/tasks/${id}`)).ok()).toBe(true);
    return id;
  };
  const projectA = `Sort A ${tag}`, projectB = `Sort B ${tag}`;
  const [a1, a2, a3] = [await make('a1', projectA), await make('a2', projectA), await make('a3', projectA)];
  const [b1, b2] = [await make('b1', projectB), await make('b2', projectB)];
  // Last touched: a3, then a1. By priority: a1 (immediate), a3 (important), a2. By creation: a3, a2, a1.
  expect((await page.request.patch(`/api/tasks/${a1}`, { data: { priority: 'immediate' } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${a3}`, { data: { priority: 'important' } })).ok()).toBe(true);
  await boot(page, baseURL!);
  const bucket = (project: string) => navigation(page).locator('.todo-group-project').filter({ has: page.locator('.todo-group-project-name', { hasText: project }) });
  const order = (project: string, ids: string[]) => () => bucket(project).locator('.todo-panel-item[data-task-id]')
    .evaluateAll((rows, ids) => rows.map(row => row.getAttribute('data-task-id')).filter(id => ids.includes(id!)), ids);
  const orderA = order(projectA, [a1, a2, a3]), orderB = order(projectB, [b1, b2]);
  const projectMenu = async (project: string) => {
    await bucket(project).locator('.todo-group-project-header').click({ button: 'right' });
    return page.getByTestId('project-ctx-menu');
  };
  await openListProject(page, projectA);
  await openListProject(page, projectB);

  // No choice made yet: every project reads newest update first.
  await expect.poll(orderA).toEqual([a3, a1, a2]);
  await expect.poll(orderB).toEqual([b2, b1]);
  let menu = await projectMenu(projectA);
  await expect(menu.getByText('Sort tasks by', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Last updated' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Priority' }).click();
  await expect.poll(orderA).toEqual([a1, a3, a2]);
  await expect.poll(orderB).toEqual([b2, b1]);

  // The choice is the project's own and survives a reload.
  await page.reload();
  await expect.poll(orderA, { timeout: 30_000 }).toEqual([a1, a3, a2]);
  await expect.poll(orderB).toEqual([b2, b1]);

  // The Projects heading sets every project at once.
  await heading(page, 'tasks').click({ button: 'right' });
  await expect(page.getByText('Sort every project by', { exact: true })).toBeVisible();
  await page.getByRole('menuitemradio', { name: 'Created', exact: true }).click();
  await expect.poll(orderA).toEqual([a3, a2, a1]);
  await expect.poll(orderB).toEqual([b2, b1]);
  menu = await projectMenu(projectA);
  await expect(menu.getByRole('menuitemradio', { name: 'Created' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Moving a task by hand switches only its own project to Manual order.
  const rowB1 = bucket(projectB).locator(`.todo-panel-item[data-task-id="${b1}"]`);
  await rowB1.hover();
  await rowB1.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.locator('.task-kebab-item').filter({ hasText: 'Move up' }).click();
  await expect.poll(orderB).toEqual([b1, b2]);
  menu = await projectMenu(projectB);
  await expect(menu.getByRole('menuitemradio', { name: 'Manual order' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  menu = await projectMenu(projectA);
  await expect(menu.getByRole('menuitemradio', { name: 'Created' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(orderA).toEqual([a3, a2, a1]);
});

test('the tab bar is one switch, in the filter menu and in every heading menu', async ({ page, baseURL }) => {
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`;
  // An empty tier is hidden, so give Focus a card for its heading to show.
  const pinned = await page.request.post('/api/tasks', { data: { title: `Tab bar pin ${tag}`, project: `Tab bar ${tag}`, source: 'local' } });
  const pinnedId = (await pinned.json()).task.id;
  unpinAfter.push(pinnedId);
  expect((await page.request.post(`/api/focus/tasks/${pinnedId}`)).ok()).toBe(true);
  expect((await page.request.put(`/api/focus/tasks/${pinnedId}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true);
  await boot(page, baseURL!);
  const tabs = page.locator('.todo-section-tabs');
  await expect(tabs).toHaveCount(0);

  // The filter menu: a switch in a Task panel group of its own, no longer a Layout chip.
  await openViewMenu(page);
  const panelSwitch = page.locator('.vd-panel [data-view-group="Task panel"]').getByRole('switch', { name: 'Show tab bar' });
  await expect(panelSwitch).not.toBeChecked();
  await expect(page.locator('.vd-panel [data-view-group="Layout"] [data-view-option="quick-views"]')).toHaveCount(0);
  await panelSwitch.click();
  await expect(panelSwitch).toBeChecked();
  await expect(tabs).toBeVisible();
  await closeViewMenu(page);

  // Right-clicking any heading offers the same switch, showing the same state.
  const menuSwitch = page.getByRole('menuitemcheckbox', { name: 'Show tab bar' });
  for (const [id, on] of [['pinned', true], ['focus', false], ['tasks', true]] as const) {
    await heading(page, id).click({ button: 'right' });
    await expect(menuSwitch).toHaveAttribute('aria-checked', String(on));
    await menuSwitch.click();
    await expect(menuSwitch).toHaveCount(0);
    await expect(tabs).toHaveCount(on ? 0 : 1);
  }
  await openViewMenu(page);
  await expect(panelSwitch).not.toBeChecked();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-tab-bar-switch.png`, clip: { x: 0, y: 0, width: 900, height: 620 } });
  await closeViewMenu(page);
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

test('the tab bar keeps the tabs the user picks, hides empty ones, and turns itself off', async ({ page, baseURL }) => {
  // One Focus card and one Wait card, no custom tier: Satellite and Backlog are empty. Routed, because
  // the shared fixture holds whatever pins and tiers earlier specs left behind.
  const now = new Date().toISOString();
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Tab pick ${id}`, project: 'Orchard', status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks: [task('tabs-focus', { pinned: true, focus_tier: 'focus' }), task('tabs-wait', { pinned: true, focus_tier: 'wait' }), task('tabs-list')] } });
  });
  await page.route('**/api/focus/tasks', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { pinned_tasks: ['tabs-focus', 'tabs-wait'], focus_tasks: ['tabs-focus'], satellite_tasks: [], backlog_tasks: [], wait_tasks: ['tabs-wait'], custom_tier_tasks: {} } });
  });
  await page.route('**/api/focus/tiers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { tiers: [] } });
  });
  await boot(page, baseURL!);
  await expect(navigation(page).locator('[data-task-id="tabs-focus"]')).toBeVisible({ timeout: 30_000 });
  await openViewMenu(page);
  await page.locator('.vd-panel [data-view-group="Task panel"]').getByRole('switch', { name: 'Show tab bar' }).click();
  await closeViewMenu(page);
  const bar = page.locator('.todo-section-tabs');
  const tabs = bar.locator('[role="tab"]');
  const tab = (name: string) => tabs.filter({ has: page.locator('.todo-section-tab-label', { hasText: new RegExp(`^${name}$`) }) });
  const names = () => tabs.evaluateAll(els => els.map(el => el.querySelector('.todo-section-tab-label')?.textContent ?? ''));

  // Out of the box: All is the word alone, Projects and Notes are gone, and the empty tiers hide.
  await expect(tab('All')).toHaveCount(1);
  await expect(tab('All').locator('.todo-section-tab-icon')).toHaveCount(0);
  await expect.poll(names).toEqual(expect.arrayContaining(['All', 'Focus', 'Wait']));
  for (const gone of ['Satellite', 'Backlog', 'Tasks', 'Notes', 'Projects', 'Scratchpad']) expect(await names()).not.toContain(gone);

  // The bar's own menu: a switch per tab, "Hide empty tabs", and the bar itself.
  await bar.getByRole('button', { name: 'Tab bar options' }).click();
  const menu = page.getByRole('menu', { name: 'Tab bar options' });
  const row = (name: string) => menu.getByRole('menuitemcheckbox', { name, exact: true });
  for (const name of ['All', 'Focus', 'Satellite', 'Backlog', 'Wait', 'Recent']) await expect(row(name)).toHaveAttribute('aria-checked', 'true');
  await expect(row('Hide empty tabs')).toHaveAttribute('aria-checked', 'true');
  await expect(row('Show tab bar')).toHaveAttribute('aria-checked', 'true');
  // The switches leave the menu open, so several can be flipped in a row.
  await row('Hide empty tabs').click();
  await expect(row('Hide empty tabs')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(names).toEqual(expect.arrayContaining(['Satellite', 'Backlog']));
  await row('Satellite').click();
  await expect(row('Satellite')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(names).not.toContain('Satellite');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-tab-bar-menu.png`, clip: { x: 0, y: 0, width: 760, height: 520 } });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // The tab the panel is on stays while it is on it; right-clicking the bar opens the same menu.
  await tab('Wait').click();
  await tab('Focus').click({ button: 'right' });
  await row('Wait').click();
  await page.keyboard.press('Escape');
  await expect(tab('Wait')).toHaveAttribute('aria-selected', 'true');
  await tab('All').click();
  await expect.poll(names).not.toContain('Wait');

  // The choices survive a reload.
  const kept = await names();
  await page.reload();
  await expect(homeToolbar(page).getByRole('button', { name: 'View options', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(names).toEqual(kept);

  // "Show tab bar" in the bar's menu turns it off, and focus lands on the filter menu, where it comes back.
  await bar.getByRole('button', { name: 'Tab bar options' }).click();
  await row('Show tab bar').click();
  await expect(bar).toHaveCount(0);
  await expect(homeToolbar(page).getByRole('button', { name: 'View options', exact: true })).toBeFocused();
  await openViewMenu(page);
  const panelSwitch = page.locator('.vd-panel [data-view-group="Task panel"]').getByRole('switch', { name: 'Show tab bar' });
  await expect(panelSwitch).not.toBeChecked();
  await panelSwitch.click();
  await closeViewMenu(page);
  await expect.poll(names).toEqual(kept);
});

test('Locate from a session panel opens the task tier tab when the tab bar shows it, and All otherwise', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // The fixture session belongs to pw-task-store-sync; where that task sits is routed, so each case
  // moves it (a tier, a custom tier, no tier) without touching the shared fixture's pins. Its panel
  // is the right one of two LOCKED columns, the layout where Locate used to swap them.
  const seededColumns = ['pw-exec-bug-session', 'pw-store-sync-session'];
  await page.addInitScript((ids) => sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(ids.map((id) => ({ id, locked: true })))), seededColumns);
  let where = 'wait';
  const now = new Date().toISOString();
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Locate ${id}`, project: 'Orchard', status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  const located = 'pw-task-store-sync';
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks: [
      task(located, { session_ids: ['pw-store-sync-session'], ...(where ? { pinned: true, focus_tier: where } : {}) }),
      task('locate-focus', { pinned: true, focus_tier: 'focus' }),
      task('locate-list'),
    ] } });
  });
  await page.route('**/api/focus/tasks', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: {
      pinned_tasks: where ? ['locate-focus', located] : ['locate-focus'], focus_tasks: ['locate-focus'], satellite_tasks: [], backlog_tasks: [],
      wait_tasks: where === 'wait' ? [located] : [], custom_tier_tasks: { ct_locate_later: where === 'ct_locate_later' ? [located] : [] },
    } });
  });
  await page.route('**/api/focus/tiers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { tiers: [{ id: 'ct_locate_later', label: 'Later' }] } });
  });
  await boot(page, baseURL!);
  await expect(navigation(page).locator('[data-task-id="locate-focus"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => sessionColumnOrder(page)).toEqual(seededColumns);
  const showTabBar = async () => {
    await openViewMenu(page);
    await page.locator('.vd-panel [data-view-group="Task panel"]').getByRole('switch', { name: 'Show tab bar' }).click();
    await closeViewMenu(page);
  };
  await showTabBar();
  const bar = page.locator('.todo-section-tabs');
  const tab = (name: string) => bar.locator('[role="tab"]').filter({ has: page.locator('.todo-section-tab-label', { hasText: new RegExp(`^${name}$`) }) });
  const locateButton = page.locator(`.main-page-session-column [data-session-id="pw-store-sync-session"]`).getByRole('button', { name: 'Locate task', exact: true });
  // Locate finds the task and nothing else: the panel it was pressed in stays where it is.
  const locate = { click: async () => {
    await locateButton.click();
    expect(await sessionColumnOrder(page)).toEqual(seededColumns);
  } };
  const card = navigation(page).locator(`.todo-pinned-section [data-task-id="${located}"]`);
  const landedOn = async (name: string) => {
    await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/todo-pinned-card-active/);
  };
  const reload = async () => {
    await page.reload();
    await expect(navigation(page).locator('[data-task-id="locate-focus"]')).toBeVisible({ timeout: 30_000 });
  };

  // With the bar showing the task's tier, Locate goes straight to that tab, from another tier or from All.
  await tab('Focus').click();
  await locate.click();
  await landedOn('Wait');
  await tab('All').click();
  await locate.click();
  await landedOn('Wait');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-locate-tier-tab.png`, clip: { x: 0, y: 0, width: 1280, height: 520 } });

  // A tier the user took off the bar has no tab to open, so the task is found in All.
  await tab('Focus').click();
  await bar.getByRole('button', { name: 'Tab bar options' }).click();
  await page.getByRole('menu', { name: 'Tab bar options' }).getByRole('menuitemcheckbox', { name: 'Wait', exact: true }).click();
  await page.keyboard.press('Escape');
  await locate.click();
  await landedOn('All');

  // Without the bar, All, even from a single tier picked in the filter menu.
  await bar.getByRole('button', { name: 'Tab bar options' }).click();
  await page.getByRole('menu', { name: 'Tab bar options' }).getByRole('menuitemcheckbox', { name: 'Show tab bar', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await chooseViewOption(page, 'focus');
  await expect(card).toHaveCount(0);
  await locate.click();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/todo-pinned-card-active/);
  expect(await activeView(page)).toBe('all');

  // A hidden task panel opens: a locate must never select a row nobody can see.
  const taskPanelToggle = page.locator('.sidebar-home-panels .sidebar-link', { hasText: 'Task panel' });
  await taskPanelToggle.click();
  await expect(navigation(page)).toHaveClass(/\bcollapsed\b/);
  await locate.click();
  await expect(navigation(page)).not.toHaveClass(/\bcollapsed\b/);
  await expect(card).toBeVisible();

  // A task in no tier is found in All, selected in the list, whichever tier tab was open.
  where = '';
  await reload();
  await showTabBar();
  await tab('Focus').click();
  await locate.click();
  await expect(tab('All')).toHaveAttribute('aria-selected', 'true');
  const row = navigation(page).locator(`.todo-panel-list [data-task-id="${located}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/task-focused/);

  // A custom tier's task opens that tier's tab.
  where = 'ct_locate_later';
  await reload();
  await tab('Focus').click();
  await locate.click();
  await landedOn('Later');

  // A click inside the panel is not a locate: the view the user is reading stays.
  await tab('All').click();
  await navigation(page).locator('.todo-pinned-section [data-task-id="locate-focus"] .todo-pinned-title').click();
  await expect(tab('All')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('Locate never moves or opens a session column, in an unlocked column or the Ask Walnut slot', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Unlocked this time: opening an already open session moves it to the left edge, which is what
  // Locate used to do to its own panel. The same task is also the ask the chat slot shows.
  const seededColumns = ['pw-exec-bug-session', 'pw-store-sync-session'];
  await page.addInitScript((ids) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(ids.map((id) => ({ id, locked: false }))));
    sessionStorage.setItem('walnut:ask-slot:selected', 'pw-task-store-sync');
  }, seededColumns);
  const now = new Date().toISOString();
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Locate ${id}`, project: 'Orchard', status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks: [
      task('pw-task-store-sync', { session_ids: ['pw-store-sync-session'], walnut_agent: true, pinned: true, focus_tier: 'focus' }),
      task('locate-list'),
    ] } });
  });
  await page.route('**/api/focus/tasks', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { pinned_tasks: ['pw-task-store-sync'], focus_tasks: ['pw-task-store-sync'], satellite_tasks: [], backlog_tasks: [], wait_tasks: [], custom_tier_tasks: {} } });
  });
  await boot(page, baseURL!);
  const card = navigation(page).locator('.todo-pinned-section [data-task-id="pw-task-store-sync"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => sessionColumnOrder(page)).toEqual(seededColumns);

  // The right-hand column's Locate selects the task and leaves both columns where they were.
  await page.locator('.main-page-session-column [data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Locate task', exact: true }).click();
  await expect(card).toHaveClass(/todo-pinned-card-active/);
  expect(await sessionColumnOrder(page)).toEqual(seededColumns);

  // The chat slot's Locate: its session is on screen in the slot, so no column may open for it.
  await page.locator('.main-page-session-column [data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Close session panel', exact: true }).click();
  await expect.poll(() => sessionColumnOrder(page)).toEqual(['pw-exec-bug-session']);
  // Escape clears the selection, so the slot's Locate has something to find again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(card).not.toHaveClass(/todo-pinned-card-active/);
  const slotLocate = page.locator('.ask-walnut-session[data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Locate task', exact: true });
  await expect(slotLocate).toBeVisible({ timeout: 20_000 });
  await slotLocate.click();
  await expect(card).toHaveClass(/todo-pinned-card-active/);
  expect(await sessionColumnOrder(page)).toEqual(['pw-exec-bug-session']);
  expect(errors).toEqual([]);
});

test('the Scratchpad is a Home panel in the rail, sharing the side column with the agenda', async ({ page, baseURL }) => {
  const original = (await (await page.request.get('/api/notes/global')).json()).content as string;
  const line = `Scratchpad line ${test.info().project.name} ${Date.now()}`;
  try {
    await boot(page, baseURL!);
    // No longer a view of the task panel.
    await openViewMenu(page);
    await expect(page.locator('.vd-panel [data-view-option="notes"]')).toHaveCount(0);
    await closeViewMenu(page);

    const toggle = page.getByTestId('sidebar-toggle-scratchpad');
    await expect(page.locator('.sidebar-home-panels .sidebar-link')).toHaveCount(4);
    await expect(page.locator('.sidebar-home-panels .sidebar-link').last()).toHaveAttribute('data-testid', 'sidebar-toggle-scratchpad');
    await expect(toggle).not.toHaveClass(/\bactive\b/);
    await toggle.click();
    const pane = page.getByTestId('home-companion-scratchpad');
    await expect(pane).toBeVisible();
    await expect(toggle).toHaveClass(/\bactive\b/);
    await expect(pane.locator('.global-notes-label')).toHaveText('Scratchpad');
    const editor = pane.locator('.notes-editor .tiptap');
    // Opening it is a request to write: the caret is already in the editor.
    await expect(editor).toBeFocused();
    const saved = page.waitForResponse(res => new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'PUT');
    await page.keyboard.type(line);
    expect((await saved).ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content).toContain(line);
    // Escape belongs to the editor; it does not close the pane.
    await page.keyboard.press('Escape');
    await expect(pane).toBeVisible();

    // With the agenda on too, both share the column, agenda on top.
    await page.getByTestId('sidebar-toggle-calendar').click();
    const calendar = page.getByTestId('cal-side-panel');
    await expect(calendar).toBeVisible();
    const [cal, pad, column] = await Promise.all([calendar, pane, page.locator('.home-companion')].map(l => l.boundingBox()));
    expect(cal!.y + cal!.height).toBeLessThanOrEqual(pad!.y + 1);
    expect(cal!.height).toBeGreaterThan(column!.height * 0.3);
    expect(pad!.height).toBeGreaterThan(column!.height * 0.3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.mouse.move(900, 500);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-scratchpad-with-agenda.png`, clip: { x: 0, y: 0, width: 1280, height: 840 } });

    // A reload keeps both open with the text, and does not pull focus into the editor.
    await page.reload();
    await expect(homeToolbar(page).getByRole('button', { name: 'View options', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText(line);
    await expect(calendar).toBeVisible();
    expect(await editor.evaluate(el => el.contains(document.activeElement))).toBe(false);

    // The × closes the pane and hands focus back to the rail; the agenda stays.
    await pane.getByRole('button', { name: 'Close Scratchpad' }).click();
    await expect(pane).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).not.toHaveClass(/\bactive\b/);
    await expect(calendar).toBeVisible();
    await toggle.click();
    await expect(editor).toContainText(line);
    await toggle.click();
    await expect(pane).toBeHidden();
  } finally {
    await page.request.put('/api/notes/global', { data: { content: original } });
  }
});

test('a fold keeps the clicked row where it was, and a tier folds only its own project run', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // First boot only: an older build's fold record (one set shared by every tier) with
  // Meadowlark folded, and every tier open so the panel has room to scroll. A reload
  // keeps whatever the test saved.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fold-anchor-seeded')) return;
    sessionStorage.setItem('fold-anchor-seeded', '1');
    localStorage.setItem('walnut-todo-collapsed-projs', JSON.stringify(['Meadowlark']));
    localStorage.setItem('walnut-todo-collapsed-sections', '[]');
  });
  const now = new Date().toISOString();
  const task = (id: string, project: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Fold ${id}`, project, status: 'todo', phase: 'TODO', priority: 'none', source: 'local',
    created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [], ...extra,
  });
  const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  // The same two projects in Focus, Satellite and Wait, a folder in Satellite, a folder with
  // one member pinned in Focus and two in the list, and the list below.
  const tiers: Record<string, Array<[string, string]>> = {
    focus: [...range('fo', 8).map((id): [string, string] => [id, 'Orchard']), ['fs1', 'Orchard'], ...range('fm', 3).map((id): [string, string] => [id, 'Meadowlark'])],
    satellite: [...range('so', 2).map((id): [string, string] => [id, 'Orchard']), ...range('sg', 3).map((id): [string, string] => [id, 'Orchard']), ...range('sm', 3).map((id): [string, string] => [id, 'Meadowlark'])],
    wait: [...range('wo', 6).map((id): [string, string] => [id, 'Orchard']), ...range('wm', 2).map((id): [string, string] => [id, 'Meadowlark'])],
  };
  const folderMembers = range('sg', 3);
  const spanMembers = ['fs1', 'lO1', 'lO2'];
  const groupOf = (id: string) => folderMembers.includes(id) ? 'fold-folder' : spanMembers.includes(id) ? 'fold-span' : undefined;
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    const pinned = Object.entries(tiers).flatMap(([tier, rows]) => rows.map(([id, project]) =>
      task(id, project, { pinned: true, focus_tier: tier, ...(groupOf(id) ? { group_id: groupOf(id) } : {}) })));
    const list = ['Orchard', 'Meadowlark', 'Juniper'].flatMap(project => range(`l${project[0]}`, project === 'Juniper' ? 12 : 8)
      .map(id => task(id, project, groupOf(id) ? { group_id: groupOf(id) } : {})));
    await route.fulfill({ json: { tasks: [...pinned, ...list] } });
  });
  await page.route('**/api/tasks/groups', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { groups: [
      { group_id: 'fold-folder', label: 'Fold folder', member_ids: folderMembers, project: 'Orchard' },
      { group_id: 'fold-span', label: 'Span folder', member_ids: spanMembers, project: 'Orchard' },
    ] } });
  });
  await page.route('**/api/focus/tasks', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const ids = (tier: string) => tiers[tier].map(([id]) => id);
    await route.fulfill({ json: {
      pinned_tasks: [...ids('focus'), ...ids('satellite'), ...ids('wait')], focus_tasks: ids('focus'),
      satellite_tasks: ids('satellite'), backlog_tasks: [], wait_tasks: ids('wait'), custom_tier_tasks: {},
    } });
  });
  await page.route('**/api/focus/tiers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { tiers: [] } });
  });
  await boot(page, baseURL!);
  await expect(navigation(page).locator('[data-task-id="fo1"]')).toBeVisible({ timeout: 30_000 });

  const tier = (id: string) => navigation(page).locator('.todo-pinned-subgroup').filter({ has: page.locator(`[data-navigation-id="${id}"]`) });
  const label = (tierId: string, project: string) => tier(tierId).locator(`.tier-project-label[data-project="${project}"]`).first();
  const card = (id: string) => navigation(page).locator(`.todo-pinned-section [data-task-id="${id}"]`);
  const scroller = navigation(page).locator('.home-navigation-scroll');
  const topOf = (row: ReturnType<typeof label>) => row.evaluate(el => el.getBoundingClientRect().top);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** Clicks `target`, waits for `folded` to settle, and returns how far `row` moved on screen. */
  const drift = async (row: ReturnType<typeof label>, click: () => Promise<void>, settled: () => Promise<void>) => {
    // Measured in view, so the click's own scroll-into-view never counts as drift.
    const view = await scroller.evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const before = await topOf(row);
    expect(before).toBeGreaterThan(view.top);
    expect(before).toBeLessThan(view.bottom - 40);
    await click();
    await settled();
    await frames();
    const soon = await topOf(row) - before;
    // Nothing may drift once the hold has ended either.
    await page.waitForTimeout(500);
    return { soon, later: await topOf(row) - before };
  };
  const still = { soon: 0, later: 0 };
  const near = (moved: { soon: number; later: number }) => ({ soon: Math.round(moved.soon), later: Math.round(moved.later) });

  // The shared record converted: Meadowlark is still folded in every tier.
  await expect(card('fm1')).toBeHidden();
  await expect(card('sm1')).toBeHidden();
  await expect(card('wm1')).toBeHidden();
  await openListProject(page, 'Juniper');
  await openListProject(page, 'Orchard');
  expect(await scroller.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);

  // 1. The report: at the top of the panel, fold Orchard in Satellite by its name. Orchard in
  //    Focus, above it, stays open, so the label does not jump up.
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await frames();
  const satOrchard = label('satellite', 'Orchard');
  expect(near(await drift(satOrchard, () => satOrchard.locator('.tier-project-label-name').click(), () => expect(card('so1')).toBeHidden()))).toEqual(still);
  await expect(card('fo1')).toBeVisible();
  await expect(card('wo1')).toBeVisible();
  expect(near(await drift(satOrchard, () => satOrchard.click(), () => expect(card('so1')).toBeVisible()))).toEqual(still);

  // 2. Opening a run the old shared record folded opens it in that tier only.
  const satMeadowlark = label('satellite', 'Meadowlark');
  expect(near(await drift(satMeadowlark, () => satMeadowlark.click(), () => expect(card('sm1')).toBeVisible()))).toEqual(still);
  await expect(card('fm1')).toBeHidden();
  await expect(card('wm1')).toBeHidden();
  // A scroll the page makes right after a fold is never pulled back.
  expect(await satOrchard.evaluate(async el => {
    const scroller = el.closest('.home-navigation-scroll')!;
    (el as HTMLElement).click();
    scroller.scrollTop = 40;
    for (let i = 0; i < 5; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    return scroller.scrollTop;
  })).toBe(40);
  await expect(card('so1')).toBeHidden();
  await satOrchard.click();
  await expect(card('so1')).toBeVisible();

  // 3. Scrolled into the middle, every kind of fold row keeps its place: a tier heading, a
  //    fold picked from its menu, a folder, and a project label's right-click menu.
  const scrollTo = async (row: ReturnType<typeof label>, y: number) => {
    await scroller.evaluate((el, dy) => { el.scrollTop += dy; }, await topOf(row) - y);
    await frames();
  };
  const satHeading = heading(page, 'satellite');
  const satOpen = satHeading.locator('.navigation-heading-open');
  await scrollTo(satHeading, 300);
  expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  expect(near(await drift(satHeading, () => satOpen.click(), () => expect(card('so1')).toHaveCount(0)))).toEqual(still);
  expect(near(await drift(satHeading, () => satOpen.click(), () => expect(card('so1')).toBeVisible()))).toEqual(still);
  expect(near(await drift(satHeading, async () => {
    await satHeading.getByRole('button', { name: 'Satellite menu' }).click();
    await page.locator('.wn-context-menu').getByRole('menuitem', { name: 'Collapse Satellite' }).click();
  }, () => expect(card('so1')).toHaveCount(0)))).toEqual(still);
  expect(near(await drift(satHeading, () => satOpen.click(), () => expect(card('so1')).toBeVisible()))).toEqual(still);

  const folder = tier('satellite').locator('.task-group-chip[data-group-id="fold-folder"]');
  await scrollTo(folder, 360);
  expect(near(await drift(folder, () => folder.locator('.task-group-chip-label').click(), () => expect(card('sg1')).toBeHidden()))).toEqual(still);
  expect(near(await drift(folder, () => folder.getByRole('button', { name: 'Expand folder' }).click(), () => expect(card('sg1')).toBeVisible()))).toEqual(still);

  await scrollTo(satOrchard, 320);
  expect(near(await drift(satOrchard, async () => {
    await satOrchard.click({ button: 'right' });
    await page.locator('.wn-context-menu').getByRole('menuitem', { name: 'Collapse project' }).click();
  }, () => expect(card('so1')).toBeHidden()))).toEqual(still);
  await expect(card('fo1')).toBeAttached();
  expect(await card('fo1').evaluate(el => getComputedStyle(el).display)).not.toBe('none');
  await expect(card('wo1')).toBeVisible();

  // A folder shown in two places folds only where it was clicked: its Focus copy, above
  // the list, stays open. (It sits at the end of the list, so this is also a fold that
  // shortens the content under the scroll position; see 4.)
  const listRow = (id: string) => navigation(page).locator(`.todo-panel-list [data-task-id="${id}"]`);
  const listFolder = navigation(page).locator('.todo-panel-list .task-group-chip[data-group-id="fold-span"]');
  await scrollTo(listFolder, 360);
  await expect(listRow('lO2')).toBeVisible();
  expect(near(await drift(listFolder, () => listFolder.locator('.task-group-chip-label').click(), () => expect(listRow('lO2')).toBeHidden()))).toEqual(still);
  await expect(card('fs1')).toBeVisible();

  // 4. At the very end of the list, folding a project shortens the content below the
  //    scroll position; the row still stays, and the room that takes drains away as
  //    the user scrolls back up.
  const juniper = navigation(page).locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name', { hasText: /^Juniper$/ }) });
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await frames();
  await expect(listRow('lJ12')).toBeVisible();
  expect(near(await drift(juniper, () => juniper.locator('.todo-group-name-btn').click(), () => expect(listRow('lJ1')).toHaveCount(0)))).toEqual(still);
  const atEnd = await topOf(juniper);
  const box = await scroller.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -150);
  await expect.poll(() => topOf(juniper)).toBeGreaterThan(atEnd + 100);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => scroller.evaluate(el => el.style.paddingBottom)).toBe('');
  // The rows ride the wheel, nothing else: no jump when the room goes.
  const settled = await topOf(juniper);
  await frames();
  expect(Math.round(await topOf(juniper) - settled)).toBe(0);

  // 5. The folds are saved per place, and the old shared record is left for older builds.
  await page.reload();
  await expect(navigation(page).locator('[data-task-id="fo1"]')).toBeVisible({ timeout: 30_000 });
  await expect(card('sm1')).toBeVisible();
  await expect(card('fm1')).toBeHidden();
  await expect(card('so1')).toBeHidden();
  await expect(card('fo1')).toBeVisible();
  await expect(card('fs1')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('walnut-todo-collapsed-projs'))).toBe(JSON.stringify(['Meadowlark']));
  await page.screenshot({ path: `${SHOTS}/v2/fold/${test.info().project.name}-after-reload.png`, clip: { x: 0, y: 0, width: 700, height: 840 } });
  expect(errors).toEqual([]);
});
