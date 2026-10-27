import { expect, test, type Page, type Locator } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bunRuntime } from '../../helpers/bun-runtime.js';

async function cli(name: string, args: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-cli-'));
  const socket = path.join(dir, 'gateway.sock');
  const server = net.createServer((connection) => {
    let line = '';
    connection.on('data', async (data) => {
      line += data.toString();
      if (!line.includes('\n')) return;
      const request = JSON.parse(line);
      const response = await fetch(`${API}/api/plugin-runtime/calendar/ops/${request.args.name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.args.args),
      }).then((r) => r.json());
      connection.end(JSON.stringify(response.ok ? { ok: true, result: response.result } : {
        ok: false, error: { code: 'hub_error', message: response.message },
      }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const { stdout } = await promisify(execFile)(bunRuntime(), ['dist/cli.js', 'tools', 'call', name, JSON.stringify(args)], {
      env: { ...process.env, OPEN_WALNUT_API_URL: API, WALNUT_SESSION_ID: 'external', WALNUT_AGENT_SOCKET: socket }, timeout: 15000,
    });
    return JSON.parse(stdout);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`;
function localDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function event(title: string, start: string, end: string, dayOffset = 0) {
  const response = await fetch(`${API}/api/calendar/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId: 'cal-work', title, start: `${localDay(dayOffset)}T${start}:00`,
      end: `${localDay(dayOffset + (end < start ? 1 : 0))}T${end}:00` }) });
  expect(response.ok).toBe(true);
  return (await response.json()).event as { id: string };
}
async function gridGeometry(panel: Locator) {
  return panel.locator('.cal-grid').evaluate((el) => {
    const grid = el as HTMLElement;
    const scroller = grid.querySelector<HTMLElement>('.cal-grid-scroll')!;
    const slotPx = parseFloat(grid.style.getPropertyValue('--cal-slot-px'));
    const startMinute = Number(grid.dataset.startMinute);
    return { slotPx, startMinute, endMinute: Number(grid.dataset.endMinute),
      viewportHeight: scroller.clientHeight, topMinute: startMinute + scroller.scrollTop / slotPx * 30,
      maxTopMinute: startMinute + (scroller.scrollHeight - scroller.clientHeight) / slotPx * 30,
      columnHeight: grid.querySelector<HTMLElement>('.cal-grid-cols')!.getBoundingClientRect().height };
  });
}
async function expectFittedGrid(panel: Locator, zoom: number) {
  await expect.poll(async () => {
    const g = await gridGeometry(panel);
    return Math.abs(g.slotPx - (g.viewportHeight - 12) / 36 * zoom);
  }).toBeLessThan(0.02);
  const g = await gridGeometry(panel);
  expect(g.startMinute).toBe(0);
  expect(g.endMinute).toBe(31 * 60);
  expect(g.columnHeight).toBeCloseTo((g.endMinute - g.startMinute) / 30 * g.slotPx, 1);
}
async function expectChipTime(panel: Locator, chip: Locator, startMinute: number, endMinute: number) {
  // Read this surface's current scale, including a hidden home panel's retained scale.
  await expect.poll(async () => {
    const g = await gridGeometry(panel);
    const actual = await chip.evaluate((el) => ({
      top: parseFloat((el as HTMLElement).style.top), height: parseFloat((el as HTMLElement).style.height),
    }));
    const start = Math.max(g.startMinute, startMinute);
    const end = Math.min(g.endMinute, endMinute);
    return Math.max(Math.abs(actual.top - (start - g.startMinute) / 30 * g.slotPx),
      Math.abs(actual.height - Math.min((g.endMinute - start) / 30 * g.slotPx, Math.max(20, (end - start) / 30 * g.slotPx))));
  }).toBeLessThan(0.02);
}
async function expectTopMinute(panel: Locator, minute: number) {
  await expect.poll(async () => {
    const g = await gridGeometry(panel);
    // Scroll offsets may round to a device pixel, unlike the fractional CSS slot.
    return Math.abs(g.topMinute - Math.min(minute, g.maxTopMinute)) * g.slotPx / 30;
  }).toBeLessThanOrEqual(1);
}
async function scrollToMinute(panel: Locator, minute: number) {
  const g = await gridGeometry(panel);
  const top = (minute - g.startMinute) / 30 * g.slotPx;
  await panel.locator('.cal-grid-scroll').evaluate((el, top) => { el.scrollTop = top; }, top);
  await expectTopMinute(panel, minute);
}
async function openAgenda(page: Page) {
  await page.evaluate((url) => { location.href = url; }, API);
  await page.getByTestId('sidebar-toggle-calendar').click();
  const panel = page.getByTestId('cal-side-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function point(panel: Locator, hour: number) {
  const y = await panel.locator('.cal-grid').evaluate((el, hour) => {
    const start = Number((el as HTMLElement).dataset.startMinute);
    const slot = parseFloat((el as HTMLElement).style.getPropertyValue('--cal-slot-px'));
    return (hour * 60 - start) / 30 * slot;
  }, hour);
  await panel.locator('.cal-grid-scroll').evaluate((el, y) => { el.scrollTop = y - el.clientHeight / 2; }, y);
  const box = await panel.locator('.cal-day-col').first().boundingBox();
  if (!box) throw new Error('Calendar column is missing');
  return { x: box.x + box.width / 2, y: box.y + y + 1 };
}

test.use({ viewport: { width: 1280, height: 960 } });
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('calendar-grid-seeded')) {
      localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: false }));
      sessionStorage.setItem('calendar-grid-seeded', '1');
    }
  });
});

test('default hours, zoom bounds, persistence, and both surfaces share the settings', async ({ page }) => {
  const panel = await openAgenda(page);
  await expectFittedGrid(panel, 1);
  await expect(panel.locator('.cal-grid-hourlabel').first()).toHaveText('12 AM');
  await expect(panel.locator('.cal-grid-range-end')).toHaveText('7 AM');
  await expect(panel.locator('.cal-hours-toggle')).toHaveText('7–1');
  await expectTopMinute(panel, 7 * 60);
  await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
  await expect(panel.getByRole('button', { name: 'Reset calendar zoom' })).toHaveText('125%');
  await expectFittedGrid(panel, 1.25);
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
  await expect(panel.getByRole('button', { name: 'Zoom in calendar' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Reset calendar zoom' }).click();
  for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out calendar' }).click();
  await expect(panel.getByRole('button', { name: 'Zoom out calendar' })).toBeDisabled();
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Reset calendar zoom' })).toHaveText('50%');
  await expectFittedGrid(panel, 0.5);
  await page.click('a[href="/calendar"]');
  const full = page.locator('.cal-page');
  await expect(full.getByRole('button', { name: 'Reset calendar zoom' })).toHaveText('50%');
  await expectFittedGrid(full, 0.5);
  await full.getByRole('button', { name: 'Reset calendar zoom' }).click();
  expect(await panel.locator('.cal-zoom-value').textContent()).toBe('100%');
  await expectFittedGrid(full, 1);
  await full.getByRole('button', { name: 'Show full day', exact: true }).click();
  await expect(full.locator('.cal-grid')).toHaveAttribute('data-start-minute', '0');
  await expect(full.locator('.cal-grid')).toHaveAttribute('data-end-minute', String(24 * 60));
  await expect.poll(async () => (await gridGeometry(full)).slotPx).toBe(24);
  await expectTopMinute(full, 8 * 60);
  await page.reload();
  await expect(full.getByRole('button', { name: 'Show 7 AM to 1 AM' })).toHaveAttribute('aria-pressed', 'true');
  await expect(full.locator('.cal-grid-range-end')).toHaveText('12 AM');
  await full.getByRole('button', { name: 'Show 7 AM to 1 AM' }).click();
  await expectFittedGrid(full, 1);
  await full.getByRole('tab', { name: 'Week', exact: true }).click();
  await full.getByRole('tab', { name: 'Day', exact: true }).click();
  await expectTopMinute(full, 7 * 60);
  await page.setViewportSize({ width: 1280, height: 640 });
  await expectFittedGrid(full, 1);
  await scrollToMinute(full, 9 * 60);
  const before = await gridGeometry(full);
  await full.getByRole('button', { name: 'Zoom in calendar' }).click();
  await expectFittedGrid(full, 1.25);
  await expectTopMinute(full, before.topMinute);
});

test('zooming out from a late hour preserves the pre-layout minute up to the scroll limit', async ({ page }) => {
  await openAgenda(page);
  await page.click('a[href="/calendar"]');
  const full = page.locator('.cal-page');
  await full.getByRole('tab', { name: 'Day', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 640 });
  for (let i = 0; i < 3; i++) await full.getByRole('button', { name: 'Zoom in calendar' }).click();
  await expectFittedGrid(full, 2);
  await scrollToMinute(full, 22 * 60);
  const before = await gridGeometry(full);
  await full.getByRole('button', { name: 'Reset calendar zoom' }).click();
  await expectFittedGrid(full, 1);
  await expectTopMinute(full, before.topMinute);
});

test('a horizontal move keeps the real start of an early event', async ({ page }) => {
  const one = await event(`Early move ${Date.now()}`, '06:30', '07:30');
  try {
    await openAgenda(page);
    await page.click('a[href="/calendar"]');
    const full = page.locator('.cal-page');
    await full.getByRole('tab', { name: 'Week', exact: true }).click();
    // The extended tail can also draw this event in the previous day's column.
    const chip = full.locator(`.cal-day-col[data-day="${localDay()}"] [data-item-id="event:${one.id}"]`);
    await chip.scrollIntoViewIfNeeded();
    await expectChipTime(full, chip, 6 * 60 + 30, 7 * 60 + 30);
    const src = await chip.boundingBox();
    const index = await chip.evaluate((el) => {
      const day = el.closest('.cal-day-col')!;
      return [...day.parentElement!.querySelectorAll('.cal-day-col')].indexOf(day);
    });
    const targetIndex = index === 6 ? 5 : index + 1;
    const target = full.locator('.cal-day-col').nth(targetIndex);
    const targetDay = await target.getAttribute('data-day');
    const dst = await target.boundingBox();
    if (!src || !dst) throw new Error('Day geometry is missing');
    await page.mouse.move(src.x + src.width / 2, src.y + 8);
    await page.mouse.down();
    await page.mouse.move(dst.x + dst.width / 2, src.y + 8, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => {
      const result = await fetch(`${API}/api/calendar/events?from=${targetDay}&to=${targetDay}`).then((r) => r.json());
      return result.events.find((e: { id: string }) => e.id === one.id)?.start;
    }).toBe(`${targetDay}T06:30:00`);
  } finally { await fetch(`${API}/api/calendar/events/${encodeURIComponent(one.id)}`, { method: 'DELETE' }); }
});

test('resizing to midnight saves the next local day at zero', async ({ page }) => {
  const one = await event(`Midnight resize ${Date.now()}`, '23:00', '23:30');
  try {
    const panel = await openAgenda(page);
    // Keep midnight comfortably inside the viewport throughout the gesture.
    await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
    await expectFittedGrid(panel, 1.25);
    const chip = panel.locator(`[data-item-id="event:${one.id}"]`);
    await point(panel, 23);
    const src = await chip.boundingBox();
    if (!src) throw new Error('Event is missing');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height - 3);
    await page.mouse.down();
    const { slotPx } = await gridGeometry(panel);
    await page.mouse.move(src.x + src.width / 2, src.y + src.height - 3 + slotPx, { steps: 8 });
    await page.mouse.up();
    const nextDay = localDay(1);
    await expect.poll(async () => {
      const result = await fetch(`${API}/api/calendar/events?from=${localDay()}&to=${localDay(1)}`).then((r) => r.json());
      return result.events.find((e: { id: string }) => e.id === one.id)?.end;
    }).toBe(`${nextDay}T00:00:00`);
  } finally { await fetch(`${API}/api/calendar/events/${encodeURIComponent(one.id)}`, { method: 'DELETE' }); }
});

test('read-only and all-day events can be hidden without deleting them', async ({ page }) => {
  const panel = await openAgenda(page);
  const chip = panel.locator('[data-item-id="event:ev-e2e-holiday"]');
  try {
    await chip.click();
    const popover = page.getByTestId('cal-item-popover');
    await expect(popover.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await popover.getByRole('button', { name: 'Hide event', exact: true }).click();
    await expect(chip).toHaveCount(0);
    await expect.poll(async () => {
      const stored = await fetch(`${API}/api/calendar/events?from=${localDay()}&to=${localDay(1)}&include_hidden=1`).then((r) => r.json());
      return stored.events.find((e: { id: string }) => e.id === 'ev-e2e-holiday');
    }).toMatchObject({ readonly: true, allDay: true, hidden: true });
  } finally {
    await fetch(`${API}/api/calendar/events/ev-e2e-holiday/visibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: false }) });
  }
});

test('hide one overlapping event, restore it, and recover after a rejected write', async ({ page }) => {
  const unique = `Calendar controls ${Date.now()}`;
  const one = await event(`${unique} hidden`, '11:00', '12:00');
  const two = await event(`${unique} sibling`, '11:00', '12:00');
  try {
    const panel = await openAgenda(page);
    const chip = panel.locator(`[data-item-id="event:${one.id}"]`);
    await chip.scrollIntoViewIfNeeded();
    await chip.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide event', exact: true }).click();
    await expect(chip).toHaveCount(0);
    await expect(panel.locator(`[data-item-id="event:${two.id}"]`)).toHaveCount(1);
    await page.reload();
    await expect(chip).toHaveCount(0);
    const stored = await fetch(`${API}/api/calendar/events?from=${localDay()}&to=${localDay(1)}&include_hidden=1`).then((r) => r.json());
    expect(stored.events.find((e: { id: string }) => e.id === one.id)?.hidden).toBe(true);
    await panel.getByTestId('cal-side-cals-btn').click();
    await page.getByRole('button', { name: /Hidden events/ }).click();
    await page.locator('.cal-hidden-events-row').filter({ hasText: `${unique} hidden` }).getByRole('button', { name: 'Show' }).click();
    await expect(chip).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.route('**/api/calendar/events/*/visibility', (route) => route.fulfill({ status: 500, json: { error: 'Controlled failure' } }));
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await page.getByTestId('cal-item-popover').getByRole('button', { name: 'Hide event', exact: true }).click();
    await expect(chip).toHaveCount(1);
    await expect(page.getByText('Could not hide event')).toBeVisible();
    await page.unroute('**/api/calendar/events/*/visibility');
    await chip.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide event', exact: true }).click();
    await expect(chip).toHaveCount(0);
  } finally {
    for (const id of [one.id, two.id]) await fetch(`${API}/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
});

test('free scrolling keeps early, late, and next-day events reachable and clips only the grid tail', async ({ page }) => {
  const early = await event(`Off-hours ${Date.now()}`, '05:00', '06:00');
  const start = await event(`Crossing focus start ${Date.now()}`, '06:30', '07:30');
  const end = await event(`Late evening ${Date.now()}`, '22:30', '23:30');
  const overnight = await event(`After midnight ${Date.now()}`, '00:30', '01:30', 1);
  const tail = await event(`Crossing grid tail ${Date.now()}`, '06:30', '07:30', 1);
  try {
    const panel = await openAgenda(page);
    await expectFittedGrid(panel, 1);
    for (const [e, from, to] of [
      [early, 5 * 60, 6 * 60], [start, 6 * 60 + 30, 7 * 60 + 30],
      [end, 22 * 60 + 30, 23 * 60 + 30], [overnight, 24 * 60 + 30, 25 * 60 + 30],
      [tail, 30 * 60 + 30, 31 * 60 + 30],
    ] as const) {
      const chip = panel.locator(`[data-item-id="event:${e.id}"]`);
      await expect(chip).toHaveCount(1);
      await expectChipTime(panel, chip, from, to);
      await chip.scrollIntoViewIfNeeded();
      await expect(chip).toBeInViewport();
    }
    await panel.getByRole('button', { name: 'Show full day', exact: true }).click();
    await expect(panel.locator(`[data-item-id="event:${overnight.id}"]`)).toHaveCount(0);
    await expect(panel.locator(`[data-item-id="event:${tail.id}"]`)).toHaveCount(0);
    await expectChipTime(panel, panel.locator(`[data-item-id="event:${early.id}"]`), 5 * 60, 6 * 60);
    await panel.getByRole('button', { name: 'Show 7 AM to 1 AM' }).click();
    await expectFittedGrid(panel, 1);
    await expect(panel.locator(`[data-item-id="event:${early.id}"]`)).toHaveCount(1);
    await expectChipTime(panel, panel.locator(`[data-item-id="event:${overnight.id}"]`), 24 * 60 + 30, 25 * 60 + 30);
  } finally {
    for (const e of [early, start, end, overnight, tail]) await fetch(`${API}/api/calendar/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
  }
});

test('dense overlapping events stay usable in a narrow agenda at every scale', async ({ page }) => {
  const events = [];
  for (let i = 0; i < 8; i++) events.push(await event(`Density ${i} long event title ${Date.now()}`, '11:00', '12:00'));
  try {
    const panel = await openAgenda(page);
    await panel.locator('[data-item-id="event:' + events[0].id + '"]').scrollIntoViewIfNeeded();
    for (const zoom of ['50%', '100%', '200%']) {
      await panel.getByRole('button', { name: 'Reset calendar zoom' }).click();
      if (zoom === '50%') for (let i = 0; i < 2; i++) await panel.getByRole('button', { name: 'Zoom out calendar' }).click();
      if (zoom === '200%') for (let i = 0; i < 3; i++) await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
      await panel.locator(`[data-item-id="event:${events[0].id}"]`).scrollIntoViewIfNeeded();
      await expect(panel.locator('.cal-zoom-value')).toHaveText(zoom);
      for (const e of events) await expect(panel.locator(`[data-item-id="event:${e.id}"]`)).toHaveCount(1);
      expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await panel.screenshot({ path: `/tmp/calendar-controls/dense-${test.info().project.name}.png`, scale: 'css' });
    await panel.locator(`[data-item-id="event:${events[2].id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide event', exact: true }).click();
    await expect(panel.locator(`[data-item-id="event:${events[2].id}"]`)).toHaveCount(0);
    await expect(panel.locator(`[data-item-id="event:${events[3].id}"]`)).toHaveCount(1);
  } finally {
    for (const e of events) await fetch(`${API}/api/calendar/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
  }
});

test('zoomed creation, moving, and resizing preserve wall-clock times', async ({ page }) => {
  const one = await event(`Zoomed move ${Date.now()}`, '09:00', '10:00');
  try {
    const panel = await openAgenda(page);
    await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
    await panel.getByRole('button', { name: 'Zoom in calendar' }).click();
    const chip = panel.locator(`[data-item-id="event:${one.id}"]`);
    await chip.scrollIntoViewIfNeeded();
    const box = await chip.boundingBox();
    if (!box) throw new Error('Event is missing');
    await page.mouse.move(box.x + box.width / 2, box.y + 4);
    await page.mouse.down();
    const { slotPx } = await gridGeometry(panel);
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + 60 / 30 * slotPx, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => {
      const result = await fetch(`${API}/api/calendar/events?from=${localDay()}&to=${localDay(1)}`).then((r) => r.json());
      return result.events.find((e: { id: string }) => e.id === one.id)?.start;
    }).toBe(`${localDay()}T10:00:00`);
    const moved = await chip.boundingBox();
    if (!moved) throw new Error('Moved event is missing');
    await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height - 3);
    await page.mouse.down();
    const resizeGeometry = await gridGeometry(panel);
    await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height - 3 + 60 / 30 * resizeGeometry.slotPx, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => {
      const result = await fetch(`${API}/api/calendar/events?from=${localDay()}&to=${localDay(1)}`).then((r) => r.json());
      return result.events.find((e: { id: string }) => e.id === one.id)?.end;
    }).toBe(`${localDay()}T12:00:00`);
    const p = await point(panel, 14);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.cal-create-popover')).toBeVisible();
    await page.locator('.cal-create-popover').getByRole('tab', { name: 'Event', exact: true }).click();
    await expect(page.locator('.cal-create-popover').locator('input[type="time"]').first()).toHaveValue('14:00');
    await page.keyboard.press('Escape');
  } finally { await fetch(`${API}/api/calendar/events/${encodeURIComponent(one.id)}`, { method: 'DELETE' }); }
});

test('agent task scheduling updates the current agenda without changing dates', async ({ page }) => {
  const panel = await openAgenda(page);
  const response = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Agent task block ${Date.now()}`, project: 'Calendar test' }) });
  expect(response.ok).toBe(true);
  const { task } = await response.json();
  try {
    const update = await fetch(`${API}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: `${localDay()}T13:00:00`, end_date: `${localDay()}T14:00:00` }) });
    expect(update.ok).toBe(true);
    const chip = panel.locator(`[data-item-id="task-start:${task.id}"]`);
    await expect(chip).toContainText(task.title);
    await expectChipTime(panel, chip, 13 * 60, 14 * 60);
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: `${localDay()}T14:00:00`, end_date: `${localDay()}T15:00:00` }) });
    await expectChipTime(panel, chip, 14 * 60, 15 * 60);
  } finally { await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }); }
});

test('agent-created events update the current agenda without changing dates', async ({ page }) => {
  const panel = await openAgenda(page);
  await expect(panel.locator('.cal-grid')).toBeVisible();
  await expect.poll(() => panel.locator('.cal-chip').count()).toBeGreaterThan(0);
  const title = `Agent live calendar ${Date.now()}`;
  const result = await cli('calendar_event_create', { calendar_id: 'cal-work', title,
    start: `${localDay()}T15:00:00`, end: `${localDay()}T15:30:00` });
  const created = JSON.parse(result.slice('Event created: '.length)) as { id: string };
  try {
    await expect(panel.locator(`[data-item-id="event:${created.id}"]`)).toContainText(title, { timeout: 5000 });
    for (const hidden of [true, false]) {
      expect(await cli('calendar_event_visibility', { id: created.id, hidden })).toContain('not changed');
      await expect(panel.locator(`[data-item-id="event:${created.id}"]`)).toHaveCount(hidden ? 0 : 1);
    }
  } finally { await fetch(`${API}/api/calendar/events/${encodeURIComponent(created.id)}`, { method: 'DELETE' }); }
});
