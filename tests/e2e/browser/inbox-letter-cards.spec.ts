import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { home } from './inbox-items-helpers';

const nonce = Date.now().toString(36);
const subject = `For you: Interview reminder ${nonce}`;
let id = '';
let htmlId = '';
const evidence = process.env.PW_EVIDENCE_DIR;

test.describe.configure({ mode: 'serial' });
test.use({ video: process.env.PW_VIDEO ? { mode: 'on', size: { width: 1100, height: 800 } } : 'off' });
test.beforeAll(async ({ request }) => {
  test.setTimeout(180_000);
  const body = '**From:** coordinator@example.invalid\n**Subject:** Interview reminder\n\n**Why it is yours:** Please confirm the interview time.\n\n## Details\n\n- Join at 10:00\n- Bring your notes\n\n' + 'A longer paragraph with preparation details.\n\n'.repeat(60) + 'End of the letter.';
  for (let i = 0; i < 329; i++) {
    const res = await request.post('/api/v1/human-inbox', { data: {
      subject: i === 328 ? subject : i === 327 ? `Parking change ${nonce}` : `Letter ${nonce} ${i}`,
      type: i === 328 ? 'review' : 'info',
      ...(i === 327 ? { html: '<h2>Parking change</h2><p>Use the north entrance.</p><script>window.cardScriptRan=true</script>' }
        : { markdown: i === 328 ? body : '# Notice\n\nPlease check the schedule.\n\nFurther details go here.' }),
    } });
    expect(res.status()).toBe(201);
    const created = await res.json();
    if (i === 328) id = created.id;
    if (i === 327) htmlId = created.id;
  }
});

async function inbox(page: Page) {
  await home(page);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.locator('.notification-panel');
  await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click();
  const row = panel.locator(`[data-letter-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  return { panel, row };
}

test('dense cards stay short and expand formatted letters in place without losing actions', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { panel, row } = await inbox(page);
  expect(await panel.locator('.hib-row').count()).toBeGreaterThanOrEqual(329);
  await expect(row.locator('.hib-preview')).toHaveText('Please confirm the interview time.');
  const collapsed = (await row.boundingBox())!.height;
  expect(await row.locator('.hib-preview').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(20);
  await expect(row.locator('.hib-card-content')).toHaveCount(0);
  if (evidence) { await fs.mkdir(evidence, { recursive: true }); await panel.screenshot({ path: path.join(evidence, 'collapsed.png') }); }
  await row.getByRole('button', { name: 'Read letter', exact: true }).click();
  await expect(row.locator('.hib-md-body h2')).toHaveText('Details');
  await expect(row.locator('.hib-md-body li')).toHaveCount(2);
  await expect(page.locator('.hib-reader-overlay')).toHaveCount(0);
  await row.locator('.hib-md-body').click({ button: 'right' });
  await expect(page.getByTestId('letter-ctx-menu')).toHaveCount(0);
  await expect.poll(async () => (await row.boundingBox())!.height).toBeGreaterThan(collapsed + 100);
  if (evidence) await panel.screenshot({ path: path.join(evidence, 'expanded.png') });
  await row.locator('.hib-md-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(row.locator('.hib-md-body')).toContainText('End of the letter.');
  await row.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect.poll(async () => (await row.boundingBox())!.height).toBeLessThan(collapsed + 5);
  await row.getByRole('button', { name: 'Read letter', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('button', { name: 'Collapse', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await row.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(row).toHaveClass(/hib-pinned/);
  await row.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Mark unread', exact: true })).toBeVisible();
  const detail = await (await request.get(`/api/v1/human-inbox/${id}`)).json();
  expect(detail.letter ?? detail).toMatchObject({ pinned: true, read: true });
  await row.getByRole('button', { name: 'Open full letter', exact: true }).click();
  await expect(page.locator('.hib-reader-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.hib-reader-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('body failure retries and a late response cannot reopen a collapsed card', async ({ page }) => {
  const { row } = await inbox(page);
  let fail = true;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v1/human-inbox/${id}`, async (route) => {
    if (fail) { await route.fulfill({ status: 503, body: 'Unavailable' }); return; }
    await held; await route.continue();
  });
  try {
    await row.getByRole('button', { name: 'Read letter', exact: true }).click();
    await expect(row.getByRole('alert')).toContainText('Could not load');
    fail = false;
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await row.getByRole('button', { name: 'Collapse', exact: true }).click();
    release();
    await expect(row.locator('.hib-card-expand')).toHaveAttribute('aria-hidden', 'true');
    await row.getByRole('button', { name: 'Read letter', exact: true }).click();
    await expect(row.locator('.hib-md-body h2')).toHaveText('Details');
  } finally { release(); await page.unroute(`**/api/v1/human-inbox/${id}`); }
});

test('phone width, reduced motion and sandboxed HTML remain usable', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { panel, row } = await inbox(page);
  await row.getByRole('button', { name: 'Read letter', exact: true }).click();
  await expect(row.locator('.hib-md-body h2')).toHaveText('Details');
  expect(await row.locator('.hib-card-expand').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  const box = (await row.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  await row.getByRole('button', { name: 'Collapse', exact: true }).click();
  const html = panel.locator(`[data-letter-id="${htmlId}"]`);
  await html.getByRole('button', { name: 'Read letter', exact: true }).click();
  await expect(html.frameLocator('iframe').getByRole('heading')).toHaveText('Parking change');
  expect(await html.locator('iframe').getAttribute('sandbox')).not.toContain('allow-scripts');
  expect(await html.frameLocator('iframe').locator('body').evaluate((el) => (el.ownerDocument.defaultView as Window & { cardScriptRan?: boolean }).cardScriptRan)).toBeUndefined();
  await row.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row).toHaveCount(0);
  const detail = await (await request.get(`/api/v1/human-inbox/${id}`)).json();
  expect(detail.letter ?? detail).toMatchObject({ archived: true });
  await panel.getByRole('button', { name: 'Archived', exact: true }).click();
  const archived = panel.locator(`[data-letter-id="${id}"]`);
  await archived.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await panel.getByRole('button', { name: '← Back to inbox', exact: true }).click();
  await expect(panel.locator(`[data-letter-id="${id}"]`)).toBeVisible();
  const target = await request.post('/api/v1/tasks', { data: { title: `Card navigation ${nonce}`, source: 'local' } });
  expect(target.ok()).toBeTruthy();
  const taskId = (await target.json()).task.id;
  const sent = await request.post('/api/v1/human-inbox', { data: { subject: `Linked task ${nonce}`, type: 'info', markdown: `Read [the task](/tasks/${taskId}).` } });
  expect(sent.status()).toBe(201);
  const linkedId = (await sent.json()).id;
  await page.reload();
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.locator('.notification-panel .nfc-rail-btn').filter({ hasText: 'Inbox' }).click();
  const linked = page.locator(`[data-letter-id="${linkedId}"]`);
  await linked.getByRole('button', { name: 'Read letter', exact: true }).click();
  await linked.locator('.hib-md-body a.task-link').click();
  await expect(page.locator('.notification-panel')).toHaveCount(0);
});

test('missing bodies show one notice and deferred HTML streams in the card', async ({ page, request }) => {
  const { row, panel } = await inbox(page);
  await page.route(`**/api/v1/human-inbox/${id}`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const letter = payload.letter ?? payload;
    letter.bodyMissing = true;
    letter.body = 'Server missing-body fallback';
    await route.fulfill({ response, json: payload });
  });
  try {
    await row.getByRole('button', { name: 'Read letter', exact: true }).click();
    await expect(row.locator('.hib-note')).toHaveText('The letter body is unavailable.');
    await expect(row.locator('.hib-md-body')).toHaveCount(0);
  } finally { await page.unroute(`**/api/v1/human-inbox/${id}`); }
  const sent = await request.post('/api/v1/human-inbox', { data: {
    subject: `Deferred letter ${nonce}`, type: 'info', text: 'Large formatted letter.',
    html: '<h2>Streamed document</h2><p>' + 'content '.repeat(140_000) + '</p>',
  } });
  expect(sent.status()).toBe(201);
  const deferredId = (await sent.json()).id;
  const detail = await (await request.get(`/api/v1/human-inbox/${deferredId}`)).json();
  expect((detail.letter ?? detail).bodyDeferred).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.locator('.notification-panel .nfc-rail-btn').filter({ hasText: 'Inbox' }).click();
  const deferred = page.locator(`[data-letter-id="${deferredId}"]`);
  await deferred.getByRole('button', { name: 'Read letter', exact: true }).click();
  await expect(deferred.locator('iframe')).toHaveAttribute('src', /frame=1/);
  await expect(deferred.frameLocator('iframe').getByRole('heading')).toHaveText('Streamed document');
});
