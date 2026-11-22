/**
 * A router's watched folders, picked from the mailboxes' own folder lists in the router's one
 * settings dialog, opened from Apps › Mail and from the Org page (2026-11-14, the user: the folders
 * load by themselves and are picked; the settings are a popup window, not a drawer).
 *
 * The dense mail fixture's second mailbox carries nested folders (PW_MAIL_DENSE_NESTED), as an IMAP
 * LIST answers them. Run with PW_VIDEO=1 for the proof clips.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MailFixtureServer, type MailFixture } from './mail-review-helpers';
import { openApps, openPluginDetail } from './apps-store-helpers';

let server: MailFixtureServer;
let fixture: MailFixture;
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(180000);
test.beforeAll(async () => {
  server = new MailFixtureServer();
  fixture = await server.start({ PW_MAIL_ROUTER: '1', PW_MAIL_DENSE: '1', PW_MAIL_DENSE_NESTED: '1' });
});
test.afterAll(async () => { await server?.stop(); });

const root = () => `http://127.0.0.1:${fixture.port}/`;

async function home(page: Page) {
  await page.goto(root());
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90000 });
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
}

/** Move the visible pointer onto an element before acting on it, so the clip shows where it went. */
async function glide(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
}

const option = (dialog: Locator, token: string) => dialog.locator(`[data-testid="org-router-folders-option"][data-token="${token}"]`);

test('Org: the router settings open in a dialog, the folder list loads (and recovers from a failed read), and leaving the Inbox out warns', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/v1/org/routers/')) writes.push(r.url()); });
  // While `failing`, every folder read of one mailbox fails (the client may retry a 503 by itself):
  // its error and Try again are the way back.
  let failing = false;
  await page.route((url) => url.pathname.endsWith('/api/plugins/mail/mailboxes') && url.searchParams.get('account') === 'dense:marina', async (route) => {
    if (failing) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }); return; }
    await route.continue();
  });
  await home(page);
  await page.getByTestId('sidebar-org').click();
  const router = page.getByTestId('org-channel-router').filter({ hasText: 'Personal mail router' });
  await expect(router).toBeVisible({ timeout: 60000 });
  await router.click();
  const open = page.getByTestId('org-router-settings-toggle');
  await expect(open).toHaveAttribute('aria-haspopup', 'dialog');
  await glide(page, open);
  failing = true;
  await open.click();

  const dialog = page.getByTestId('router-settings-dialog');
  await expect(dialog).toBeVisible();
  // Centered over the page, not a drawer at an edge.
  const box = (await dialog.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(8);
  const error = dialog.getByTestId('org-router-folders-error');
  await expect(error).toBeVisible({ timeout: 30000 });
  await expect(error).toContainText('Could not read the folders of marina@example.invalid');
  await page.waitForTimeout(800);
  failing = false;
  await glide(page, error.getByTestId('org-router-folders-retry'));
  await error.getByTestId('org-router-folders-retry').click();
  await expect(error).toHaveCount(0);
  await expect(option(dialog, 'Clients/Acme/Invoices')).toBeVisible({ timeout: 30000 });

  // The Inbox is ticked by default (nothing saved), and the nested folders sit under their parents.
  await expect(option(dialog, 'inbox').locator('input')).toBeChecked();
  const depth = async (token: string) => Number.parseInt((await option(dialog, token).evaluate((el) => getComputedStyle(el).paddingLeft)), 10);
  expect(await depth('Projects/Alpha')).toBeGreaterThan(await depth('Projects'));
  expect(await depth('Clients/Acme/Invoices')).toBeGreaterThan(await depth('Clients/Acme'));
  await expect(dialog.getByTestId('org-router-folders-no-inbox')).toHaveCount(0);

  await glide(page, option(dialog, 'inbox'));
  await option(dialog, 'inbox').locator('input').uncheck();
  await expect(dialog.getByTestId('org-router-folders-none')).toBeVisible();
  await expect(dialog.getByTestId('org-router-save')).toBeDisabled();
  await option(dialog, 'Projects/Beta').locator('input').check();
  await expect(dialog.getByTestId('org-router-folders-no-inbox')).toBeVisible();
  await expect(dialog.getByTestId('org-router-folders-no-inbox')).toHaveText('Inbox is not ticked: new Inbox mail of these mailboxes goes to no one. Tick Inbox to keep it.');
  await page.waitForTimeout(1500);

  // Left as a draft and thrown away: no router was changed.
  await dialog.getByTestId('org-router-discard').click();
  await expect(option(dialog, 'inbox').locator('input')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('Apps › Mail: Settings opens the same dialog, the folders load, two are ticked and saved, and reopening (there and on Org) shows them kept', async ({ page }) => {
  const patches: unknown[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/v1/org/routers/')) patches.push(r.postDataJSON()); });
  await home(page);
  await openApps(page);
  await openPluginDetail(page, 'mail');
  const panel = page.getByTestId('plugin-panel-mail:routers');
  const block = panel.getByTestId('mail-router-block').filter({ has: page.getByTestId('mail-router-accounts').filter({ hasText: 'marina@example.invalid' }) }).first();
  await expect(block).toBeVisible({ timeout: 30000 });
  await block.scrollIntoViewIfNeeded();
  const routerId = (await block.getAttribute('data-router-id'))!;
  await expect(block.getByTestId('mail-router-folders-line')).toHaveText('Watches Inbox');
  await page.waitForTimeout(600);

  const settings = block.getByTestId('mail-router-open-settings');
  await glide(page, settings);
  await settings.click();
  const dialog = page.getByTestId('router-settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-router-id', routerId);
  await expect(option(dialog, 'Projects/Alpha')).toBeVisible({ timeout: 30000 });
  await expect(option(dialog, 'inbox').locator('input')).toBeChecked();
  await page.waitForTimeout(800);

  for (const token of ['Projects/Alpha', 'Clients/Acme/Invoices']) {
    const row = option(dialog, token);
    await row.scrollIntoViewIfNeeded();
    await glide(page, row);
    await row.locator('input').check();
    await page.waitForTimeout(500);
  }
  const save = dialog.getByTestId('org-router-save');
  await glide(page, save);
  await save.click();
  await expect(dialog.getByTestId('org-router-saved')).toHaveText('Saved.');
  expect(patches).toEqual([{ folders: ['inbox', 'Projects/Alpha', 'Clients/Acme/Invoices'] }]);
  const areas = await (await page.request.get(`${root()}api/v1/router/areas`)).json() as { areas: Array<{ id: string; folders?: string[] }>; routers: Array<{ taskId: string; areaId: string }> };
  const areaId = areas.routers.find((one) => one.taskId === routerId)!.areaId;
  expect(areas.areas.find((one) => one.id === areaId)!.folders).toEqual(['inbox', 'Projects/Alpha', 'Clients/Acme/Invoices']);
  await page.waitForTimeout(800);
  await glide(page, dialog.getByTestId('router-settings-close'));
  await dialog.getByTestId('router-settings-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(block.getByTestId('mail-router-folders-line')).toHaveText('Watches Inbox, Alpha, Invoices');

  // Reopened here: the two stay ticked.
  await glide(page, settings);
  await settings.click();
  await expect(option(dialog, 'Projects/Alpha').locator('input')).toBeChecked({ timeout: 30000 });
  await expect(option(dialog, 'Clients/Acme/Invoices').locator('input')).toBeChecked();
  await expect(option(dialog, 'inbox').locator('input')).toBeChecked();
  await expect(option(dialog, 'Projects/Beta').locator('input')).not.toBeChecked();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The same router on the Org page opens the same dialog with the same folders.
  const toOrg = block.getByTestId('mail-router-open-org');
  await glide(page, toOrg);
  await toOrg.click();
  const head = page.locator(`[data-testid="org-router-settings"][data-router-id="${routerId}"]`).getByTestId('org-router-settings-toggle');
  await expect(head).toBeVisible({ timeout: 30000 });
  await glide(page, head);
  await head.click();
  await expect(dialog).toHaveAttribute('data-router-id', routerId);
  await expect(option(dialog, 'Projects/Alpha').locator('input')).toBeChecked({ timeout: 30000 });
  await expect(option(dialog, 'Clients/Acme/Invoices').locator('input')).toBeChecked();
  await option(dialog, 'Clients/Acme/Invoices').scrollIntoViewIfNeeded();
  await glide(page, option(dialog, 'Clients/Acme/Invoices'));
  await page.waitForTimeout(2000);
  expect(patches).toHaveLength(1);
});
