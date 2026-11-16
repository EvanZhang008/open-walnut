import fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { MailFixtureServer, type MailFixture, showAllMail } from './mail-review-helpers';

/**
 * Talk to the router, the CEO or any VP about one mail, and New task, from the Mail reader, clicked
 * the way a person does (2026-11-16, the user: "a button to talk to router, talk to COE, create new
 * task, or talk to any VP by selection").
 *
 *   a. A routed mail's reader shows Ask router under the route line; it opens the Talk to box
 *      addressed to the router of the mail's area, its To row naming the CEO, the router and the VP.
 *   b. Send posts the person's words, the mail (with the router's decision as its summary) and the
 *      router's id; the answer names the router, and Open chat shows the router's chat.
 *   c. The toolbar's Talk to CEO opens on the CEO; a press on the VP's name readdresses the box
 *      (title, placeholder) and Send reaches that VP's chat.
 *   d. New task is still there and opens a draft, making nothing.
 * Runs on the router mail fixture's own server, whose sessions run the repo's mock CLI.
 */

type MailItem = { accountId: string; messageId: string; subject: string };
type RoutedFixture = MailFixture & { routerRows: { ownerId: string; vpId: string; rows: Array<MailItem & { status: string }> } };
const SHOTS = '/tmp/mail-talk-to';
let server: MailFixtureServer;
let fixture: RoutedFixture;
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(240_000);

test.beforeAll(async () => {
  server = new MailFixtureServer();
  fixture = await server.start({ PW_MAIL_ROUTER: '1', PW_MAIL_DENSE: '1' }) as RoutedFixture;
  await fs.mkdir(SHOTS, { recursive: true });
});
test.afterAll(async () => { await server?.stop(); });

async function enterMail(page: Page) {
  await showAllMail(page);
  const root = `http://127.0.0.1:${fixture.port}/`;
  await page.evaluate((url) => { window.location.assign(url); }, root);
  await page.waitForURL(root);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90_000 });
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
  await page.getByTestId('sidebar-core-app-mail').click();
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90_000 });
}

async function openRouted(page: Page, item: MailItem) {
  await page.getByTestId('sidebar-core-app-mail').click();
  const row = page.locator(`[data-testid="mail-row"][data-account-id="${item.accountId}"][data-message-id="${item.messageId}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByTestId('mail-reader-subject')).toHaveText(item.subject, { timeout: 30_000 });
}

async function api<T>(path: string): Promise<T> {
  return await (await fetch(`http://127.0.0.1:${fixture.port}${path}`)).json() as T;
}

test('Ask router, Talk to CEO or a VP, and New task, from one routed mail', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/content/ceo') && r.method() === 'POST') posts.push(JSON.parse(r.postData() ?? '{}'));
  });
  await enterMail(page);
  const item = fixture.routerRows.rows.find((one) => one.status === 'vp')!;
  const targets = (await api<{ targets: Array<{ id: string; kind: string; name: string; areaId?: string }> }>('/api/v1/content/targets')).targets;
  const router = targets.find((t) => t.kind === 'router' && t.areaId === 'personal')!;
  const vp = targets.find((t) => t.id === fixture.routerRows.vpId)!;
  expect(router.name).toBe('Personal mail router');
  expect(vp.kind).toBe('vp');

  // ── (a) Ask router, under the route line ──
  await openRouted(page, item);
  const ask = page.getByTestId('mail-reader-ask-router');
  await expect(ask).toBeVisible();
  const routeBox = (await page.getByTestId('mail-reader-route').boundingBox())!;
  const askBox = (await ask.boundingBox())!;
  expect(askBox.y).toBeGreaterThanOrEqual(routeBox.y + routeBox.height - 1);
  await page.locator('.mail-reader-head').screenshot({ path: `${SHOTS}/reader-head.png` });
  await ask.click();
  const box = page.getByTestId('ceo-composer');
  const input = page.getByTestId('ceo-composer-input');
  await expect(box).toBeVisible();
  await expect(input).toBeFocused();
  await expect(box).toHaveAttribute('data-target-kind', 'router');
  await expect(box).toHaveAttribute('data-target-id', router.id);
  await expect(box.locator('.ceo-composer-head')).toContainText('Talk to Personal mail router');
  const options = box.getByTestId('ceo-composer-to-option');
  await expect(options.first()).toHaveText('CEO');
  await expect(box.getByRole('radio', { name: 'Personal mail router' })).toHaveAttribute('aria-checked', 'true');
  await expect(box.getByRole('radio', { name: vp.name })).toHaveAttribute('aria-checked', 'false');
  await expect(input).toHaveAttribute('placeholder', 'What do you want to tell Personal mail router about this?');
  // A second press on Ask router closes it, sending nothing.
  await ask.click();
  await expect(box).toHaveCount(0);
  expect(posts).toEqual([]);

  // ── (b) Send to the router ──
  await ask.click();
  await expect(box).toHaveAttribute('data-target-kind', 'router');
  await input.fill('Why did this go to the Dock VP? It is about lunch.');
  await page.screenshot({ path: `${SHOTS}/ask-router-box.png` });
  const toRouter = page.waitForResponse((r) => r.url().endsWith('/api/v1/content/ceo'));
  await page.getByTestId('ceo-composer-send').click();
  const routerAnswer = await (await toRouter).json() as { taskId: string; sessionId: string | null; to?: { id: string; kind: string } };
  expect(routerAnswer.to).toMatchObject({ id: router.id, kind: 'router' });
  expect(routerAnswer.taskId).toBe(router.id);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ note: 'Why did this go to the Dock VP? It is about lunch.', to: router.id });
  const posted = posts[0].item as Record<string, string>;
  expect(posted.title).toBe(item.subject);
  expect(posted.open).toBe(`/mail?${new URLSearchParams({ account: item.accountId, message: item.messageId })}`);
  // The router's own decision rides along, in the reader's words.
  expect(posted.summary).toMatch(/^Router: Routed to Dock VP/);
  await expect(box).toHaveCount(0);
  const routerToast = page.locator('.notification-toast').filter({ hasText: 'Sent to Personal mail router' }).first();
  await expect(routerToast).toBeVisible({ timeout: 30_000 });
  await routerToast.locator('.notification-toast-action', { hasText: 'Open chat' }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${fixture.port}/`);
  await expect(page.locator(`[data-session-id="${routerAnswer.sessionId}"]`).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/router-chat.png` });

  // ── (c) Talk to CEO opens on the CEO; picking the VP readdresses it ──
  await openRouted(page, item);
  const talk = page.getByTestId('content-action-talk_to_ceo');
  await talk.click();
  await expect(box).toHaveAttribute('data-target-kind', 'ceo');
  await expect(box.getByRole('radio', { name: 'CEO' })).toHaveAttribute('aria-checked', 'true');
  await box.getByRole('radio', { name: vp.name }).click();
  await expect(box).toHaveAttribute('data-target-id', vp.id);
  await expect(box.locator('.ceo-composer-head')).toContainText(`Talk to ${vp.name}`);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', `What do you want to tell ${vp.name} about this?`);
  await page.keyboard.type('Please handle this lunch mail.');
  await page.screenshot({ path: `${SHOTS}/vp-box.png` });
  const toVp = page.waitForResponse((r) => r.url().endsWith('/api/v1/content/ceo'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  const vpAnswer = await (await toVp).json() as { taskId: string; sessionId: string | null; to?: { id: string; kind: string } };
  expect(vpAnswer.to).toMatchObject({ id: vp.id, kind: 'vp' });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ note: 'Please handle this lunch mail.', to: vp.id });
  const vpToast = page.locator('.notification-toast').filter({ hasText: `Sent to ${vp.name}` }).first();
  await expect(vpToast).toBeVisible({ timeout: 30_000 });
  await vpToast.locator('.notification-toast-action', { hasText: 'Open chat' }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${fixture.port}/`);
  await expect(page.locator(`[data-session-id="${vpAnswer.sessionId}"]`).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/vp-chat.png` });

  // The CEO still takes it with no `to` (an unchanged pick sends as before).
  await openRouted(page, item);
  await talk.click();
  await expect(box).toHaveAttribute('data-target-kind', 'ceo');
  await input.fill('FYI for the CEO');
  const toCeo = page.waitForResponse((r) => r.url().endsWith('/api/v1/content/ceo'));
  await page.getByTestId('ceo-composer-send').click();
  const ceoAnswer = await (await toCeo).json() as { to?: { kind: string } };
  expect(ceoAnswer.to?.kind).toBe('ceo');
  expect(posts[2]).not.toHaveProperty('to');
  await expect(page.locator('.notification-toast').filter({ hasText: 'Sent to the CEO' }).first()).toBeVisible({ timeout: 30_000 });

  // ── (d) New task is still beside it and makes nothing by itself ──
  const before = (await api<{ tasks: unknown[] }>('/api/tasks?fields=list')).tasks.length;
  await openRouted(page, item);
  await page.getByTestId('content-action-new_task').click();
  await expect(page).toHaveURL(`http://127.0.0.1:${fixture.port}/`);
  await expect(page.locator('.chat-input-textarea').filter({ hasText: '' }).first()).toBeVisible({ timeout: 30_000 });
  expect((await api<{ tasks: unknown[] }>('/api/tasks?fields=list')).tasks.length).toBe(before);

  expect(errors).toEqual([]);
});
