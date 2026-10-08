import { expect, test } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`;
const ID = 'ev-e2e-invited-series#1770000000';
const encoded = encodeURIComponent(ID);
function day() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
async function read() {
  const res = await fetch(`${API}/api/calendar/events?from=${day()}&to=${day()}&include_hidden=1`);
  expect(res.ok).toBe(true);
  return (await res.json()).events.find((e: { id: string }) => e.id === ID);
}
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: false })));
});

test('agent delete/update and forged human flags cannot change an invited recurring meeting', async () => {
  const before = await read();
  for (const method of ['DELETE', 'PATCH']) {
    const res = await fetch(`${API}/api/calendar/events/${encoded}`, {
      method, headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': 'test-calendar-agent' },
      ...(method === 'PATCH' ? { body: JSON.stringify({ start: `${day()}T18:00:00`, end: `${day()}T19:00:00` }) } : {}),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Hide event');
  }
  const forged = await fetch(`${API}/api/calendar/events/${encoded}?human_confirm=1`, {
    method: 'DELETE', headers: { 'x-walnut-caller-sid': 'test-calendar-agent' },
  });
  expect(forged.status).toBe(403);
  const remote = await fetch(`${API}/api/calendar/events/${encoded}?human_confirm=1`, {
    method: 'DELETE', headers: { 'x-walnut-origin': 'remote-http' },
  });
  expect(remote.status).toBe(403);
  expect((await remote.json()).error).toContain('on the Mac');
  const missingCaller = await fetch(`${API}/api/calendar/events/${encoded}?human_confirm=1`, { method: 'DELETE' });
  expect(missingCaller.status).toBe(403);
  expect((await missingCaller.json()).code).toBe('approval-canceled');
  expect(await read()).toEqual(before);
});

test('human sees series and organizer warning, cancel keeps the event, hide is local only', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sidebar-toggle-calendar').click();
  const panel = page.getByTestId('cal-side-panel');
  const chip = panel.locator(`[data-item-id="event:${ID}"]`);
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  const popover = page.getByTestId('cal-item-popover');
  await expect(popover.locator('.cal-item-warning')).toContainText('whole series');
  await expect(popover.locator('.cal-item-warning')).toContainText('Meeting organizer');
  await popover.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialogHandled = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Invited daily series');
    expect(dialog.message()).toContain('recurring series');
    expect(dialog.message()).toContain('organizer may be notified');
    await dialog.dismiss();
  });
  await popover.getByRole('button', { name: 'Really delete?' }).click();
  await dialogHandled;
  await expect(chip).toHaveCount(1);
  expect((await read()).title).toBe('Invited daily series');
  await chip.click();
  await page.getByTestId('cal-item-popover').getByRole('button', { name: 'Hide event' }).click();
  try {
    await expect(chip).toHaveCount(0);
    await expect.poll(read).toMatchObject({ title: 'Invited daily series', hidden: true, recurring: true, hasAttendees: true });
    await panel.screenshot({ path: `/tmp/calendar-controls/invite-hidden-${test.info().project.name}.png` });
  } finally {
    await fetch(`${API}/api/calendar/events/${encoded}/visibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: false }) });
  }
});

test('accepting the web warning still waits for actual source confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sidebar-toggle-calendar').click();
  const panel = page.getByTestId('cal-side-panel');
  const chip = panel.locator(`[data-item-id="event:${ID}"]`);
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  const popover = page.getByTestId('cal-item-popover');
  await popover.locator('input[type="time"]').first().fill('18:00');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Update'); await dialog.accept(); });
  await popover.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Could not update event')).toBeVisible();
  await expect(chip).toHaveCSS('top', '432px');
  expect((await read()).start).toBe(`${day()}T16:00:00`);
});
