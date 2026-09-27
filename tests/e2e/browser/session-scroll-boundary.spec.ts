import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { checkSessionScroll } from '../../../scripts/devprod-session-scroll.mjs';

const SESSION = 'pw-outline-window-session';
const TASK = 'pw-task-outline-window';
const evidence = '/tmp/walnut-scroll-repair';

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

async function openSession(page: Page, baseURL: string): Promise<Locator> {
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.locator('.todo-search-input').fill(SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column [data-session-id="${SESSION}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.session-history')).toContainText('outline filler reply 230', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return panel;
}

async function verifyScrolling(page: Page, panel: Locator) {
  const history = panel.locator('.session-history');
  const geometry = await panel.evaluate((root) => {
    const scroller = root.querySelector<HTMLElement>('.session-history')!;
    const body = root.querySelector<HTMLElement>('.session-panel-body')!;
    const composer = root.querySelector<HTMLElement>('.session-panel-input')!;
    return {
      range: scroller.scrollHeight - scroller.clientHeight,
      bottom: scroller.getBoundingClientRect().bottom,
      bodyBottom: body.getBoundingClientRect().bottom,
      composerTop: composer.getBoundingClientRect().top,
    };
  });
  expect(geometry.range, 'the actual transcript has a scroll range').toBeGreaterThan(500);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.bodyBottom + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.composerTop + 1);
  for (const direction of [-1, 1]) {
    let reached = false;
    for (let step = 0; step < 80; step++) {
      const box = (await history.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, direction * 800);
      await page.waitForTimeout(100);
      reached = await history.evaluate((el, delta) => delta < 0
        ? el.scrollTop <= 1
        : el.scrollTop > 500 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1, direction);
      if (reached) break;
    }
    expect(reached, `wheel scrolling reaches the ${direction < 0 ? 'top' : 'bottom'}`).toBe(true);
  }
}

test('a built long conversation scrolls in a column, fullscreen and after reload', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mkdir(evidence, { recursive: true });
  const panel = await openSession(page, baseURL!);
  await page.locator('.todo-search-input').fill('');
  for (let round = 0; round < 3; round++) await verifyScrolling(page, panel);
  await panel.screenshot({ path: `${evidence}/${info.project.name}-column.png` });
  await panel.locator('.session-panel-expand').click();
  await verifyScrolling(page, panel);
  await panel.screenshot({ path: `${evidence}/${info.project.name}-fullscreen.png` });
  await panel.locator('.session-panel-expand').click();
  await page.reload();
  await expect(panel.locator('.session-history')).toContainText('outline filler reply 230', { timeout: 30_000 });
  await verifyScrolling(page, panel);
  await panel.getByRole('button', { name: 'Changed', exact: true }).click();
  await expect(panel.locator('.session-panel-split')).toHaveClass(/is-changed-open/);
  await verifyScrolling(page, panel);
  await panel.screenshot({ path: `${evidence}/${info.project.name}-split.png` });
  await panel.getByRole('button', { name: 'Changed', exact: true }).click();
  await verifyScrolling(page, panel);
  expect(errors).toEqual([]);
});

test('the publish check opens the real built session renderer without storing its fixture', async ({ browser, baseURL, request }) => {
  test.setTimeout(120_000);
  const result = await checkSessionScroll(browser, baseURL!, 30_000);
  expect(result, result.message).toMatchObject({ code: 0 });
  const response = await request.get('/api/sessions/render-check-scroll-session');
  expect(response.status()).toBe(404);
});
