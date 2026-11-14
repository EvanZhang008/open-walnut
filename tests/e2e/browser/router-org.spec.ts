// Routers on the Org page: one per area (Personal, Work), beside the VPs, never a VP.
//
// Its OWN fixture server (MailFixtureServer: a throwaway home, its own API, daemon and Vite), never
// the shared :3457 one. A router claims its area for good: the area registry keeps the router's task
// as a member, so a router made on the shared fixture can never be deleted again, and the next run
// found the area taken. Here every worker (a retry included) starts on an empty home with no router
// and no VP, makes its own two VPs, and the home is removed when it stops. Nothing is skipped.
//
// Navigation: one load of the app root (location.assign from the blank page), then only the SPA's
// own sidebar and list clicks; reload is used only where a test checks what survives a reload.
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { MailFixtureServer, type MailFixture } from './mail-review-helpers';

type RouterEntry = { taskId: string; areaId: string; paused: boolean };
type AreasFile = { routers: RouterEntry[]; areas: Array<{ id: string; taskIds: string[] }> };
type RouterTask = { id: string; phase?: string; org_role?: string; org_name?: string; router_area_id?: string; router_links?: string[]; router_paused?: boolean };
type Job = { id: string; enabled?: boolean; executor?: { type?: string; config?: { target?: string; areaId?: string } } };

const VP_A = 'Marina';
const VP_B = 'Ferry';
const AREAS = [
  { id: 'personal', label: 'Personal', links: [] as Array<'a' | 'b'> },
  { id: 'work', label: 'Work', links: ['a', 'b'] as Array<'a' | 'b'> },
] as const;
const SHOTS = '/tmp/router-org';

let server: MailFixtureServer;
let fixture: MailFixture;
let api: APIRequestContext;
let origin = '';
const vp = { a: '', b: '' };
const routerOf: Record<string, string> = {};
const nameOf: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

test.beforeAll(async ({ playwright, browser }) => {
  test.setTimeout(360_000);
  server = new MailFixtureServer();
  // No mail provider (the base alone, as a stock install has it) and no background start of a new VP:
  // the subject is the Org page, and a VP session starting under the test would only add noise.
  fixture = await server.start({ PW_MAIL_DENSE: '0', WALNUT_ORG_AUTOSTART: '0' });
  origin = `http://127.0.0.1:${fixture.port}`;
  api = await playwright.request.newContext({ baseURL: origin });
  // An empty home: no router, no area member, before anything is made.
  const empty = await areas();
  expect(empty.routers, 'a fresh fixture home has no router').toEqual([]);
  expect(empty.areas.flatMap((a) => a.taskIds), 'a fresh fixture home has no area member').toEqual([]);
  for (const [key, name] of [['a', VP_A], ['b', VP_B]] as const) {
    const res = await api.post('/api/v1/org/vps', { data: { name } });
    expect(res.ok(), await res.text()).toBe(true);
    vp[key] = ((await res.json()) as { task: { id: string } }).task.id;
  }
  await fs.mkdir(SHOTS, { recursive: true });
  // Pay the fresh Vite's first compile here, not inside the first test's budget.
  const page = await browser.newPage();
  try { await openRoot(page, 120_000); } finally { await page.close(); }
});

test.afterAll(async () => {
  await api?.dispose().catch(() => {});
  await server?.stop();
});

async function areas(): Promise<AreasFile> {
  const res = await api.get('/api/v1/router/areas');
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as Partial<AreasFile>;
  return { routers: body.routers ?? [], areas: body.areas ?? [] };
}

async function taskOf(id: string): Promise<RouterTask> {
  const res = await api.get(`/api/tasks/${encodeURIComponent(id)}`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { task: RouterTask }).task;
}

async function wakeJob(taskId: string): Promise<Job | undefined> {
  const res = await api.get('/api/v1/routines?includeDisabled=true');
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { jobs?: Job[] } | Job[];
  const jobs = Array.isArray(body) ? body : body.jobs ?? [];
  return jobs.find((job) => job.executor?.type === 'router' && job.executor.config?.target === taskId);
}

/** The app root, loaded once from the blank page, with one retry for WebKit's rare blank first paint. */
async function openRoot(page: Page, timeout = 60_000) {
  const url = `${origin}/`;
  for (const attempt of [1, 2] as const) {
    if (attempt === 1) await page.evaluate((to) => { window.location.assign(to); }, url).catch(() => {});
    else await page.reload();
    await page.waitForURL(url, { timeout });
    try {
      await expect(page.locator('.sidebar')).toBeVisible({ timeout: attempt === 1 ? timeout : 60_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** Errors the page throws, except a fetch the browser cut off because the page itself was reloading. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  let reloading = false;
  page.on('pageerror', (error) => {
    if (reloading && /access control checks|Load failed|Failed to fetch|NetworkError|aborted/i.test(error.message)) return;
    errors.push(error.message);
  });
  return {
    errors,
    async reload(ready: () => Promise<void>) {
      reloading = true;
      try {
        await page.reload();
        await ready();
      } finally {
        reloading = false;
      }
    },
  };
}

async function capture(page: Page, options: { path: string }) {
  const body = await page.screenshot(options);
  await test.info().attach(options.path.split('/').at(-1)!, { body, contentType: 'image/png' });
}

async function openOrg(page: Page) {
  await openRoot(page);
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click();
  await page.getByTestId('sidebar-org').click();
  await expect(page.getByTestId('org-routers')).toBeVisible({ timeout: 60_000 });
  // The VPs this worker made are on the list, so the page has its tasks.
  await expect(page.getByTestId('org-channel').filter({ hasText: VP_A })).toBeVisible();
  await expect(page.getByTestId('org-channel').filter({ hasText: VP_B })).toBeVisible();
}

const routerRow = (page: Page, id: string) => page.locator(`[data-testid="org-channel-router"][data-key="router:${id}"]`);
const vpBox = (scope: Locator, key: 'a' | 'b') => scope.locator(`[data-testid="router-setup-vp"][data-task-id="${vp[key]}"] input`);

async function openRouter(page: Page, id: string) {
  await routerRow(page, id).click();
  await expect(routerRow(page, id)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('org-router-settings')).toHaveAttribute('data-router-id', id);
}

async function openSettings(page: Page) {
  const toggle = page.getByTestId('org-router-settings-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('org-router-settings-body')).toBeVisible();
}

const linkBox = (page: Page, id: string) => page.locator(`[data-testid="org-router-link"][data-task-id="${id}"] input`);

/** Save and read the outcome: 'saved', or the error the form shows. */
async function saveOutcome(page: Page): Promise<string> {
  // Read the form only after this click's PATCH answered (a fulfilled mock counts), so an error left
  // by the previous attempt is never taken for this one's.
  const answered = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/v1/org/routers/'), { timeout: 60_000 });
  await page.getByTestId('org-router-save').click();
  await answered;
  let outcome = '';
  await expect.poll(async () => {
    const error = page.getByTestId('org-router-error');
    if (await error.count()) outcome = `error: ${await error.innerText()}`;
    else if ((await page.getByTestId('org-router-saved').innerText()).trim() === 'Saved.') outcome = 'saved';
    else outcome = '';
    return outcome;
  }, { timeout: 30_000 }).not.toBe('');
  return outcome;
}

for (const area of AREAS) {
  test(`New router in ${area.label}: a failed create keeps the fields, then it is made with ${area.links.length} VP links`, async ({ page }) => {
    const watch = watchErrors(page);
    const before = await areas();
    expect(before.routers.find((r) => r.areaId === area.id), `no ${area.id} router before this test`).toBeUndefined();
    await openOrg(page);
    await page.getByTestId('org-new-router').click();
    const form = page.getByTestId('org-router-setup');
    await expect(form).toBeVisible();
    await form.getByRole('radio', { name: area.label, exact: true }).check();
    await expect(form.getByTestId('router-setup-existing')).toHaveCount(0);
    const name = `${area.label} intake`;
    nameOf[area.id] = name;
    await form.getByTestId('router-name').fill(name);
    for (const key of area.links) await vpBox(form, key).check();

    // The first create fails: the typed name, the area and the links stay, and nothing was made.
    let failed = 0;
    await page.route('**/api/v1/org/routers', async (route) => {
      failed++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Router store unavailable' }) });
    }, { times: 1 });
    await form.getByTestId('router-setup-create').click();
    await expect(form.getByTestId('router-setup-error')).toBeVisible();
    expect(failed).toBe(1);
    await expect(form.getByTestId('router-name')).toHaveValue(name);
    await expect(form.getByRole('radio', { name: area.label, exact: true })).toBeChecked();
    for (const key of area.links) await expect(vpBox(form, key)).toBeChecked();
    expect((await areas()).routers).toEqual(before.routers);

    // The retry reaches the real API.
    await form.getByTestId('router-setup-create').click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await areas()).routers.find((r) => r.areaId === area.id)?.taskId ?? '').not.toBe('');
    const registry = await areas();
    const mine = registry.routers.find((r) => r.areaId === area.id)!;
    routerOf[area.id] = mine.taskId;
    expect(mine.paused, 'a new router is registered paused').toBe(true);
    expect(registry.routers.filter((r) => r.areaId === area.id)).toHaveLength(1);
    expect(registry.areas.find((a) => a.id === area.id)?.taskIds).toContain(mine.taskId);
    const task = await taskOf(mine.taskId);
    expect(task.org_role).toBe('router');
    expect(task.router_area_id).toBe(area.id);
    expect(task.router_paused).toBe(true);
    expect(task.org_name).toBe(name);
    expect([...(task.router_links ?? [])].sort()).toEqual(area.links.map((key) => vp[key]).sort());

    const row = routerRow(page, mine.taskId);
    await expect(row).toHaveAttribute('aria-selected', 'true');
    // The row names its area by name, never by its id.
    await expect(row.getByTestId('org-router-line')).toHaveText(new RegExp(`^${area.label} · Paused · `));
    await expect(row).toContainText('Paused');
    await expect(row).toContainText(`${area.links.length} VP link${area.links.length === 1 ? '' : 's'}`);
    // A router is its own row, never a VP row, and has no Tasks, Brief or Threads side bar.
    expect(await page.getByTestId('org-channel').filter({ hasText: name }).count()).toBe(0);
    await expect(page.getByTestId('org-rail-toggle')).toHaveCount(0);
    // Its page says what it is and where it stands (2026-11-11: it said only "No conversation history found").
    await expect(page.getByTestId('org-router-overview-what')).toContainText(`reads the mail you assign to ${area.label}`);
    await expect(page.getByTestId('org-router-overview-state')).toHaveText(/^Paused: it reads nothing/);
    await expect(page.getByTestId('org-router-overview-routed')).toHaveText('No email so far.');
    await expect(page.getByText('No conversation history found')).toHaveCount(0);

    // Settings: an empty name cannot be saved, Discard brings the saved name back, a rename is saved.
    await expect(page.getByTestId('org-router-settings')).toBeVisible();
    await openSettings(page);
    // The area's own name, never its id.
    await expect(page.getByTestId('org-router-area')).toHaveText(area.label);
    for (const key of area.links) await expect(linkBox(page, vp[key])).toBeChecked();
    await page.getByTestId('org-router-name').fill('');
    await expect(page.getByTestId('org-router-save')).toBeDisabled();
    await page.getByTestId('org-router-discard').click();
    await expect(page.getByTestId('org-router-name')).toHaveValue(name);
    await expect(page.getByTestId('org-router-discard')).toBeDisabled();
    await page.getByTestId('org-router-name').fill(`${name} desk`);
    expect(await saveOutcome(page)).toBe('saved');
    await expect(page.getByTestId('org-router-save')).toBeDisabled();
    await expect(row).toContainText(`${name} desk`);
    await expect.poll(async () => (await taskOf(mine.taskId)).org_name).toBe(`${name} desk`);
    nameOf[area.id] = `${name} desk`;

    // The list's search finds it and hides the VPs; cleared, everything is back.
    await page.getByTestId('org-search').fill(nameOf[area.id]!);
    await expect(row).toBeVisible();
    await expect(page.getByTestId('org-channel').filter({ hasText: VP_A })).toHaveCount(0);
    await page.getByTestId('org-search').fill('');
    await expect(page.getByTestId('org-channel').filter({ hasText: VP_A })).toBeVisible();

    // A reload reads it back from the server: still selected, the new name, still paused.
    await watch.reload(async () => { await expect(page.getByTestId('org-routers')).toBeVisible({ timeout: 60_000 }); });
    await expect(routerRow(page, mine.taskId)).toHaveAttribute('aria-selected', 'true');
    await expect(routerRow(page, mine.taskId)).toContainText(nameOf[area.id]!);
    await expect(routerRow(page, mine.taskId)).toContainText('Paused');
    await capture(page, { path: `${SHOTS}/${area.id}-created.png` });
    expect(watch.errors).toEqual([]);
  });
}

test('an area that has its router opens it: no POST, no new node, the draft stays', async ({ page }) => {
  const watch = watchErrors(page);
  const personal = routerOf.personal!;
  expect(personal, 'the Personal test made its router').toBeTruthy();
  const before = await areas();
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/v1/org/routers')) posts.push(r.url()); });
  await openOrg(page);
  const rowsBefore = await page.getByTestId('org-channel-router').count();
  expect(rowsBefore).toBe(2);
  // The Routers sit below every VP row (2026-11-10, the person: "router should be placed below all VPs").
  const lastVp = await page.getByTestId('org-channel').last().boundingBox();
  const routersHead = await page.getByTestId('org-routers').boundingBox();
  expect(lastVp && routersHead && routersHead.y >= lastVp.y + lastVp.height - 0.5).toBe(true);
  await page.getByTestId('org-new-router').click();
  const form = page.getByTestId('org-router-setup');
  await form.getByRole('radio', { name: 'Personal', exact: true }).check();
  await expect(form.getByTestId('router-setup-existing')).toHaveAttribute('data-task-id', personal);
  await expect(form.getByTestId('router-setup-create')).toHaveCount(0);
  // The offer replaces the new-router fields: no name to type, no VP list above the button.
  await expect(form.getByTestId('router-name')).toHaveCount(0);
  await expect(form.getByTestId('router-setup-vp')).toHaveCount(0);
  await expect(form.getByTestId('router-setup-open-existing')).toBeInViewport();
  // Work has its router too.
  await form.getByRole('radio', { name: 'Work', exact: true }).check();
  await expect(form.getByTestId('router-setup-existing')).toHaveAttribute('data-task-id', routerOf.work!);
  await form.getByRole('radio', { name: 'Personal', exact: true }).check();
  await form.getByTestId('router-setup-open-existing').click();
  await expect(form).toHaveCount(0);
  await expect(routerRow(page, personal)).toHaveAttribute('aria-selected', 'true');
  expect(posts).toEqual([]);
  expect(await page.getByTestId('org-channel-router').count()).toBe(rowsBefore);
  expect((await areas()).routers).toEqual(before.routers);
  await page.getByTestId('org-new-router').click();
  await page.getByTestId('org-router-setup').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('org-router-setup')).toHaveCount(0);
  await capture(page, { path: `${SHOTS}/reuse.png` });
  expect(watch.errors).toEqual([]);
});

test('Work router links: a failed save keeps the edit, the retry drops one VP, and a reload shows it', async ({ page }) => {
  const watch = watchErrors(page);
  const work = routerOf.work!;
  expect(work, 'the Work test made its router').toBeTruthy();
  await openOrg(page);
  await openRouter(page, work);
  await openSettings(page);
  await expect(linkBox(page, vp.a)).toBeChecked();
  await expect(linkBox(page, vp.b)).toBeChecked();
  await linkBox(page, vp.b).uncheck();

  let failed = 0;
  await page.route('**/api/v1/org/routers/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    failed++;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Router store unavailable' }) });
  }, { times: 1 });
  expect(await saveOutcome(page)).toMatch(/^error: /);
  expect(failed).toBe(1);
  await expect(linkBox(page, vp.b)).not.toBeChecked();
  await expect(linkBox(page, vp.a)).toBeChecked();
  await expect(page.getByTestId('org-router-save')).toBeEnabled();
  expect([...((await taskOf(work)).router_links ?? [])].sort()).toEqual([vp.a, vp.b].sort());

  expect(await saveOutcome(page)).toBe('saved');
  await expect.poll(async () => (await taskOf(work)).router_links ?? []).toEqual([vp.a]);
  await expect(page.getByTestId('org-router-summary')).toContainText('1 VP link');
  await expect(routerRow(page, work)).toContainText('1 VP link');

  await watch.reload(async () => { await expect(page.getByTestId('org-routers')).toBeVisible({ timeout: 60_000 }); });
  await expect(routerRow(page, work)).toHaveAttribute('aria-selected', 'true');
  await expect(routerRow(page, work)).toContainText('1 VP link');
  await openSettings(page);
  await expect(linkBox(page, vp.a)).toBeChecked();
  await expect(linkBox(page, vp.b)).not.toBeChecked();
  await expect(page.getByTestId('org-router-save')).toBeDisabled();
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(page.getByTestId('org-detail')).toBeVisible();
  await expect(page.getByTestId('org-router-settings')).toBeVisible();
  await capture(page, { path: `${SHOTS}/work-links-narrow.png` });
  expect(watch.errors).toEqual([]);
});

test('Personal router pause: a failed resume stays paused everywhere, the real resume arms its wake, pausing again turns it off', async ({ page }) => {
  const watch = watchErrors(page);
  const personal = routerOf.personal!;
  expect(personal, 'the Personal test made its router').toBeTruthy();
  const registryPaused = async () => (await areas()).routers.find((r) => r.taskId === personal)?.paused;
  expect(await registryPaused()).toBe(true);
  await openOrg(page);
  await openRouter(page, personal);
  await openSettings(page);
  await expect(page.getByTestId('org-router-paused')).toBeChecked();
  await page.getByTestId('org-router-paused').uncheck();
  await expect(page.getByTestId('org-router-state-line')).toContainText('Ready. It reads each new item');

  // The resume fails the way the server says it when the wake routine cannot be armed: nothing moves.
  let failed = 0;
  await page.route('**/api/v1/org/routers/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    failed++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'router_wake_failed', message: 'The router is still paused. Its wake routine could not be updated. Retry the edit.' }) });
  }, { times: 1 });
  expect(await saveOutcome(page)).toMatch(/^error: /);
  expect(failed).toBe(1);
  await expect(page.getByTestId('org-router-paused')).not.toBeChecked();
  await expect(routerRow(page, personal)).toContainText('Paused');
  expect((await taskOf(personal)).router_paused).toBe(true);
  expect(await registryPaused()).toBe(true);

  // The real resume: the server arms the wake routine through this fixture's own local daemon. A
  // failure here is the real API's answer (for instance a daemon that cannot run triggers), not a mock.
  const resumed = await saveOutcome(page);
  expect(resumed, 'the real resume needs the fixture\'s local daemon to accept the router wake trigger').toBe('saved');
  await expect.poll(async () => (await taskOf(personal)).router_paused).toBe(false);
  expect(await registryPaused()).toBe(false);
  await expect.poll(async () => (await wakeJob(personal))?.enabled ?? null).toBe(true);
  expect((await wakeJob(personal))?.executor?.config?.areaId).toBe('personal');
  await expect(routerRow(page, personal)).toContainText('Ready');
  await expect(routerRow(page, personal)).not.toContainText('Paused');
  await expect(page.getByTestId('org-router-summary')).toContainText('Ready for new items');
  // The page's state line follows the save: running or not yet started, and how mail reaches it.
  await expect(page.getByTestId('org-router-overview-state')).toHaveText(/^(Running|Not running yet)/);
  await expect(page.getByTestId('org-router-overview-next')).toContainText('Nothing is assigned to Personal yet');
  // The Work router is not touched by Personal's resume.
  expect((await areas()).routers.find((r) => r.taskId === routerOf.work)?.paused).toBe(true);

  await watch.reload(async () => { await expect(page.getByTestId('org-routers')).toBeVisible({ timeout: 60_000 }); });
  await expect(routerRow(page, personal)).toHaveAttribute('aria-selected', 'true');
  await openSettings(page);
  await expect(page.getByTestId('org-router-paused')).not.toBeChecked();

  // Pause again: the registry entry and the task are paused, and the wake routine is turned off.
  await page.getByTestId('org-router-paused').check();
  expect(await saveOutcome(page)).toBe('saved');
  await expect.poll(async () => (await taskOf(personal)).router_paused).toBe(true);
  expect(await registryPaused()).toBe(true);
  await expect.poll(async () => (await wakeJob(personal))?.enabled ?? null).toBe(false);
  await expect(routerRow(page, personal)).toContainText('Paused');
  await capture(page, { path: `${SHOTS}/personal-paused-again.png` });
  expect(watch.errors).toEqual([]);
});
