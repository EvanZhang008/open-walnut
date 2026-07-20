import fs from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const SCREENSHOT_DIR = '/tmp/test-and-verify';
const TARGET_S1 = '2532066a-e210-4702-be34-ed01008adbde';
const TARGET_S2 = 'c520a153-6fb8-489d-b18f-c9e0d7ab9f48';
const TARGET_PATH = `/?s1=${TARGET_S1}&s2=${TARGET_S2}&cat=starred`;
const TARGET_TITLES = [
  'Deep link primary session',
  'Deep link secondary session',
] as const;

async function createTask(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: {
      title,
      category: 'Browser Regression',
      project: 'URL Restoration',
      source: 'local',
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { task: { id: string } };
  return body.task.id;
}

async function createStarredTask(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const taskId = await createTask(request, title);
  const response = await request.post(`/api/tasks/${taskId}/star`);
  expect(response.status()).toBe(200);
  return taskId;
}

async function expectExactTargetUrl(page: Page): Promise<void> {
  await expect.poll(() => {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}`;
  }).toBe(TARGET_PATH);
  expect(new URL(page.url()).searchParams.has('task')).toBe(false);
}

async function expectTargetSelection(page: Page): Promise<void> {
  const panels = page.locator('.main-page-session-column .session-panel');
  await expect(panels).toHaveCount(2);
  await expect(panels.nth(0).locator('.session-panel-title')).toHaveText(TARGET_TITLES[0]);
  await expect(panels.nth(1).locator('.session-panel-title')).toHaveText(TARGET_TITLES[1]);
  await expect(page.locator('.task-detail-modal')).toHaveCount(0);

  const viewPanel = page.locator('.vd-panel');
  if (!await viewPanel.isVisible()) {
    await page.getByRole('button', { name: 'View options' }).click();
  }
  await expect(page.locator('.vd-cat', { hasText: '\u2605' }).first()).toHaveClass(/\bvd-active\b/);
  await page.keyboard.press('Escape');
}

test('malformed HTTP 200 task list retains and restores the deep-linked task', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `URL restoration task ${suffix}`;
  const description = `Full task details restored after transient response ${suffix}`;
  const note = `Full task note restored after transient response ${suffix}`;
  const createResponse = await request.post('/api/tasks', {
    data: {
      title,
      description,
      category: 'Browser Regression',
      project: 'URL Restoration',
      source: 'local',
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as { task: { id: string } };
  const taskId = created.task.id;
  const noteResponse = await request.put(`/api/tasks/${taskId}/note`, {
    data: { content: note },
  });
  expect(noteResponse.status()).toBe(200);

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.goto('/');
  const taskCard = page.locator('.todo-pinned-card', { hasText: title });
  await expect(taskCard).toBeVisible();
  await taskCard.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect.poll(() =>
    new URL(page.url()).searchParams.get('task')).toBe(taskId);
  await expect(page.locator('.task-detail-modal .todo-detail-title')).toHaveText(title);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/task-url-restoration-selected.png`,
    fullPage: true,
  });

  let listRequests = 0;
  let failList = true;
  await page.route('**/api/tasks?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('fields') !== 'list') {
      await route.continue();
      return;
    }
    listRequests++;
    if (failList) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"tasks":[',
      });
      return;
    }
    await route.continue();
  });

  const firstBrokenList = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/tasks'
      && url.searchParams.get('fields') === 'list'
      && response.status() === 200;
  });
  await page.reload();
  await firstBrokenList;

  // The retry waits two seconds. During that gap, pending URL state must remain
  // authoritative rather than being replaced by the initial empty React state.
  await page.waitForTimeout(500);
  expect(listRequests).toBeGreaterThanOrEqual(1);
  expect(new URL(page.url()).searchParams.get('task')).toBe(taskId);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/task-url-restoration-pending.png`,
    fullPage: true,
  });

  failList = false;
  const modal = page.locator('.task-detail-modal');
  await expect(modal.locator('.todo-detail-title')).toHaveText(title, { timeout: 10_000 });
  await expect(modal.getByText(description, { exact: true })).toBeVisible();
  await expect(modal.getByText(note, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBe(taskId);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/task-url-restoration-restored.png`,
    fullPage: true,
  });
});

test('warm-page popstate survives a failed background task refresh', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `Warm URL restoration ${suffix}`;
  const description = `Warm page full details ${suffix}`;
  const note = `Warm page full note ${suffix}`;
  const helperTitle = `Warm URL helper ${suffix}`;
  const [targetResponse, helperResponse] = await Promise.all([
    request.post('/api/tasks', {
      data: {
        title,
        description,
        category: 'Browser Regression',
        project: 'Warm URL Restoration',
        source: 'local',
      },
    }),
    request.post('/api/tasks', {
      data: {
        title: helperTitle,
        category: 'Browser Regression',
        project: 'Warm URL Restoration',
        source: 'local',
      },
    }),
  ]);
  expect(targetResponse.status()).toBe(201);
  expect(helperResponse.status()).toBe(201);
  const target = await targetResponse.json() as { task: { id: string } };
  const helper = await helperResponse.json() as { task: { id: string } };
  const taskId = target.task.id;
  const noteResponse = await request.put(`/api/tasks/${taskId}/note`, {
    data: { content: note },
  });
  expect(noteResponse.status()).toBe(200);
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  let listRequests = 0;
  let filterTarget = true;
  let failList = false;
  let failedListRequests = 0;
  await page.route('**/api/tasks?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('fields') !== 'list') {
      await route.continue();
      return;
    }

    listRequests++;
    if (filterTarget) {
      const response = await route.fetch();
      const body = await response.json() as { tasks: Array<{ id: string }> };
      await route.fulfill({
        response,
        json: {
          ...body,
          tasks: body.tasks.filter((task) => task.id !== taskId),
        },
      });
      return;
    }
    if (failList) {
      failedListRequests++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"tasks":[',
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByText(helperTitle, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);

  filterTarget = false;
  failList = true;
  const groupResponse = await request.post('/api/tasks/groups', {
    data: {
      task_ids: [taskId, helper.task.id],
      label: `Warm URL group ${suffix}`,
    },
  });
  expect(groupResponse.status()).toBe(200);
  await expect.poll(() => failedListRequests, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  await page.evaluate((pendingTaskId) => {
    const url = new URL(window.location.href);
    url.searchParams.set('task', pendingTaskId);
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, taskId);

  // The failed background refresh is between attempts here. The stale list is
  // not authoritative, so it must not erase the pending URL.
  await page.waitForTimeout(500);
  expect(new URL(page.url()).searchParams.get('task')).toBe(taskId);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/task-url-restoration-warm-pending.png`,
    fullPage: true,
  });

  failList = false;
  const modal = page.locator('.task-detail-modal');
  await expect(modal.locator('.todo-detail-title')).toHaveText(title, { timeout: 10_000 });
  await expect(modal.getByText(description, { exact: true })).toBeVisible();
  await expect(modal.getByText(note, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBe(taskId);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/task-url-restoration-warm-restored.png`,
    fullPage: true,
  });
});

test('exact taskless deep link survives a malformed task list on cold start', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createStarredTask(request, `Cold deep-link starred fixture ${suffix}`);
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  let listRequests = 0;
  let failList = true;
  await page.route('**/api/tasks?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('fields') !== 'list') {
      await route.continue();
      return;
    }

    listRequests++;
    if (failList) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"tasks":[',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(TARGET_PATH);
  await expect.poll(() => listRequests).toBeGreaterThanOrEqual(1);

  // Cross the URL-sync debounce while the task hook is waiting to retry.
  await page.waitForTimeout(500);
  expect(listRequests).toBeGreaterThanOrEqual(1);
  await expectExactTargetUrl(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/cold-target-pending.png`,
    fullPage: true,
  });

  failList = false;
  await expectTargetSelection(page);
  await expectExactTargetUrl(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/cold-target-restored.png`,
    fullPage: true,
  });
});

test('exact taskless deep link is restored by Back during a failed warm refresh', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [starredTaskId, helperTaskId] = await Promise.all([
    createStarredTask(request, `Warm deep-link starred fixture ${suffix}`),
    createTask(request, `Warm deep-link helper fixture ${suffix}`),
  ]);
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  let listRequests = 0;
  let failList = false;
  let failedRefreshes = 0;
  await page.route('**/api/tasks?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('fields') !== 'list') {
      await route.continue();
      return;
    }

    listRequests++;
    if (failList) {
      failedRefreshes++;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"temporary task list failure"}',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(TARGET_PATH);
  await expectTargetSelection(page);
  await expectExactTargetUrl(page);

  // Build a separate home history entry through real navigation, then move the
  // live UI away from the target state. Back must restore the URL state, not
  // merely reveal state that happened to remain mounted.
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/notes');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');

  await page.locator('.session-panel-close').first().click();
  await page.locator('.session-panel-close').first().click();
  await expect(page.locator('.main-page-session-column .session-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'View options' }).click();
  await page.locator('.vd-cat', { hasText: 'All' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}`;
  }).toBe('/');

  failList = true;
  const groupResponse = await request.post('/api/tasks/groups', {
    data: {
      task_ids: [starredTaskId, helperTaskId],
      label: `Warm deep-link group ${suffix}`,
    },
  });
  expect(groupResponse.status()).toBe(200);
  await expect.poll(() => failedRefreshes).toBeGreaterThanOrEqual(1);

  for (let i = 0; i < 10 && new URL(page.url()).pathname !== '/notes'; i++) {
    await page.goBack();
    await page.waitForTimeout(100);
  }
  await expect.poll(() => new URL(page.url()).pathname).toBe('/notes');
  await page.goBack();
  await expectExactTargetUrl(page);

  // The 503 retry is still pending. Keep the exact query stable beyond the
  // replaceState debounce, including s1/s2 order and taskless semantics.
  await page.waitForTimeout(500);
  expect(failedRefreshes).toBeGreaterThanOrEqual(1);
  await expectExactTargetUrl(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/warm-target-failed.png`,
    fullPage: true,
  });

  failList = false;
  await expectTargetSelection(page);
  await expectExactTargetUrl(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/warm-target-restored.png`,
    fullPage: true,
  });
});
