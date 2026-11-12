import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { seedColumns } from './draft-helpers';
import { startSessionAt, fixtureRoot, panelFor, openPlusMenu } from './engine-settings-popover-helpers';

const shots = '/tmp/session-drawing';
test.describe.configure({ timeout: 180_000 });
test.use({ video: 'on' });

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sid = await startSessionAt(page.request, path.join(await fixtureRoot(), 'projects'), 'claude');
  await seedColumns(page, [sid]);
  await page.evaluate(() => { location.href = 'http://localhost:3457/'; });
  const panel = panelFor(page, sid);
  await expect(panel.locator('.chat-plus-btn')).toBeVisible({ timeout: 60_000 });
  return { panel, sid };
}

async function openDrawing(page: Page, panel: Locator) {
  const menu = await openPlusMenu(panel);
  await menu.getByRole('menuitem', { name: 'Draw', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Drawing', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function stroke(page: Page, canvas: Locator, points: Array<[number, number]>) {
  const box = (await canvas.boundingBox())!;
  const [first, ...rest] = points;
  await page.mouse.move(box.x + first[0] * box.width / 1000, box.y + first[1] * box.height / 650);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(box.x + x * box.width / 1000, box.y + y * box.height / 650, { steps: 12 });
  await page.mouse.up();
}

async function pixel(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((el, p) => {
    const data = (el as HTMLCanvasElement).getContext('2d')!.getImageData(p.x - 2, p.y - 2, 5, 5).data;
    let lowest = 255;
    for (let i = 0; i < data.length; i += 4) lowest = Math.min(lowest, data[i]);
    return [lowest, lowest, lowest, 255];
  }, { x, y });
}

async function shot(page: Page, name: string) {
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png`, scale: 'css' });
}

test('draw, erase, type, undo, reopen and send the real PNG with the session message', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const { panel, sid } = await open(page);
  await panel.locator('.chat-input-textarea').click();
  await page.keyboard.type('Explain this request flow');
  const dialog = await openDrawing(page, panel);
  const canvas = dialog.getByLabel('Drawing canvas');
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeDisabled();
  await stroke(page, canvas, [[100, 150], [350, 150], [350, 350], [100, 350], [100, 150]]);
  await stroke(page, canvas, [[350, 250], [700, 250]]);
  await stroke(page, canvas, [[670, 225], [700, 250], [670, 275]]);
  expect((await pixel(canvas, 200, 150))[0]).toBeLessThan(100);
  await shot(page, '01-pen');

  await page.keyboard.press('e');
  await expect(dialog.getByRole('button', { name: 'Eraser', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await stroke(page, canvas, [[200, 120], [200, 180]]);
  expect(await pixel(canvas, 200, 150)).toEqual([255, 255, 255, 255]);
  await shot(page, '02-eraser');
  await page.keyboard.press('Meta+z');
  expect((await pixel(canvas, 200, 150))[0]).toBeLessThan(100);

  await page.keyboard.press('t');
  await canvas.click({ position: { x: (await canvas.boundingBox())!.width * .15, y: (await canvas.boundingBox())!.height * .32 } });
  await page.keyboard.type('Client');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Request');
  await page.keyboard.press('Meta+Enter');
  expect(await canvas.evaluate(el => [...(el as HTMLCanvasElement).getContext('2d')!.getImageData(150, 208, 140, 60).data].filter((v, i) => i % 4 === 0 && v < 100).length)).toBeGreaterThan(100);
  await shot(page, '03-text');
  await dialog.getByRole('button', { name: 'Text', exact: true }).click();
  await canvas.click({ position: { x: (await canvas.boundingBox())!.width * .74, y: (await canvas.boundingBox())!.height * .32 } });
  await dialog.getByLabel('Canvas text').fill('AI\nResponse');
  // The single-letter tool keys must remain ordinary letters while typing.
  await page.keyboard.type(' pet');
  await expect(dialog.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+Enter');
  await dialog.getByRole('button', { name: 'Close drawing' }).click();
  await expect(panel.locator('.chat-input-textarea')).toHaveValue('Explain this request flow');
  await expect(panel.locator('[data-walnut-unsaved]')).toHaveAttribute('data-walnut-unsaved', 'A drawing that is not attached');
  await openDrawing(page, panel);
  expect((await pixel(canvas, 200, 150))[0]).toBeLessThan(100);
  await page.setViewportSize({ width: 980, height: 740 });
  expect((await pixel(canvas, 200, 150))[0]).toBeLessThan(100);
  await shot(page, '04-reopen-resize');

  await page.keyboard.press('Shift+Backspace');
  expect(await pixel(canvas, 200, 150)).toEqual([255, 255, 255, 255]);
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await pixel(canvas, 200, 150))[0]).toBeLessThan(100);
  await shot(page, '05-undo-clear');

  const upload = page.waitForResponse(r => r.url().endsWith('/api/images/upload') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Attach drawing', exact: true }).click();
  const response = await upload;
  expect(response.ok()).toBe(true);
  const { url } = await response.json();
  const picture = await page.request.get(url);
  expect(picture.ok()).toBe(true);
  const png = await picture.body();
  expect(png.readUInt32BE(16)).toBe(1000);
  expect(png.readUInt32BE(20)).toBe(650);
  await fs.writeFile(`${shots}/attached.png`, png);
  await expect(dialog).not.toBeVisible();
  await expect(panel.locator('.chat-input-container .chat-image-preview')).toHaveCount(1);
  await shot(page, '06-attachment');
  await panel.locator('.chat-input-textarea').press('Enter');
  await expect(panel.locator('.session-history')).toContainText('Explain this request flow', { timeout: 60_000 });
  await expect(panel.locator('.chat-input-container .chat-image-preview')).toHaveCount(0);
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${sid}/history`);
    return JSON.stringify(await res.json());
  }, { timeout: 60_000 }).toContain(path.basename(url));
  await expect(panel.locator('.session-history img').first()).toBeVisible();
  await shot(page, '07-sent');
  await openDrawing(page, panel);
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('export failure keeps the sketch and retry attaches once; text escape and stroke capture stay local', async ({ page }) => {
  const { panel } = await open(page);
  const dialog = await openDrawing(page, panel);
  const canvas = dialog.getByLabel('Drawing canvas');
  await stroke(page, canvas, [[100, 100]]);
  expect((await pixel(canvas, 100, 100))[0]).toBeLessThan(100);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 20, box.y + box.height * .5, { steps: 10 });
  await page.mouse.up();
  expect((await pixel(canvas, 900, 325))[0]).toBeLessThan(100);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await pixel(canvas, 900, 325)).toEqual([255, 255, 255, 255]);
  expect((await pixel(canvas, 100, 100))[0]).toBeLessThan(100);
  await page.keyboard.press('t');
  await canvas.click({ position: { x: 20, y: 20 } });
  await dialog.getByLabel('Canvas text').fill('First label');
  await canvas.click({ position: { x: 350, y: 120 } });
  await expect(dialog.getByLabel('Canvas text')).toBeFocused();
  await page.keyboard.type('pet');
  await expect(dialog.getByLabel('Canvas text')).toHaveValue('pet');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Canvas text')).toHaveCount(0);
  await canvas.evaluate(el => {
    const c = el as HTMLCanvasElement;
    const original = c.toBlob.bind(c);
    c.toBlob = callback => callback(null);
    (c as any).__restoreBlob = () => { c.toBlob = original; };
  });
  await dialog.getByRole('button', { name: 'Attach drawing', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be exported');
  expect((await pixel(canvas, 100, 100))[0]).toBeLessThan(100);
  await canvas.evaluate(el => (el as any).__restoreBlob());
  await shot(page, '08-export-recovery');
  await page.route('**/api/images/upload', route => route.fulfill({ status: 507, json: { error: 'Storage temporarily unavailable' } }));
  await dialog.getByRole('button', { name: 'Attach drawing', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const tile = panel.locator('.chat-input-container .chat-image-preview');
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveClass(/is-failed/);
  await expect(panel.locator('.chat-attachments-note')).toContainText('Storage temporarily unavailable');
  await shot(page, '09-upload-recovery');
  await page.unroute('**/api/images/upload');
  await tile.getByRole('button', { name: /^Retry uploading/ }).click();
  await expect(tile).not.toHaveClass(/is-failed|is-uploading/);
  await openDrawing(page, panel);
  await stroke(page, canvas, [[300, 300]]);
  await dialog.getByRole('button', { name: 'Attach drawing', exact: true }).click();
  await expect(panel.locator('.chat-input-container .chat-image-preview')).toHaveCount(2);
});
