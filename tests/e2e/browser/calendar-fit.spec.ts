import { expect, test, type Locator, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`;
const SHOTS = '/tmp/calendar-fit';
function day(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function open(page: Page) {
  await page.evaluate(url => { location.href = url; }, API);
  await page.getByTestId('sidebar-toggle-calendar').click();
  const panel = page.getByTestId('cal-side-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function scale(panel: Locator) {
  return panel.locator('.cal-grid').evaluate(el => Number.parseFloat((el as HTMLElement).style.getPropertyValue('--cal-slot-px')));
}
async function stored(id: string) {
  const res = await fetch(`${API}/api/calendar/events?from=${day()}&to=${day(1)}`);
  expect(res.ok).toBe(true);
  return (await res.json()).events.find((e: { id: string }) => e.id === id);
}
async function create(title: string, start: string, end: string) {
  const res = await fetch(`${API}/api/calendar/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId: 'cal-work', title, start, end }) });
  expect(res.ok).toBe(true);
  return (await res.json()).event.id as string;
}
async function resize(page: Page, panel: Locator, id: string, minutes: number) {
  const chip = panel.locator(`[data-item-id="event:${id}"]`);
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  if (!box) throw new Error('Missing event');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2 + minutes / 30 * await scale(panel), { steps: 8 });
  await page.mouse.up();
}

test.use({ viewport: { width: 1280, height: 960 } });
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    window.confirm = () => false;
    if (!sessionStorage.getItem('fit-seeded')) {
      localStorage.removeItem('open-walnut-calendar-grid-settings');
      sessionStorage.setItem('fit-seeded', '1');
    }
  });
});

test('default fits 7 AM through next-day 1 AM to tall and short panels, with free scrolling', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const panel = await open(page);
  for (const height of [1480, 640, 960, 1480]) {
    await page.setViewportSize({ width: 1280, height });
    await expect.poll(async () => panel.locator('.cal-grid-scroll').evaluate(el => {
      const grid = el.closest('.cal-grid') as HTMLElement;
      const slot = Number.parseFloat(grid.style.getPropertyValue('--cal-slot-px'));
      return Math.abs(slot * 36 - (el.clientHeight - 12));
    })).toBeLessThan(2);
    const scroller = panel.locator('.cal-grid-scroll');
    await expect.poll(async () => Math.abs((await scroller.evaluate(el => el.scrollTop)) - await scale(panel) * 14)).toBeLessThan(1.1);
    const edges = await panel.evaluate(el => {
      const s = el.querySelector('.cal-grid-scroll')!.getBoundingClientRect();
      const labels = [...el.querySelectorAll('.cal-grid-hourlabel')];
      const first = labels[7].getBoundingClientRect();
      const last = labels[25].getBoundingClientRect();
      return { start: first.top - s.top, end: s.bottom - last.bottom };
    });
    expect(Math.abs(edges.start)).toBeLessThan(8);
    expect(Math.abs(edges.end)).toBeLessThan(12);
  }
  await panel.screenshot({ path: `${SHOTS}/fitted-${test.info().project.name}.png`, scale: 'css' });
  const scroller = panel.locator('.cal-grid-scroll');
  await scroller.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await scroller.evaluate(el => el.scrollTop)) / await scale(panel) * 30).toBeLessThan(420);
  await page.mouse.wheel(0, 1000);
  await expect.poll(async () => (await scroller.evaluate(el => el.scrollTop)) / await scale(panel) * 30).toBeGreaterThan(420);
  await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
  await expect(panel.locator('.cal-zoom-value')).toHaveText('125%');
  await page.reload();
  await expect(panel.locator('.cal-zoom-value')).toHaveText('125%');
  await panel.getByRole('button', { name: 'Reset calendar zoom' }).click();
  const beforeClose = await scroller.evaluate(el => el.scrollTop);
  await panel.getByTitle('Close calendar panel').click();
  await page.getByTestId('sidebar-toggle-calendar').click();
  await expect.poll(async () => Math.abs((await scroller.evaluate(el => el.scrollTop)) - beforeClose)).toBeLessThan(1.1);
  expect(errors).toEqual([]);
});

test('late events, midnight resizing, and next-day creation use the displayed wall-clock day', async ({ page }) => {
  const ids: string[] = [];
  try {
    const late = await create('Late boundary block', `${day()}T23:30:00`, `${day(1)}T00:30:00`); ids.push(late);
    const next = await create('Next-day early block', `${day(1)}T00:30:00`, `${day(1)}T01:00:00`); ids.push(next);
    const panel = await open(page);
    const chip = panel.locator(`[data-item-id="event:${late}"]`);
    await expect(chip).toHaveCount(1);
    await expect(panel.locator(`[data-item-id="event:${next}"]`)).toHaveCount(1);
    await expect.poll(async () => parseFloat(await chip.evaluate(el => (el as HTMLElement).style.height)) / await scale(panel)).toBeCloseTo(2, 1);
    await resize(page, panel, late, 30);
    await expect.poll(() => stored(late)).toMatchObject({ start: `${day()}T23:30:00`, end: `${day(1)}T01:00:00` });
    await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
    await panel.locator('.cal-grid-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const col = await panel.locator('.cal-day-col').boundingBox();
    if (!col) throw new Error('Missing day column');
    await page.mouse.click(col.x + col.width - 8, col.y + 26 * 2 * await scale(panel) + 1);
    const popover = page.locator('.cal-create-popover');
    await expect(popover).toBeVisible();
    await popover.getByRole('tab', { name: 'Event', exact: true }).click();
    await expect(popover.locator('input[type="time"]').first()).toHaveValue('02:00');
    await expect(popover.locator('.cal-event-form-when')).toContainText(day(1));
    await page.keyboard.press('Escape');
  } finally { for (const id of ids) await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
});

test('cross-midnight task blocks remain editable with an explicit end date', async ({ page }) => {
  const response = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Late task block', start_date: `${day()}T23:30:00`, end_date: `${day(1)}T00:30:00` }) });
  expect(response.ok).toBe(true);
  const { task } = await response.json();
  try {
    const panel = await open(page);
    const chip = panel.locator(`[data-item-id="task-start:${task.id}"]`);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    const popover = page.getByTestId('cal-item-popover');
    await expect(popover.getByLabel('End date')).toHaveValue(day(1));
    await expect(popover.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await popover.getByLabel('End time (optional)').fill('00:45');
    await popover.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const r = await fetch(`${API}/api/tasks/${task.id}`);
      return (await r.json()).task.end_date;
    }).toBe(`${day(1)}T00:45:00`);
  } finally { await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }); }
});

test('short events resize by pointer delta rather than their minimum display height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  const id = await create('Short block', `${day()}T09:00:00`, `${day()}T09:15:00`);
  try {
    const panel = await open(page);
    await resize(page, panel, id, 15);
    await expect.poll(() => stored(id)).toMatchObject({ start: `${day()}T09:00:00`, end: `${day()}T09:30:00` });
    await resize(page, panel, id, 15);
    await expect.poll(() => stored(id)).toMatchObject({ end: `${day()}T09:45:00` });
  } finally { await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
});

test('resize confirmation works when native confirm cancels, with cancel, rejection, and retry', async ({ page }) => {
  const id = await create('Legacy source drag block', `${day()}T17:30:00`, `${day()}T18:00:00`);
  let writes = 0;
  let reject = true;
  await page.route('**/api/calendar/events?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const event of body.events) if (event.id === id) delete event.writeSafetyVersion;
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/calendar/events/${encodeURIComponent(id)}`, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    writes++;
    if (reject) { await route.fulfill({ status: 500, json: { error: 'Controlled save failure' } }); return; }
    const patch = route.request().postDataJSON();
    delete patch.human_confirm;
    const response = await route.fetch({ postData: JSON.stringify(patch) });
    await route.fulfill({ response });
  });
  try {
    const panel = await open(page);
    await resize(page, panel, id, 15);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Legacy source drag block');
    await expect(dialog).toContainText('organizer may be notified');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toBe(0);
    expect((await stored(id)).end).toBe(`${day()}T18:00:00`);
    await resize(page, panel, id, 15);
    await expect(dialog).toHaveCSS('opacity', '1');
    await dialog.locator('.app-modal').screenshot({ path: `${SHOTS}/drag-confirm-${test.info().project.name}.png`, scale: 'css' });
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Could not update event')).toBeVisible();
    expect((await stored(id)).end).toBe(`${day()}T18:00:00`);
    reject = false;
    await resize(page, panel, id, 15);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => stored(id)).toMatchObject({ end: `${day()}T18:15:00` });
    await page.reload();
    await expect(panel.locator(`[data-item-id="event:${id}"]`)).toHaveCount(1);
    expect(writes).toBe(2);
    await resize(page, panel, id, 15);
    await expect(dialog).toBeVisible();
    const changed = await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: `${day()}T18:30:00`, end: `${day()}T19:00:00` }) });
    expect(changed.ok).toBe(true);
    await expect.poll(async () => {
      const chip = panel.locator(`[data-item-id="event:${id}"]`);
      return Math.abs(await chip.evaluate(el => parseFloat((el as HTMLElement).style.top)) - await scale(panel) * 37);
    }).toBeLessThan(0.1);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toContainText('Event changed');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    expect(writes).toBe(2);
    expect((await stored(id)).start).toBe(`${day()}T18:30:00`);
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
});
