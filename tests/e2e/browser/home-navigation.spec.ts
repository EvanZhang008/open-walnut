import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';

const SHOTS = '/tmp/walnut-home-navigation';
test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'default' });
test.setTimeout(120_000);

async function boot(page: Page, baseURL: string) {
  await isolateUiPrefs(page);
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.task-view-menu-trigger')).toBeVisible({ timeout: 45_000 });
}
const navigation = (page: Page) => page.locator('#home-task-navigation');
const heading = (page: Page, id: string) => navigation(page).locator(`[data-navigation-id="${id}"]`);
async function appMenu(page: Page, item: string) {
  await page.locator('.app-menu-trigger').click();
  await page.getByRole('menu', { name: 'Walnut menu', exact: true }).getByRole('menuitem', { name: item, exact: true }).click();
}
async function view(page: Page, name: string) {
  await navigation(page).getByRole('button', { name: 'Task view', exact: true }).click();
  await page.getByRole('menu', { name: 'Task views', exact: true }).getByRole('menuitem', { name, exact: true }).click();
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

test('defaults, independent shortcuts, fixed collapse, menus, and responsive layouts', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page, baseURL!);
  await expect(page.locator('#primary-sidebar')).toBeHidden();
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
  await expect(navigation(page).locator('.task-view-menu-trigger')).toHaveText(/All tasks/);
  for (const tier of ['focus', 'satellite', 'backlog', 'wait']) await expect(heading(page, tier)).toBeAttached();
  await expect(page.locator('.home-companion')).toBeHidden();
  const toggle = page.locator('.app-task-panel-toggle');
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(navigation(page)).toHaveAttribute('inert', '');
  expect(await toggle.boundingBox()).toEqual(before);
  await toggle.click();
  await expect(navigation(page)).not.toHaveAttribute('inert', '');
  await appMenu(page, 'Show app shortcuts');
  await expect(page.locator('#primary-sidebar')).toBeVisible();
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
  await appMenu(page, 'Show task quick views');
  await expect(page.locator('.todo-section-tabs')).toBeVisible();
  await view(page, 'Wait');
  await appMenu(page, 'Hide task quick views');
  await expect(navigation(page).locator('.task-view-menu-trigger')).toHaveText(/Wait/);
  await appMenu(page, 'Hide app shortcuts');
  await page.reload();
  await expect(navigation(page).locator('.task-view-menu-trigger')).toHaveText(/Wait/, { timeout: 30_000 });
  await expect(page.locator('#primary-sidebar')).toBeHidden();
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0);
  await view(page, 'All tasks');
  await heading(page, 'calendar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  const order = await navigation(page).locator('.navigation-app-entry').evaluateAll(rows => rows.map(row => row.getAttribute('data-navigation-id')));
  expect(order).toEqual(['calendar', 'notes']);
  await page.reload();
  await expect(heading(page, 'calendar')).toBeVisible({ timeout: 30_000 });
  expect(await navigation(page).locator('.navigation-app-entry').evaluateAll(rows => rows.map(row => row.getAttribute('data-navigation-id')))).toEqual(order);
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 840 });
    expect(await overflow(page)).toBe(false);
    await heading(page, 'calendar').locator('.navigation-heading-open').click();
    await expect(page.locator('[data-testid="cal-side-panel"]')).toBeVisible();
    const box = await page.locator('.home-companion').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.locator('.home-companion').locator('[title="Close calendar panel"]').click();
  }
  await page.setViewportSize({ width: 1280, height: 840 });
  await toggle.click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(navigation(page).locator('.todo-search-input')).toBeFocused();
  await navigation(page).locator('.todo-search-input').fill('no-match-navigation-4821');
  await expect(navigation(page)).toContainText(/No tasks match|No open tasks match/, { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(navigation(page).locator('.todo-search-bar')).toHaveClass(/is-compact/);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-navigation.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-navigation-dark.png` });
  expect(errors).toEqual([]);
});

test('native titlebar spacing and cross-window shortcuts preserve independent state', async ({ page, context, baseURL }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { walnutChrome: { postMessage() {} } } } });
  });
  await boot(page, baseURL!);
  const toggle = page.locator('.app-task-panel-toggle');
  expect((await toggle.boundingBox())!.x).toBeGreaterThanOrEqual(82);
  const other = await context.newPage();
  await boot(other, baseURL!);
  await appMenu(page, 'Show task quick views');
  await expect(other.locator('.todo-section-tabs')).toBeVisible();
  await expect(other.locator('#primary-sidebar')).toBeHidden();
  await appMenu(other, 'Show app shortcuts');
  await expect(page.locator('#primary-sidebar')).toBeVisible();
  await appMenu(page, 'Hide app shortcuts');
  await expect(other.locator('#primary-sidebar')).toBeHidden();
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

test('Notes tree failure recovers without replacing the conversation draft', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await navigation(page).getByRole('button', { name: 'New task', exact: true }).click();
  const draft = page.locator('.main-page-session-column .draft-session-panel').first();
  await draft.locator('.chat-input-textarea').fill('Draft during notes recovery');
  await page.route('**/api/notes-v2', route => route.fulfill({ status: 503, json: { error: 'Temporary notes tree failure' } }));
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  const notes = page.getByTestId('home-companion-notes');
  await expect(notes.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 20_000 });
  await heading(page, 'calendar').locator('.navigation-heading-open').click();
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  await page.unroute('**/api/notes-v2');
  await notes.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(notes.locator('.notes-tree-pane')).toBeVisible();
  await expect(draft.locator('.chat-input-textarea')).toHaveValue('Draft during notes recovery');
});

test('companion and full Notes keep separate tab workspaces', async ({ page, baseURL }) => {
  const paths = ['Companion workspace.md', 'Full workspace.md'];
  for (const path of paths) expect((await page.request.put(`/api/notes-v2/content/${encodeURIComponent(path)}`, { data: { content: `# ${path}\n\nWorkspace content.\n` } })).ok()).toBe(true);
  await boot(page, baseURL!);
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  const companion = page.locator('[data-testid="home-companion-notes"]');
  await companion.locator('.notes-tree-file').filter({ hasText: 'Companion workspace' }).click();
  await expect(companion.locator('.notes-editor-content')).toContainText('Companion workspace');
  await appMenu(page, 'Notes');
  const full = page.locator('.app-content-area > .notes-split-view');
  await expect(full).toBeVisible();
  await full.locator('.notes-tree-file').filter({ hasText: 'Full workspace' }).click();
  await expect(full.locator('.notes-editor-content')).toContainText('Full workspace');
  await appMenu(page, 'Home');
  await expect(companion.locator('.notes-editor-content')).toContainText('Companion workspace');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('open-walnut-notes-tabs') ?? '{}').activePath)).toBe(paths[1]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('open-walnut-home-notes-tabs') ?? '{}').activePath)).toBe(paths[0]);
});

test('Notes and Calendar preserve an active draft, note text, and the homepage URL', async ({ page, baseURL }) => {
  const notePath = `Navigation-${test.info().project.name}.md`;
  const content = '# Navigation note\n\n## Weekly review\n\n| Topic | Status | Next step |\n| --- | --- | --- |\n| Navigation | In review | Check both browsers |\n| Notes | Ready | Keep pending edits |\n\n- [x] Check default navigation\n- [ ] Review the final build\n\n```ts\nconst context = { keepDraft: true };\n```\n\nKeep this note beside the conversation.\n';
  const seeded = await page.request.put(`/api/notes-v2/content/${notePath}`, { data: { content } });
  expect(seeded.ok()).toBe(true);
  await boot(page, baseURL!);
  await navigation(page).getByRole('button', { name: 'New task', exact: true }).click();
  const draft = page.locator('.main-page-session-column .draft-session-panel').first();
  await expect(draft).toBeVisible();
  await draft.locator('.chat-input-textarea').fill('Keep this unsent conversation draft');
  await expect(draft.locator('.draft-composer-bar')).toContainText('Choose folder');
  const url = page.url();
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  const notes = page.locator('.home-companion');
  await expect(notes).toBeVisible();
  const browse = notes.getByRole('button', { name: /Browse notes/ });
  if (await browse.isEnabled() && await browse.getAttribute('aria-pressed') !== 'true') await browse.click();
  await notes.locator('.notes-tree-file').filter({ hasText: notePath.replace('.md', '') }).first().click();
  const editor = notes.locator('.notes-editor-content .tiptap');
  await expect(editor).toBeVisible();
  await expect(editor.locator('table')).toContainText('Navigation');
  await expect(editor.locator('pre')).toContainText('keepDraft');
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Saved across companion switches.');
  await heading(page, 'calendar').locator('.navigation-heading-open').click();
  await expect(page.locator('[data-testid="cal-side-panel"]')).toBeVisible();
  await expect(draft.locator('.chat-input-textarea')).toHaveValue('Keep this unsent conversation draft');
  await page.keyboard.press('ControlOrMeta+e');
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Saved across companion switches.');
  expect(page.url()).toBe(url);
  await expect.poll(async () => {
    const res = await page.request.get(`/api/notes-v2/content/${notePath}`);
    expect(res.ok()).toBe(true);
    return (await res.json()).content;
  }).toContain('Saved across companion switches.');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-notes-beside-draft.png` });
  await notes.getByRole('button', { name: /Close/ }).first().click();
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  await expect(editor).toContainText('Saved across companion switches.');
  await expect(draft.locator('.chat-input-textarea')).toHaveValue('Keep this unsent conversation draft');
  const endpoint = `**/api/notes-v2/content/${notePath}`;
  await page.route(endpoint, async route => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 503, json: { error: 'Temporary write failure' } });
    else await route.continue();
  });
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Retain this failed save.');
  await expect(notes).toContainText(/error|failed/i, { timeout: 15_000 });
  await notes.getByRole('button', { name: /Close/ }).first().click();
  await heading(page, 'calendar').locator('.navigation-heading-open').click();
  await heading(page, 'notes').locator('.navigation-heading-open').click();
  await expect(editor).toContainText('Retain this failed save.');
  await page.unroute(endpoint);
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Recovered.');
  await expect.poll(async () => {
    const response = await page.request.get(`/api/notes-v2/content/${notePath}`);
    return (await response.json()).content;
  }, { timeout: 20_000 }).toContain('Recovered.');
});
