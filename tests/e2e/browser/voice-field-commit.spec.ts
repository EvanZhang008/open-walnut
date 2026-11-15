import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { loadHome } from './draft-helpers';
import { isolateUiPrefs, presetPanelView, showEverything } from './todo-panel-helpers';
import { calendarEmptySlotPoint } from './calendar-helpers';
import { useSyntheticMic } from './stt-failure-helpers';
import { DRAFTED, FULL, stubEngine, type Lane } from './send-waits-helpers';

// The shared one-line field and its external buttons must never save a preview.
// Real UI and fixture APIs; only the speech engine and microphone are synthetic.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);
test.use({ viewport: { width: 1280, height: 860 } });
const shots = process.env.VOICE_COMPOSE_SHOTS ?? '/tmp/voice-field-commit';

async function home(page: Page): Promise<Lane> {
  await isolateUiPrefs(page);
  await useSyntheticMic(page);
  const lane = await stubEngine(page);
  await loadHome(page);
  return lane;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png` });
}

async function tiers(page: Page): Promise<Array<{ id: string; label: string }>> {
  const res = await page.request.get('/api/focus/tiers');
  expect(res.ok()).toBe(true);
  return (await res.json()).tiers;
}

async function focusSettings(page: Page) {
  await page.locator('a[href^="/settings"]').first().click();
  await page.getByTestId('settings-nav-tasks').click();
  await page.locator('#focus-tiers').scrollIntoViewIfNeeded();
}

test('Add tier waits for the mic final words and creates one tier', async ({ page }) => {
  const lane = await home(page);
  await focusSettings(page);
  const section = page.locator('#focus-tiers');
  const input = section.locator('#focus-tiers-new');
  const mic = input.locator('xpath=..').locator('.mic-btn').first();
  // Five prefix characters plus the 35-character final sentence fit LABEL_MAX=40.
  const prefix = `V${Date.now().toString(36).slice(-3)} `;
  const before = new Set((await tiers(page)).map((t) => t.id));
  try {
    await input.fill(prefix);
    await input.press('End');
    await mic.click();
    await expect(input).toHaveValue(prefix + DRAFTED, { timeout: 20_000 });
    lane.held = true;
    // Waiting changes the accessible name to the cancellation hint.
    const add = section.locator('.focus-tiers-add-row button').filter({ hasText: 'Add tier' });
    await add.click();
    await expect(add).toHaveAttribute('data-dictation-wait', 'true');
    expect((await tiers(page)).filter((t) => !before.has(t.id))).toHaveLength(0);
    await shot(page, 'tier-add-waiting');
    lane.release();
    await expect.poll(async () => (await tiers(page)).filter((t) => !before.has(t.id)).map((t) => t.label)).toEqual([prefix + FULL]);
    await expect(input).toHaveValue('');
  } finally {
    lane.release();
    for (const t of await tiers(page)) if (!before.has(t.id) && t.label.startsWith(prefix.trim())) await page.request.delete(`/api/focus/tiers/${t.id}`);
  }
});

test('inline rename keeps its field mounted on blur until the final words land', async ({ page }) => {
  const lane = await home(page);
  const seed = `Rename ${Date.now().toString(36)}`;
  const res = await page.request.post('/api/focus/tiers', { data: { label: seed } });
  expect(res.ok()).toBe(true);
  const id = (await res.json()).tier.id as string;
  try {
    await focusSettings(page);
    const section = page.locator('#focus-tiers');
    await section.getByRole('button', { name: seed, exact: true }).click();
    const input = section.getByRole('textbox', { name: `Rename ${seed}` });
    await input.fill('');
    const mic = input.locator('xpath=..').locator('.mic-btn').first();
    await mic.click();
    await expect(input).toHaveValue(DRAFTED, { timeout: 20_000 });
    lane.held = true;
    await section.getByText('New tier', { exact: true }).click();
    await expect(input).toBeVisible();
    expect((await tiers(page)).find((t) => t.id === id)?.label).toBe(seed);
    await shot(page, 'rename-blur-waiting');
    lane.release();
    await expect.poll(async () => (await tiers(page)).find((t) => t.id === id)?.label).toBe(FULL);
    await expect(section.getByRole('button', { name: FULL, exact: true })).toBeVisible();
  } finally {
    lane.release();
    await page.request.delete(`/api/focus/tiers/${id}`);
  }
});

test('the shared prompt waits for final words before creating a folder', async ({ page }) => {
  const project = `Voice prompt ${Date.now().toString(36)}`;
  const res = await page.request.post('/api/tasks', { data: { title: 'Folder voice anchor', project, source: 'local', pinned: false } });
  expect(res.ok()).toBe(true);
  const taskId = (await res.json()).task.id as string;
  let lane: Lane | undefined;
  const prefix = `Spoken folder ${Date.now().toString(36)} `;
  try {
    await presetPanelView(page);
    lane = await home(page);
    await showEverything(page);
    const header = page.locator('.todo-group-project-header', { hasText: project }).first();
    await expect(header).toBeVisible();
    await header.scrollIntoViewIfNeeded();
    await header.hover();
    await header.locator('.navigation-more').click();
    await page.getByTestId('project-ctx-menu').getByRole('menuitem', { name: 'New folder', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'New folder' });
    const input = modal.locator('.app-modal-input');
    await input.fill(prefix);
    await input.press('End');
    await input.locator('xpath=..').locator('.mic-btn').first().click();
    await expect(input).toHaveValue(prefix + DRAFTED, { timeout: 20_000 });
    lane.held = true;
    const create = modal.locator('.app-modal-btn.primary');
    await create.click();
    await expect(create).toHaveAttribute('data-dictation-wait', 'true');
    await shot(page, 'prompt-create-waiting');
    lane.release();
    await expect(modal).not.toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.task-group-chip-empty', { hasText: prefix + FULL }).first()).toBeVisible();
  } finally {
    lane?.release();
    const res = await page.request.get('/api/tasks/groups');
    for (const g of (await res.json()).groups as Array<{ group_id: string; label?: string }>) if (g.label?.startsWith(prefix.trim())) await page.request.delete(`/api/tasks/folders/${g.group_id}`);
    await page.request.delete(`/api/tasks/${taskId}?force=true`);
  }
});

test('mic history escapes a scrolling settings field and stays inside the viewport', async ({ page }) => {
  await home(page);
  await focusSettings(page);
  const input = page.locator('#focus-tiers-new');
  const mic = input.locator('xpath=..').locator('.mic-btn').first();
  await mic.click({ button: 'right' });
  const popup = page.locator('body > .mic-retry-dropdown.mic-popover');
  await expect(popup).toBeVisible();
  const bounds = await popup.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(860);
  await shot(page, 'mic-history-viewport');
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(page.locator('#focus-tiers')).toBeVisible();
});

test('task Create waits for the title field mic, not only the sentence mic', async ({ page }) => {
  const lane = await home(page);
  await page.locator('a[href="/calendar"]').first().click();
  await expect(page.locator('.cal-toolbar')).toBeVisible();
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const point = await calendarEmptySlotPoint(page, day);
  await page.mouse.click(point.x, point.y);
  const panel = page.locator('.qtc-confirm-panel');
  await expect(panel).toBeVisible();
  const input = panel.locator('.qtc-confirm-title');
  const mic = input.locator('xpath=..').locator('.mic-btn').first();
  const prefix = `Voice task ${Date.now().toString(36)} `;
  const sent: Array<{ title?: string }> = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks') sent.push(r.postDataJSON()); });
  try {
    await input.fill(prefix);
    await input.press('End');
    await mic.click();
    await expect(input).toHaveValue(prefix + DRAFTED, { timeout: 20_000 });
    lane.held = true;
    const create = panel.locator('.qtc-confirm-primary');
    await create.click();
    await expect(create).toHaveAttribute('data-dictation-wait', 'true');
    expect(sent).toHaveLength(0);
    await shot(page, 'task-create-waiting');
    lane.release();
    await expect.poll(() => sent.map((r) => r.title)).toEqual([prefix + FULL]);
    await expect(input).toHaveValue('');
    await expect(create).toBeDisabled();
    await shot(page, 'task-created');
  } finally {
    lane.release();
    const res = await page.request.get('/api/tasks');
    for (const t of (await res.json()).tasks as Array<{ id: string; title: string }>) if (t.title.startsWith(prefix.trim())) await page.request.delete(`/api/tasks/${t.id}?force=true`);
  }
});
