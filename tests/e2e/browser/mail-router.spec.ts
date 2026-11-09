import fs from 'node:fs/promises';
import { expect, test, type Page, type Request as PwRequest } from '@playwright/test';
import { MailFixtureServer, type MailFixture, showAllMail } from './mail-review-helpers';

type MailItem = { accountId: string; messageId: string; subject: string };
type RoutedFixture = MailFixture & { routerRows: { ownerId: string; vpId: string; rows: Array<MailItem & { status: string }>; confirmed: MailItem; unassigned: MailItem[];
  handoffs: Array<MailItem & { status: 'pending' | 'denied' | 'expired' | 'claimed' }> } };
let server: MailFixtureServer;
let fixture: RoutedFixture;
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(180000);
test.beforeAll(async () => {
  server = new MailFixtureServer();
  fixture = await server.start({ PW_MAIL_ROUTER: '1', PW_MAIL_DENSE: '1' }) as RoutedFixture;
  await fs.mkdir('/tmp/router-mail', { recursive: true });
});
test.afterAll(async () => { await server?.stop(); });

async function capture(page: import('@playwright/test').Page, options: { path: string }) {
  const body = await page.screenshot(options);
  await test.info().attach(options.path.split('/').at(-1)!, { body, contentType: 'image/png' });
}

async function enterMail(page: import('@playwright/test').Page) {
  await showAllMail(page);
  const root = `http://127.0.0.1:${fixture.port}/`;
  await page.evaluate((url) => { window.location.assign(url); }, root);
  await page.waitForURL(root);
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90000 });
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
  await page.getByTestId('sidebar-core-app-mail').click();
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90000 });
}

// Linux WebKit reports a reload that cancels notes-prefetch.ts's per-document GETs as a pageerror, so reload only after they settle.
const NOTES_PREFETCH_PATHS = ['/api/notes-v2', '/api/notes-v2/list', '/api/notes-v2/tags'];
const NOTES_PREFETCH_WAIT_MS = 20000;

function trackNotesPrefetch(page: Page) {
  const origin = `http://127.0.0.1:${fixture.port}`;
  let done = new Set<string>();
  let inFlight = new Set<PwRequest>();
  let wake = () => {};
  const pathOf = (request: PwRequest): string | null => {
    if (request.method() !== 'GET') return null;
    const url = new URL(request.url());
    return url.origin === origin && NOTES_PREFETCH_PATHS.includes(url.pathname) ? url.pathname : null;
  };
  const onRequest = (request: PwRequest) => {
    // A new main-frame document starts a new round: only its own prefetch counts.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      done = new Set();
      inFlight = new Set();
      return;
    }
    if (pathOf(request)) inFlight.add(request);
  };
  const onDone = (request: PwRequest) => {
    if (!inFlight.delete(request)) return;
    done.add(pathOf(request)!);
    wake();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  const isSettled = () => inFlight.size === 0 && NOTES_PREFETCH_PATHS.every((path) => done.has(path));
  return {
    async settled(): Promise<void> {
      if (isSettled()) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = () => {};
          const missing = NOTES_PREFETCH_PATHS.filter((path) => !done.has(path));
          reject(new Error(`notes prefetch not settled after ${NOTES_PREFETCH_WAIT_MS}ms: never finished ${JSON.stringify(missing)}, in flight ${inFlight.size}`));
        }, NOTES_PREFETCH_WAIT_MS);
        wake = () => {
          if (!isSettled()) return;
          clearTimeout(timer);
          wake = () => {};
          resolve();
        };
      });
    },
    dispose(): void {
      wake = () => {};
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    },
  };
}

for (const status of ['task', 'vp', 'legacy', 'not_routed', 'failed', 'unknown', 'routing']) {
  test(`a dense inbox and the reader agree on the ${status} route`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await enterMail(page);
    const item = fixture.routerRows.rows.find((one) => one.status === status)!;
    const row = page.locator(`[data-testid="mail-row"][data-account-id="${item.accountId}"][data-message-id="${item.messageId}"]`);
    await expect(row).toBeVisible();
    const route = row.getByTestId('mail-row-route');
    const expected = ['task', 'vp', 'legacy'].includes(status) ? 'routed' : status;
    await expect(route).toHaveAttribute('data-route-status', expected);
    const words = (await route.textContent())!.replace(/\s+/g, ' ').trim();
    const detail = route.locator('.mail-route-detail');
    if (await detail.count()) {
      await expect(detail).toBeVisible();
      expect((await detail.boundingBox())!.width).toBeGreaterThan(40);
    }
    await row.click();
    await expect(page.getByTestId('mail-reader-route')).toHaveText(words);
    await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-area', 'personal');
    if (status === 'failed') await expect(page.getByTestId('mail-reader-route')).toContainText('Receiver was not ready');
    if (status === 'not_routed') await expect(page.getByTestId('mail-reader-route')).toContainText('Newsletter');
    await capture(page, { path: `/tmp/router-mail/${status}.png` });
    if (status === 'legacy') {
      await expect(route).toContainText('Previously handled by');
      await expect(page.getByTestId('mail-reader-route')).toContainText('Previously handled by');
      await expect(page.getByTestId('mail-reader-route')).not.toContainText('Routed to');
      await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('title', /The prior task recorded its review/);
    }
    if (status === 'task' || status === 'legacy') {
      await page.getByTestId('mail-reader-route-link').click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('.todo-panel').getByText('Review the dock reservation', { exact: true })).toBeVisible();
    } else if (status === 'vp') {
      await page.getByTestId('mail-reader-route-link').click();
      await expect(page.getByTestId('org-detail-title')).toContainText('Dock');
    } else {
      await expect(page.getByTestId('mail-reader-route-link')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

test('a mail with no receipt says on its row and in the reader that it was not routed and why, and scrolling and reload keep rows usable', async ({ page }) => {
  await enterMail(page);
  const item = fixture.routerRows.unassigned[0]!;
  const row = rowOf(page, item);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  const notRouted = /^Not routed · No (area chosen for this message|router reads this account)$/;
  const rowLine = row.getByTestId('mail-row-route');
  await expect(rowLine).toHaveAttribute('data-route-status', 'none');
  await expect(rowLine).toHaveText(notRouted);
  // One line on the row: no taller than the line height of its text.
  expect((await rowLine.boundingBox())!.height).toBeLessThan(22);
  await row.click({ position: { x: 14, y: 12 } });
  const reader = page.getByTestId('mail-reader-route');
  await expect(reader).toHaveAttribute('data-route-status', 'none');
  await expect(reader).toHaveText(notRouted);
  expect((await reader.textContent())?.trim()).toBe((await rowLine.textContent())?.trim());
  await page.setViewportSize({ width: 900, height: 760 });
  await page.mouse.wheel(0, 500);
  await page.reload();
  await expect(page.getByTestId('mail-row').first()).toBeVisible();
  await capture(page, { path: '/tmp/router-mail/no-record-narrow.png' });
});

const rowOf = (page: import('@playwright/test').Page, item: MailItem) =>
  page.locator(`[data-testid="mail-row"][data-account-id="${item.accountId}"][data-message-id="${item.messageId}"]`);

async function openItem(page: import('@playwright/test').Page, item: MailItem) {
  const row = rowOf(page, item);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('mail-reader-route')).toBeVisible();
}

test('a routing link opens its task without opening or marking the email, with click and keyboard', async ({ page }) => {
  await enterMail(page);
  const item = fixture.routerRows.rows.find((one) => one.status === 'task')!;
  const mailCalls: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/plugins/mail/')) mailCalls.push(request.url());
  });
  const link = rowOf(page, item).getByTestId('mail-row-route-link');
  await link.click();
  await expect(page).toHaveURL(/\/$/);
  // The task's details open over Home (a routed task often has no session); Escape closes them.
  await expect(page.locator('.wf-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.wf-modal')).toHaveCount(0);
  expect(mailCalls).toEqual([]);
  await page.getByTestId('sidebar-core-app-mail').click();
  await expect(rowOf(page, item)).toBeVisible();
  await rowOf(page, item).getByTestId('mail-row-route-link').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.wf-modal')).toBeVisible();
  expect(mailCalls).toEqual([]);
});

test('opening unread routed mail and refreshing its cached envelope keeps the receipt through search', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const item = fixture.routerRows.rows.find(one => one.status === 'routing')!;
  const messageUrl = `http://127.0.0.1:${fixture.port}/api/plugins/mail/messages/${encodeURIComponent(item.accountId)}/${encodeURIComponent(item.messageId)}`;
  const unread = await page.request.post(`${messageUrl}/read`, { data: { read: false } });
  expect(unread.ok()).toBe(true);
  const beforeResponse = await page.request.get(messageUrl);
  expect(beforeResponse.ok()).toBe(true);
  const before = await beforeResponse.json();
  expect(before.body).not.toBeNull();
  expect(before.message.route.status).toBe('routing');
  await enterMail(page);
  await rowOf(page, item).click();
  await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', 'routing');
  for (let cycle = 0; cycle < 3; cycle++) {
    const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/plugins/mail/refresh');
    await page.getByTestId('mail-refresh').click();
    expect((await response).status()).toBe(200);
    await expect(page.getByTestId('mail-refresh')).toBeEnabled();
    const search = page.getByTestId('mail-search-input');
    await search.fill(item.subject);
    await search.press('Enter');
    const row = rowOf(page, item);
    await expect(row.getByTestId('mail-row-route')).toHaveAttribute('data-route-status', 'routing');
    await row.click();
    await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', 'routing');
    const afterResponse = await page.request.get(messageUrl);
    expect(afterResponse.ok()).toBe(true);
    const after = await afterResponse.json();
    expect(after.message.deliveryVersion).toBe(before.message.deliveryVersion);
    expect(after.message.route).toEqual(before.message.route);
    expect(after.message.flags).toContain('\\Seen');
    await page.getByTestId('mail-search-clear').click();
  }
  await capture(page, { path: '/tmp/router-mail/refresh-receipt-stable.png' });
  expect(errors).toEqual([]);
});

test('search and grouped view retain routing receipts, and live events update the open reader without mail writes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterMail(page);
  const item = fixture.routerRows.rows.find((one) => one.status === 'routing')!;
  const search = page.getByTestId('mail-search-input');
  await search.fill(item.subject);
  await search.press('Enter');
  const row = rowOf(page, item);
  await expect(row.getByTestId('mail-row-route')).toHaveAttribute('data-route-status', 'routing');
  await row.click();
  await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', 'routing');
  const mailWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/plugins/mail/')) mailWrites.push(request.url());
  });
  const at = Date.now() + 10000;
  const changed = await page.request.post(`http://127.0.0.1:${fixture.port}/__fixture/router-event`, { data: { ...item, status: 'unknown', at } });
  expect(changed.ok()).toBe(true);
  await expect(row.getByTestId('mail-row-route')).toHaveAttribute('data-route-status', 'unknown');
  await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', 'unknown');
  const late = await page.request.post(`http://127.0.0.1:${fixture.port}/__fixture/router-event`, { data: { ...item, status: 'routing', at: at - 1 } });
  expect(late.ok()).toBe(true);
  await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', 'unknown');
  expect(mailWrites).toEqual([]);
  await capture(page, { path: '/tmp/router-mail/search-live.png' });
  await page.getByTestId('mail-search-clear').click();
  await page.getByTestId('mail-view-menu').click();
  await page.getByTestId('mail-view-menu-list').getByText('Grouped', { exact: true }).click();
  await expect(page.getByTestId('mail-view-menu')).toHaveAttribute('data-grouped', 'true');
  const routed = fixture.routerRows.rows.find((one) => one.status === 'task')!;
  const mark = await page.request.post(`http://127.0.0.1:${fixture.port}/api/plugins/mail/messages/${encodeURIComponent(routed.accountId)}/${encodeURIComponent(routed.messageId)}/read`, { data: { read: false } });
  expect(mark.ok()).toBe(true);
  const view = page.getByTestId('mail-view-menu');
  await view.click();
  const unreadOnly = page.getByTestId('mail-view-menu-list').getByRole('menuitemcheckbox', { name: 'Unread important mail only', exact: true });
  await expect(unreadOnly).toBeVisible();
  if (await unreadOnly.getAttribute('aria-checked') === 'true') await unreadOnly.click();
  else await page.keyboard.press('Escape');
  const groupedRow = rowOf(page, routed);
  if (!(await groupedRow.isVisible())) {
    for (const group of await page.locator('[data-testid="mail-group-row"][aria-expanded="false"]').all()) await group.click();
  }
  await expect(groupedRow.getByTestId('mail-row-route')).toHaveAttribute('data-route-status', 'routed');
  await capture(page, { path: '/tmp/router-mail/grouped.png' });
  expect(errors).toEqual([]);
});

test('mail setup opens the existing area router without granting account access', async ({ page }) => {
  await enterMail(page);
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.getByTestId('mail-pane-menu').click();
  await page.getByTestId('mail-pane-menu-popup').getByRole('menuitem', { name: 'Set up routing in Org', exact: true }).click();
  const form = page.getByTestId('org-router-setup');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('router-setup-existing')).toContainText('Personal mail router');
  await form.getByTestId('router-setup-open-existing').click();
  await expect(page.getByTestId('org-detail-title')).toContainText('Personal mail router');
  expect(writes.filter((url) => url.includes('/api/v1/router/assign') || url.includes('/api/v1/org/routers') || url.includes('/api/plugins/mail/'))).toEqual([]);
  await capture(page, { path: '/tmp/router-mail/setup-reuse.png' });
});

test('Mail lists the area router with its live state, and it opens at Org level, beside the VPs in the chart', async ({ page }) => {
  await enterMail(page);
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
  const group = page.getByTestId('mail-routers');
  await expect(group).toBeVisible();
  const row = group.getByTestId('mail-router-row').filter({ hasText: 'Personal mail router' });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('mail-router-state')).toHaveText('Paused');
  await expect(row).toHaveAttribute('data-router-state', 'paused');
  // At the narrowest pane the whole name still shows: it wraps above its state, never "Personal mail r…".
  const splitter = page.getByTestId('mail-splitter-accounts');
  await splitter.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '168');
  const cut = await row.getByTestId('mail-router-name').evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(cut).toBe(false);
  const [nameBox, stateBox] = await Promise.all([row.getByTestId('mail-router-name').boundingBox(), row.getByTestId('mail-router-state').boundingBox()]);
  expect(stateBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
  await capture(page, { path: '/tmp/router-mail/router-row-narrow.png' });
  const routerId = await row.getAttribute('data-task-id');
  await row.click();
  await expect(page.getByTestId('org-detail-title')).toContainText('Personal mail router');
  await expect(page.locator(`[data-testid="org-channel-router"][data-key="router:${routerId}"]`)).toHaveAttribute('aria-selected', 'true');
  // The chart draws it in the VPs' row, as a router, and a click opens its own node.
  await page.getByTestId('org-open-chart').click();
  const card = page.getByTestId('org-chart-router').filter({ hasText: 'Personal mail router' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Router');
  await expect(page.getByTestId('org-chart-vps').getByTestId('org-chart-router').first()).toBeVisible();
  await expect(page.getByTestId('org-chart-empty')).toHaveCount(0);
  // Keyboard opens it as a click does.
  await card.getByTestId('org-chart-router-open').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('org-chart')).toHaveCount(0);
  await expect(page.getByTestId('org-detail-title')).toContainText('Personal mail router');
  expect(writes.filter((url) => url.includes('/api/v1/router/assign') || url.includes('/api/v1/org/routers') || url.includes('/api/plugins/mail/'))).toEqual([]);
  await capture(page, { path: '/tmp/router-mail/router-at-org-level.png' });
});

test('a late area confirmation never appears on another email, and returning reads the server confirmation', async ({ page }) => {
  await enterMail(page);
  const item = fixture.routerRows.unassigned[2]!;
  const other = fixture.routerRows.confirmed;
  await openItem(page, item);
  await page.getByTestId('mail-router-choose').click();
  const form = page.getByTestId('mail-router-form');
  await form.getByRole('radio', { name: 'Personal', exact: true }).check();
  let held: import('@playwright/test').Route | undefined;
  let seen!: () => void;
  const intercepted = new Promise<void>((resolve) => { seen = resolve; });
  await page.route('**/api/v1/router/assign', (route) => { held = route; seen(); }, { times: 1 });
  try {
    await form.getByTestId('mail-router-confirm').click();
    await intercepted;
    await openItem(page, other);
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    const answered = page.waitForResponse((response) => response.url().includes('/api/v1/router/assign'));
    await held!.continue();
    held = undefined;
    await answered;
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    await expect(page.getByTestId('mail-router-form')).toHaveCount(0);
    // The late answer still lands on its own row, never on the open one.
    await expect(rowOf(page, item).getByTestId('mail-row-route')).toContainText('Confirmed for Personal');
    await openItem(page, item);
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    await expect(page.getByTestId('mail-router-choose')).toHaveCount(0);
    await capture(page, { path: '/tmp/router-mail/late-confirm.png' });
  } finally {
    if (held) await held.abort().catch(() => {});
    await page.unroute('**/api/v1/router/assign');
  }
});

test('an item confirmed for an area says so, for this message only, never routed, across a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const prefetch = trackNotesPrefetch(page);
  try {
    await enterMail(page);
    const item = fixture.routerRows.confirmed;
    await openItem(page, item);
    // The row and the reader head say the same thing: confirmed for the area, nothing routed yet.
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    await expect(page.getByTestId('mail-reader-route')).not.toContainText(/No router has seen this|Routed to/);
    await expect(rowOf(page, item).getByTestId('mail-row-route')).toContainText('Confirmed for Personal');
    const confirmed = page.getByTestId('mail-router-confirmed');
    await expect(confirmed).toContainText('This message only');
    await expect(confirmed).not.toContainText('Routed to');
    await expect(page.getByTestId('mail-router-choose')).toHaveCount(0);
    await prefetch.settled();
    await page.reload();
    await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90000 });
    await openItem(page, item);
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    await capture(page, { path: '/tmp/router-mail/confirmed-item.png' });
    expect(errors).toEqual([]);
  } finally {
    prefetch.dispose();
  }
});

test('an unknown item of a known account needs Choose area: cancel, a failed confirm keeps the pick, a retry confirms only it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const prefetch = trackNotesPrefetch(page);
  try {
    await enterMail(page);
    const [item, other] = fixture.routerRows.unassigned;
    await openItem(page, item!);
    await expect(page.getByTestId('mail-router-confirmed')).toHaveCount(0);
    await page.getByTestId('mail-router-choose').click();
    const form = page.getByTestId('mail-router-form');
    await expect(form).toContainText('This confirms this message only');
    await expect(form.getByRole('radio', { name: 'Personal', exact: true })).toBeVisible();
    await expect(form.locator('select')).toHaveCount(0);
    await form.getByTestId('mail-router-cancel').click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId('mail-router-choose')).toBeVisible();

    await page.getByTestId('mail-router-choose').click();
    await form.getByRole('radio', { name: 'Personal', exact: true }).check();
    let failed = 0;
    await page.route('**/api/v1/router/assign', async (route) => {
      failed++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Router areas are busy' }) });
    }, { times: 1 });
    await form.getByTestId('mail-router-confirm').click();
    await expect(form.getByTestId('mail-router-error')).toBeVisible();
    expect(failed).toBe(1);
    await expect(form.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
    await expect(form.getByTestId('mail-router-confirm')).toHaveText('Try again');
    await expect(page.getByTestId('mail-router-confirmed')).toHaveCount(0);
    await form.getByTestId('mail-router-confirm').click();
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    // The detail follows the area's router as the server has it now (another spec may have left it paused):
    // a reading router is just pending; a paused one says so and offers the router to resume it.
    const areas = await (await page.request.get('/api/v1/router/areas')).json() as { routers?: Array<{ areaId: string; paused?: boolean }> };
    const reading = (areas.routers ?? []).some((r) => r.areaId === 'personal' && r.paused === false);
    await expect(page.getByTestId('mail-reader-route')).toContainText(reading ? 'Routing pending' : 'Its router is paused');
    await expect(page.getByTestId('mail-reader-route-action')).toHaveCount(reading ? 0 : 1);
    await expect(page.getByTestId('mail-reader-route')).not.toContainText('Routed to');
    await expect(page.getByTestId('mail-router-confirmed')).toContainText('This message only');
    // The list row learns it at once, before any reload.
    await expect(rowOf(page, item!).getByTestId('mail-row-route')).toContainText('Confirmed for Personal');

    // Only that message: another one of the same account still asks.
    await openItem(page, other!);
    await expect(page.getByTestId('mail-router-choose')).toBeVisible();
    await expect(page.getByTestId('mail-router-confirmed')).toHaveCount(0);

    // The server keeps the confirmation: after a reload it reads from the message, not from the page.
    await prefetch.settled();
    await page.reload();
    await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90000 });
    await openItem(page, item!);
    await expect(page.getByTestId('mail-reader-route')).toContainText('Confirmed for Personal');
    await expect(page.getByTestId('mail-router-choose')).toHaveCount(0);
    await page.setViewportSize({ width: 900, height: 760 });
    await capture(page, { path: '/tmp/router-mail/choose-area-confirmed.png' });
    expect(errors).toEqual([]);
  } finally {
    prefetch.dispose();
  }
});

test('a handoff ask reads the same on the row and the reader: never routed, no link, no Choose area, narrow too', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterMail(page);
  const leads = { pending: 'Waiting for approval', denied: 'Handoff not approved', expired: 'Handoff approval expired', claimed: 'Handoff state unknown' };
  for (const item of fixture.routerRows.handoffs) {
    const row = rowOf(page, item);
    await row.scrollIntoViewIfNeeded();
    const line = row.getByTestId('mail-row-route');
    await expect(line).toHaveAttribute('data-route-status', 'handoff');
    await expect(line).toContainText(leads[item.status]);
    await expect(line).toContainText('Pantry shelf inventory');
    await expect(row.getByTestId('mail-row-route-link')).toHaveCount(0);
    const words = (await line.textContent())!.replace(/\s+/g, ' ').trim();
    const detail = line.locator('.mail-route-detail');
    await expect(detail).toBeVisible();
    expect((await detail.boundingBox())!.width).toBeGreaterThan(40);
    await openItem(page, item);
    const reader = page.getByTestId('mail-reader-route');
    await expect(reader).toHaveText(words);
    await expect(reader).not.toContainText(/Routed to|Not routed|No router has seen this/);
    await expect(page.getByTestId('mail-reader-route-link')).toHaveCount(0);
    await expect(page.getByTestId('mail-router-choose')).toHaveCount(0);
    await expect(page.getByTestId('mail-router-confirmed')).toHaveCount(0);
  }
  await capture(page, { path: '/tmp/router-mail/handoff-wide.png' });
  await page.setViewportSize({ width: 900, height: 760 });
  const pending = fixture.routerRows.handoffs.find((one) => one.status === 'pending')!;
  await page.getByTestId('mail-reader-back').click();
  await expect(rowOf(page, pending).getByTestId('mail-row-route')).toContainText('Waiting for approval');
  await capture(page, { path: '/tmp/router-mail/handoff-narrow-list.png' });
  await openItem(page, pending);
  await expect(page.getByTestId('mail-reader-route')).toContainText('Waiting for approval');
  await capture(page, { path: '/tmp/router-mail/handoff-narrow.png' });
  expect(errors).toEqual([]);
});

// 2026-11-07: a group that first showed up while the pointer was away from the grouped list had no
// held row, so reading its only unread under the pointer dropped the group, and the receipt row
// with it, in the same frame, while the reader still showed that mail. Read state is set through the
// fixture's canned provider (no real account) and the pointer is the real one.
test('a group read to zero under the pointer keeps its receipt row until the pointer leaves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const api = `http://127.0.0.1:${fixture.port}/api/plugins/mail`;
  const messageUrl = (item: MailItem) => `${api}/messages/${encodeURIComponent(item.accountId)}/${encodeURIComponent(item.messageId)}`;
  const setRead = async (item: MailItem, read: boolean) => {
    const response = await page.request.post(`${messageUrl(item)}/read`, { data: { read } });
    expect(response.ok(), `read=${read} on ${item.messageId}`).toBe(true);
  };
  type Listed = MailItem & { flags: string[]; sort?: { group: string } };
  const unreadIn = async (group: string): Promise<Listed[]> => {
    const response = await page.request.get(`${api}/messages?scope=role:inbox&group=${encodeURIComponent(group)}&unread=1&limit=100`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { messages: Listed[] }).messages;
  };
  const groupIds = async (): Promise<string[]> => {
    const response = await page.request.get(`${api}/groups?scope=role:inbox`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { groups: Array<{ id: string }> }).groups.map((one) => one.id);
  };
  const same = (a: MailItem, b: MailItem) => a.accountId === b.accountId && a.messageId === b.messageId;

  // A receipt row sorted into a group other than Important (unread for the lookup only).
  let item: MailItem | undefined;
  let groupId = '';
  for (const status of ['task', 'vp', 'legacy', 'failed', 'not_routed', 'unknown', 'routing']) {
    const candidate = fixture.routerRows.rows.find((one) => one.status === status);
    if (!candidate) continue;
    await setRead(candidate, false);
    for (const id of await groupIds()) {
      if ((await unreadIn(id)).some((one) => same(one, candidate))) { item = candidate; groupId = id; break; }
    }
    if (item) break;
    await setRead(candidate, true);
  }
  expect(item, 'the router fixture sorts at least one receipt row into a group of its own').toBeTruthy();
  // It is that group's only unread mail, and the group is not in any /groups answer yet.
  for (const other of await unreadIn(groupId)) if (!same(other, item!)) await setRead(other, true);
  await setRead(item!, true);
  expect(await groupIds()).not.toContain(groupId);

  await enterMail(page);
  const viewMenu = page.getByTestId('mail-view-menu');
  if (await viewMenu.getAttribute('data-grouped') === 'true') {
    await viewMenu.click();
    await page.getByTestId('mail-view-menu-list').getByText('All mail', { exact: true }).click();
    await expect(viewMenu).toHaveAttribute('data-grouped', 'false');
  }
  // In All mail: open the mail (read), then Mark as unread in the reader.
  await openItem(page, item!);
  const markButton = page.getByTestId('mail-mark-read');
  await expect(markButton).toHaveAttribute('aria-label', 'Mark as unread');
  const unreadWrite = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === new URL(`${messageUrl(item!)}/read`).pathname);
  await markButton.click();
  expect((await unreadWrite).ok()).toBe(true);
  await expect(markButton).toHaveAttribute('aria-label', 'Mark as read');
  expect(await unreadIn(groupId)).toHaveLength(1);

  // Into Grouped: the group arrives with its one unread while the pointer is on the view menu.
  await viewMenu.click();
  await page.getByTestId('mail-view-menu-list').getByText('Grouped', { exact: true }).click();
  await expect(viewMenu).toHaveAttribute('data-grouped', 'true');
  const group = page.locator(`[data-testid="mail-group"][data-group-id="${groupId}"]`);
  await expect(group).toBeVisible({ timeout: 30000 });
  await expect(group.getByTestId('mail-group-row')).toHaveAttribute('aria-expanded', 'true');
  await expect(group.getByTestId('mail-group-unread')).toHaveText('1');
  const kid = group.locator(`[data-testid="mail-row"][data-account-id="${item!.accountId}"][data-message-id="${item!.messageId}"]`);
  await expect(kid).toBeVisible({ timeout: 30000 });
  await expect(kid).toHaveAttribute('data-unread', 'true');
  const route = kid.getByTestId('mail-row-route');
  const routeStatus = (await route.getAttribute('data-route-status'))!;
  expect(routeStatus).toBeTruthy();
  const routeWords = (await route.textContent())!.replace(/\s+/g, ' ').trim();

  // The real pointer goes onto the row and presses it: the mail is read, the group reads 0 and stays.
  await kid.hover();
  const readWrite = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === new URL(`${messageUrl(item!)}/read`).pathname);
  const refetched = page.waitForResponse(async (r) => {
    if (r.request().method() !== 'GET' || new URL(r.url()).pathname !== '/api/plugins/mail/groups' || !r.ok()) return false;
    const body = await r.json() as { groups: Array<{ id: string }> };
    return !body.groups.some((one) => one.id === groupId);
  }, { timeout: 15000 });
  // Pressed near its left edge: the row's middle can be its route link, which opens the task instead.
  await kid.click({ position: { x: 14, y: 12 } });
  await expect(group).toBeVisible();
  await expect(group.getByTestId('mail-group-unread')).toHaveText('0');
  await expect(kid).toBeVisible();
  await expect(kid).toHaveAttribute('data-unread', 'false');
  await expect(route).toHaveAttribute('data-route-status', routeStatus);
  await expect(page.getByTestId('mail-reader-route')).toHaveAttribute('data-route-status', routeStatus);
  await expect(page.getByTestId('mail-reader-route')).toHaveText(routeWords);
  expect((await readWrite).ok()).toBe(true);
  expect(await unreadIn(groupId)).toHaveLength(0);
  // A /groups read that lands after the server's flip (it no longer lists the group) keeps it too.
  await refetched;
  await expect(group).toBeVisible();
  await expect(kid).toBeVisible();
  await expect(route).toHaveText(routeWords);
  await expect(page.getByTestId('mail-reader-route')).toHaveText(routeWords);
  await capture(page, { path: '/tmp/router-mail/grouped-held-at-zero.png' });

  // The pointer leaves the list: the spent group goes; the reader keeps the same mail and receipt.
  const sidebar = (await page.locator('.sidebar').boundingBox())!;
  await page.mouse.move(sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2);
  await expect(group).toHaveCount(0);
  await expect(page.locator(`[data-testid="mail-row"][data-account-id="${item!.accountId}"][data-message-id="${item!.messageId}"]`)).toHaveCount(0);
  await expect(page.getByTestId('mail-reader-route')).toHaveText(routeWords);
  await capture(page, { path: '/tmp/router-mail/grouped-released.png' });
  expect(errors).toEqual([]);
});
