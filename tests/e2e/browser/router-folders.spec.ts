/**
 * A router's watched folders, set in Apps › Mail and on the Org page (one saved value).
 *
 * A router's watched folders on the Org page (2026-11-14, the user: each router "defines its own
 * filter ... default is the Inbox"): the field shows Inbox as its default, a list that leaves the
 * Inbox out warns that new Inbox mail would go to no one, and putting Inbox back clears the warning.
 * Nothing is saved: the edit stays a draft. Run with PW_VIDEO=1 for the proof clip.
 */
import { expect, test } from '@playwright/test';
import { MailFixtureServer, type MailFixture } from './mail-review-helpers';
import { openApps, openPluginDetail } from './apps-store-helpers';

let server: MailFixtureServer;
let fixture: MailFixture;
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(180000);
test.beforeAll(async () => {
  server = new MailFixtureServer();
  fixture = await server.start({ PW_MAIL_ROUTER: '1', PW_MAIL_DENSE: '1' });
});
test.afterAll(async () => { await server?.stop(); });

test('the watched folders field defaults to the Inbox and warns while the Inbox is left out, saving nothing', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/v1/org/routers')) writes.push(request.url()); });
  const root = `http://127.0.0.1:${fixture.port}/`;
  await page.goto(root);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90000 });
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
  await page.getByTestId('sidebar-org').click();
  const router = page.getByTestId('org-channel-router').filter({ hasText: 'Personal mail router' });
  await expect(router).toBeVisible({ timeout: 60000 });
  await router.click();
  await expect(page.getByTestId('org-router-settings')).toBeVisible();
  const toggle = page.getByTestId('org-router-settings-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

  const folders = page.getByTestId('org-router-folders');
  const warning = page.getByTestId('org-router-folders-no-inbox');
  await folders.scrollIntoViewIfNeeded();
  // Empty means the Inbox: the field says so, and nothing warns.
  await expect(folders).toHaveValue('');
  await expect(folders).toHaveAttribute('placeholder', 'Inbox');
  await expect(warning).toHaveCount(0);
  await page.waitForTimeout(800);

  await folders.click();
  await folders.pressSequentially('Receipts', { delay: 90 });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('Inbox is not in this list: new Inbox mail of these accounts goes to no one. Add Inbox to keep it.');
  await page.waitForTimeout(1500);

  await folders.pressSequentially(', Inbox', { delay: 90 });
  await expect(warning).toHaveCount(0);
  await page.waitForTimeout(1500);

  // Left as a draft: no router was changed. Discarding it leaves the next test a clean form.
  expect(writes).toEqual([]);
  await page.getByTestId('org-router-discard').click();
  await expect(folders).toHaveValue('');
});

test('the Mail plugin page sets each router\'s folders, warns without the Inbox, and the Org page shows the saved value', async ({ page }) => {
  const patches: Array<{ url: string; body: unknown }> = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/api/v1/org/routers/')) patches.push({ url: request.url(), body: request.postDataJSON() });
  });
  const root = `http://127.0.0.1:${fixture.port}/`;
  await page.goto(root);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90000 });
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
  await openApps(page);
  await openPluginDetail(page, 'mail');

  const panel = page.getByTestId('plugin-panel-mail:routers');
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(panel.locator('.plugin-settings-panel-title')).toHaveText('Routers');
  const block = panel.getByTestId('mail-router-block').filter({ has: page.getByTestId('mail-router-accounts').filter({ hasText: '@example.invalid' }) }).first();
  await expect(block).toBeVisible({ timeout: 30000 });
  await block.scrollIntoViewIfNeeded();
  const routerId = await block.getAttribute('data-router-id');
  expect(routerId).toBeTruthy();
  const folders = block.getByTestId('mail-router-folders');
  const warning = block.getByTestId('mail-router-folders-no-inbox');
  await expect(folders).toHaveValue('');
  await expect(folders).toHaveAttribute('placeholder', 'Inbox');
  await expect(warning).toHaveCount(0);
  await expect(block.getByTestId('mail-router-save')).toHaveCount(0);
  await page.waitForTimeout(800);

  await folders.click();
  await folders.pressSequentially('Receipts', { delay: 90 });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('Inbox is not in this list: new Inbox mail of these accounts goes to no one. Add Inbox to keep it.');
  await expect(folders).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(1500);
  await folders.pressSequentially(', Inbox', { delay: 90 });
  await expect(warning).toHaveCount(0);
  await page.waitForTimeout(600);
  await block.getByTestId('mail-router-save').click();
  await expect(block.getByTestId('mail-router-saved')).toHaveText('Saved.');
  // Folders only: the name, links and Paused stay the Org form's.
  expect(patches).toEqual([{ url: expect.stringContaining(`/api/v1/org/routers/${encodeURIComponent(routerId!)}`), body: { folders: ['Receipts', 'Inbox'] } }]);
  const areas = await (await page.request.get(`${root}api/v1/router/areas`)).json() as { areas: Array<{ id: string; folders?: string[] }>; routers: Array<{ taskId: string; areaId: string }> };
  const areaId = areas.routers.find((one) => one.taskId === routerId)!.areaId;
  expect(areas.areas.find((one) => one.id === areaId)!.folders).toEqual(['Receipts', 'Inbox']);
  await page.waitForTimeout(1000);

  // The same router on the Org page shows the value just saved.
  await block.getByTestId('mail-router-open-org').click();
  const settings = page.locator(`[data-testid="org-router-settings"][data-router-id="${routerId}"]`);
  await expect(settings).toBeVisible({ timeout: 30000 });
  const toggle = settings.getByTestId('org-router-settings-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const orgFolders = settings.getByTestId('org-router-folders');
  await orgFolders.scrollIntoViewIfNeeded();
  await expect(orgFolders).toHaveValue('Receipts, Inbox');
  await expect(settings.getByTestId('org-router-folders-no-inbox')).toHaveCount(0);
  await expect(settings.getByTestId('org-router-folders-in-mail')).toBeVisible();
  await orgFolders.hover();
  await page.waitForTimeout(2000);
});
